'use strict';

const net            = require('net');
const dns            = require('dns');
const debug          = require('debug')('denonavr');
const amxdd          = require('amxdd');
const isLocalAddress = require('./localaddress');
const _              = require('lodash');

const port                   = 23;
const COMMAND_TIMEOUT        = 300;    // コマンドタイムアウト(ms)
const RETRY_COUNT            = 3;      // コマンドリトライカウント
const RETRY_INTERVAL         = 200;    // コマンドリトライ間隔(ms)
const RECONNECT_INTERVAL     = 200;    // 初期再接続間隔(ms)
const MAX_RECONNECT_INTERVAL = 6400;   // 最大再接続間隔(ms)

// ディスパッチャー
// キューから次のコマンドを取り出して実行
function dispatcher(f) {
    if (_.isNull(f.run)) {
        if (_.size(f.que)) {
            // 次のコマンドをキューから取得
            f.run = f.que.shift();
            f.retry = RETRY_COUNT;
        } else {
            // キューが空
            f.run = null;
        }
    }

    if (f.run) {
        // コマンド送信
        if (!prepare(f, dispatcher, timeout)) {
            return;
        }
        if (f.socket) {
            f.socket.write(f.run.cmd + '\r');
            debug(`denonavr: send:   ${f.run.cmd}`);
        }
        f.timer = setTimeout(timeout, COMMAND_TIMEOUT, f);
    }
}

// タイムアウト処理
function timeout(f, e) {
    f.timer = null;
    // 一旦切断する
    if (_.hasIn(f, 'socket.destroy') && _.isFunction(f.socket.destroy)) {
        f.socket.destroy();
    }
    if (--f.retry > 0) {
        // リトライ
        debug(`denonavr: retry: ${f.run.cmd}`);
        setTimeout(dispatcher, RETRY_INTERVAL, f);
        return;
    }
    // リトライオーバー
    if (_.isFunction(f.run.reject)) {
        if (!_.isError(e)) {
            e = new Error(`denonavr: timeout: ${f.run.cmd}`);
        }
        f.run.reject(e);
    }
    setTimeout(nextCommand, RETRY_INTERVAL, f);
}

// 次のコマンド
function nextCommand(f) {
    f.run = null;
    dispatcher(f);
}

// コマンドをキューに積む
function pushExec(f, cmd, cdef = null, resolve = null, reject = null) {
    if (_.isNull(cdef)) {
        // xx? という最後に?が付くコマンドは値取得用とみなして
        // /xx(.+)/ として値をmatch()で切り取れるようにする
        cdef = {regs: new RegExp(('^' + cmd).replace(/\?$/, '(.+)'))};
    }
    f.que.push({cmd, cdef, resolve, reject});
    if (_.isNull(f.run)) {
        // ディスパッチャー停止時に起動する
        dispatcher(f);
    }
}

// Setアクセサ
function set(f, it, v) {
    return new Promise((resolve, reject) => {
        // Denonアンプの仕様で、現在の設定値と同値を設定使用しても応答が返ってこないので、コマンド送信せずに即座に返る
        const current = _.get(f.state, it.name);
        if (current == v) {
            resolve(current);
        } else {
            pushExec(f, it.cmd + _.get(it, ['pdict', v], v), it, resolve, reject);
        }
    });
}

// Getアクセサ
function get(f, it) {
    return new Promise((resolve, reject) => {
        pushExec(f, it.cmd + '?', it, resolve, reject);
    });
}

// イベント文字列判定
function checkEventString(line, cdef) {
    const arg = line.match(cdef.regs);
    if (!_.isNull(arg)) {
        if (_.size(arg) === 1) {
            // 完全一致、おそらく設定コマンドの応答
            return arg[0];
        }
        if (_.size(arg) > 1) {
            // 応答パラメータを切り出した場合、辞書があれば変換、なければそのまま
            for (const it in _.get(cdef, 'pdict', {})) {
                if (arg[1] === _.get(cdef, ['pdict', it])) {
                    return it;
                }
            }
            return arg[1];
        }
    }
    return null;
}

