'use strict';

const net            = require('net');
const debug          = require('debug')('denonavr');
const amxb           = require('./amxb');
const isLocalAddress = require('./localaddress');

const port    = 23;

const ON      = 0;
const OFF     = 1;
const SETVOL  = 2;
const SETINP  = 3;
const SETMUTE = 4;

// ディスパッチャー
// キューから次のコマンドを取り出して実行
function dispatcher(f) {
    if (f.run == null) {
        if (f.que.length > 0) {
            // 次のコマンドをキューから取得
            f.run = f.que.shift();
            f.retry = 5;
        } else {
            // キューが空
            f.run = null;
        }
    }

    if (f.run) {
        // コマンド送信
        let w = 0;
        if (f.tcpcon) {
            switch (f.run.type) {
                case ON:
                    f.socket.write('PWON\r');
                    w = 5000;
                    break;
                case OFF:
                    f.socket.write('PWSTANDBY\r');
                    w = 5000;
                    break;
                case SETVOL:
                    f.socket.write('MV' + f.run.data + '\r');
                    break;
                case SETINP:
                    f.socket.write('SI' + f.run.data + '\r');
                    break;
                case SETMUTE:
                    f.socket.write('MU' + f.run.data + '\r');
                    break;
            }
        }
        setTimeout(dispatcher2, w, f);
    }
}

function dispatcher2(f) {
    f.run = null;
    dispatcher(f);
}

function pushExec(f, type, data) {
    f.que.push({ type: type, data: data });
    if (f.run == null) {
        // ディスパッチャー停止時に起動する
        dispatcher(f);
    }
}

function checkCommand(line, pat) {
    let arg = line.match(pat);
    if (arg != null && arg.length > 0) {
        return arg[1];
    }
    return null;
}

function connectionKeeper(f) {
    // AVレシーバに接続
    f.socket = new net.Socket();
    f.socket.connect(port, f.address, () => {
        debug(`denonavr: connected`);
        f.socket.write('ZM?\r');
        setTimeout(() => {f.socket.write('MV?\r');}, 300);
        setTimeout(() => {f.socket.write('SI?\r');}, 600);
        f.tcpcon = true;
    });

    // AVレシーバからの受信を解析
    f.socket.on('data', (data) => {
        let ws = data.toString().split('\r');
        for (let i = 0; i < (ws.length - 1); i++) {
            let arg;
            if ((arg = checkCommand(ws[i], /^MV([0-9]+)/)) != null) {
                // マスターボリューム変更
                debug(`denonavr: Volume=${arg}`);
                f.state.volume = arg;
                f.callback(f.state);
            }
            if ((arg = checkCommand(ws[i], /^MU(ON|OFF)/)) != null) {
                // ミュート
                debug(`denonavr: Mute=${arg}`);
                f.state.muted = (arg == 'ON') ? true : false;
                f.callback(f.state);
            }
            if ((arg = checkCommand(ws[i], /^SI([A-Z0-9.¥/]+)/)) != null) {
                // 入力変更
                debug(`denonavr: Select=${arg}`);
                f.state.input = arg;
                f.callback(f.state);
            }
            if ((arg = checkCommand(ws[i], /^ZM(ON|OFF)/)) != null) {
                // メインゾーンパワー
                debug(`denonavr: ZoneMain=${arg}`);
                f.state.powerState = arg;
                f.callback(f.state);
            }
        }
    });

    // 接続でエラー発生
    f.socket.on('error', () => {
        console.error(`denonavr: connection error`);
        f.tcpcon = false;
    });

    // 接続が閉じた（接続できなかったとき）
    f.socket.on('close', () => {
        debug(`denonavr: closed`);
        f.tcpcon = false;
        setTimeout(connectionKeeper, 5000, f);
    });
}

// 公開部
var denonavr = function(address) {
    this.callback = function() {};
    this.socket   = null;
    this.tcpcon   = false;
    this.keeper   = false;
    this.que      = [];
    this.run      = null;
    this.state    = {};
    this.model    = null;
    if (address) {
        this.address = address;
        this.mdns    = true;
    } else {
        this.address = '';
        this.mdns    = false;
    }
};

// 初期化
denonavr.prototype.init = function(callback, model) {
    this.callback = callback;
    if (model !== undefined) {
        this.model = model;
    }
    if (this.mdns) {
        // mDNSで検索
        this.keeper = true;
        connectionKeeper(this);
    } else {
        // AMXBで検索
        amxb.discover((a, info) => {
            if (this.model != null && this.model != info.Model) {
                return;
            }
            if (this.address != a && isLocalAddress(a)) {
                console.log(`Found ${info.Model} on ${a}`);
                this.address = a;
                if (this.keeper == false) {
                    this.keeper = true;
                    connectionKeeper(this);
                } else {
                    this.socket.destroy();
                }
            }
        });
    }
};

// 電源ON
denonavr.prototype.on = function() {
    pushExec(this, ON, null);
};

// 電源OFF
denonavr.prototype.off = function() {
    pushExec(this, OFF, null);
};

// ボリューム変更
denonavr.prototype.setVolume = function(vol) {
    pushExec(this, SETVOL, vol);
};

// ボリュームミュート
denonavr.prototype.setMute = function(mute) {
    pushExec(this, SETMUTE, mute ? 'ON' : 'OFF');
};

// 入力変更
denonavr.prototype.setInput = function(inp) {
    pushExec(this, SETINP, inp);
};

module.exports = denonavr;