// アクセサ登録
function registerAccessor(f, cmd) {
    const tbl = _.isArray(cmd) ? cmd : [cmd];
    tbl.forEach(it => {
        if (_.isArray(it.alias) && _.isObject(it.pdict)) {
            // aliasに配列定義している場合はdictオブジェクトの各プロパティをセットするアクセサを登録する
            // { alias:['on', 'off], dict:{ON:'ON', OFF:'STANDBY'} }
            // on()  { set(name, 'ON'); }
            // off() { set(name, 'STANDBY'); }
            // のような感じ
            _.zip(it.alias, _.keys(it.pdict)).forEach(pair => {
                f[pair[0]] = async function() { return await set(f, it, pair[1]); }
            });
        }
        // aliasに文字列定義している場合はset{Alias}, get{Alias}
        // それ以外はset{Name}, get{Name}のアクセサを登録する
        const name = _.upperFirst(_.isString(it.alias) ? it.alias : it.name);
        f['set' + name] = async function(v) { return await set(f, it, v); };
        f['get' + name] = async function()  { return await get(f, it); };
    });
    f.cmds = [...f.cmds, ...tbl];
}

// 登録取得コマンド発行
function delayCollection(f)
{
    f.cmds.forEach(it => {
        if (!_.has(f.state, it.name)) {
            pushExec(f, it.cmd + '?');
        }
    });
}

// 接続維持
function connectionKeeper(f, next, err) {
    f.rceonnectTimer = null;

    // AVレシーバに接続
    f.socket = new net.Socket();
    f.socket.connect(port, f.address, () => {
        debug(`denonavr: connected`);
        f.reconnectInterval = RECONNECT_INTERVAL;
        if (_.isFunction(next)) {
            next(f);
            next = null;
            err  = null;
        }
        setTimeout(delayCollection, 1000, f);
    });

    // AVレシーバからの受信を解析
    f.socket.on('data', (data) => {
        data.toString().split('\r').filter(it => it !== '').forEach(it =>{
            debug(`denonavr: recv:   ${it}`);
            // コマンド応答確認
            if (_.isObject(f.run) && f.timer) {
                const resp = checkEventString(it, f.run.cdef);
                if (!_.isNull(resp)) {
                    // コマンド受領確認＆次のコマンド
                    clearTimeout(f.timer);
                    f.timer = null;
                    debug(`denonavr: recv:   response (${f.run.cmd},${it})`);
                    if (_.isFunction(f.run.resolve)) {
                        f.run.resolve(resp);
                    }
                    nextCommand(f);
                }
            }
            // 文字列解析
            let update = false;
            f.cmds.forEach(cdef => {
                const arg = checkEventString(it, cdef);
                if (!_.isNull(arg)) {
                    f.state[cdef.name] = arg;
                    update = true;
                }
            });
            if (!update) {
                // 知らないイベントはunknownプロパティでコールバック
                f.state.unknown = it;
            }
            // コールバック
            f.callback(f.state);
            debug(`denonavr: update: ${JSON.stringify(f.state)}`);
            delete f.state.unknown;
        });
    });

    // 接続でエラー発生
    f.socket.on('error', () => {
        if (err) {
            err(f, new Error(`denonavr: connection error (address=${f.address})`));
            next = null;
            err  = null;
        }
    });

    // 接続が閉じた（接続できなかったとき）
    f.socket.on('close', () => {
        debug(`denonavr: closed`);
        if (_.isFunction(err)) {
            err(f, new Error(`denonavr: connection closed`));
            next = null;
            err  = null;
        }
        f.state = {};
        if (_.isNull(f.rceonnectTimer)) {
            f.rceonnectTimer = setTimeout(connectionKeeper, f.reconnectInterval, f);
            f.reconnectInterval = Math.min(f.reconnectInterval * 2, MAX_RECONNECT_INTERVAL);
        }
    });
}

// 接続確認
function prepare(f, next, err) {
    if (!f.keeper) {
        // まだデバイスが見つかっていない
        err(f, new Error(`denonavr: model ${f.model} hostname ${f.hostname} not found`));
        return false;
    }
    if (_.isNull(f.rceonnectTimer)) {
        // 接続中
        return true;
    }
    // 接続試行
    clearTimeout(f.rceonnectTimer);
    connectionKeeper(f, next, err);
    return false;
}

// デバイス発見
function foundDevice(f, address) {
    if (f.address !== address && isLocalAddress(address)) {
        debug(`denonavr: Found ${f.model} on ${address}`);
        f.address = address;
        if (!f.keeper) {
            f.keeper = true;
            connectionKeeper(f);
        } else {
            f.socket.destroy();
        }
    }
}

// デフォルトコマンドテーブル
// name:  プロパティ名。
// alias: アクセサ名に使用される。なければnameが使われる。
// cmd:   コマンド文字列。Setアクセサではcmd + コマンドパラメータ、Getアクセサではcmd + '?'を送信する。
// regs:  受信イベント文字列をmatchで判定するためのRegExpオブジェクト。
// pdict: 設定値とコマンドパラメータの変換表。プロパティ名が設定値、プロパティ値がコマンドパラメータ。
const defaultCommands = [
    {   // setPowerState (on/off) / getPowerState
        name:  'powerState',
        alias: ['on', 'off'],
        cmd:   'PW',
        regs:  /^PW(ON|STANDBY)/,
        pdict: {
            ON: 'ON',
            OFF:'STANDBY'
        },
    },
    {   // setVolume / getVolume
        name:  'volume',
        cmd:   'MV',
        regs:  /^MV([0-9]+)/
    },
    {   // getMute(d) / getMute(d)
        name:  'muted',
        alias: 'Mute',
        cmd:   'MU',
        regs:  /^MU(ON|OFF)/,
        pdict: {
            true: 'ON',
            false:'OFF'
        },
    },
    {   // setInput / getInput
        name:  'input',
        cmd:   'SI',
        regs:  /^SI([A-Z0-9.¥/]+)/
    },
    {   // setDynamicVolume / getDynamicVolume
        name:  'dynamicVolume',
        cmd:   'PSDYNVOL ',
        regs:  /^PSDYNVOL ([A-Z]+)/
    }
];

// 公開部
var denonavr = function() {
    this.callback = function() {};
    this.socket   = null;
    this.keeper   = false;
    this.que      = [];
    this.run      = null;
    this.state    = {};
    this.reconnectInterval = RECONNECT_INTERVAL;
    this.cmds     = [];
};

// 初期化
denonavr.prototype.init = function(callback, model, hostname, commands) {
    this.callback = callback;
    this.model    = model;
    this.hostname = hostname;

    this.registerCommand(commands || defaultCommands);

    if (hostname) {
        // mDNSで検索
        dns.lookup(hostname, (err, address) => {
            if (err) {
                console.error(`denonavr: hostname '${hostname}' not found`);
                return;
            }
            foundDevice(this, address);
        })
    }
    // AMXBで検索
    const amxtimer = setTimeout(() => console.error(`denonavr: model '${model}' not found`), 100000);
    amxdd(info => {
        if (this.model && this.model !== _.get(info, ['beacon', 'Device-Model'], null)) {
            return;
        }
        clearTimeout(amxtimer);
        foundDevice(this, info.address);
    });
};

// コマンド登録
denonavr.prototype.registerCommand = function(cmd) {
    registerAccessor(this, cmd);
}

// 任意コマンド文字列送信
// respには応答文字列を指定する
// respの指定がない場合はcmdが応答文字列も兼ねる
denonavr.prototype.command = function(cmd, resp = null) {
    return new Promise((resolve, reject) => {
        pushExec(this, cmd, resp, resolve, reject);
    });
};

// プロパティ名による設定
denonavr.prototype.setProperty = function(prop, v) {
    const app = this.cmds.filter(_.matches({name:prop}));
    if (_.size(app) !== 1) {
        return Promise.reject(new Error(`denonavr: Property '${prop}' not found in device state`));
    }
    return set(this, app[0], v);
}

// プロパティ名による設定
denonavr.prototype.getProperty = function(prop) {
    const app = this.cmds.filter(_.matches({name:prop}));
    if (_.size(app) !== 1) {
        return Promise.reject(new Error(`denonavr: Property '${prop}' not found in device state`));
    }
    return get(this, app[0]);
}

module.exports = denonavr;
