'use strict';

const net            = require('net');
const debug          = require('debug')('denonavr');
const amxb           = require('./amxb');
const isLocalAddress = require('./localaddress');

const port     = 23;

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
        if (f.tcpcon) {
            f.socket.write(f.run.cmd + '\r');
        }
        setTimeout(dispatcher2, f.run.wait, f);
    }
}

function dispatcher2(f) {
    f.run = null;
    dispatcher(f);
}

function pushExec(f, cmd, wait = 0) {
    f.que.push({ cmd: cmd, wait: wait });
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
            const cmds = [
                { prop:'volume',        regs:/^MV([0-9]+)/ },
                { prop:'muted',         regs:/^MU(ON|OFF)/, trueSymbol:'ON' },
                { prop:'input',         regs:/^SI([A-Z0-9.¥/]+)/ },
                { prop:'powerState',    regs:/^ZM(ON|OFF)/ },
                { prop:'dynamicVolume', regs:/^PSDYNVOL ([A-Z]+)/ }
            ];
            for (let j = 0; j < cmds.length; j++) {
                const cdef = cmds[j];
                const arg  = checkCommand(ws[i], cdef.regs);
                if (arg != null) {
                    debug(`denonavr: ${cdef.prop}=${arg}`);
                    if (cdef.hasOwnProperty('trueSymbol')) {
                        f.state[cdef.prop] = (arg == cdef.trueSymbol) ? true : false;
                    } else {
                        f.state[cdef.prop] = arg;
                    }
                    f.callback(f.state);
                }
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
    pushExec(this, 'PWON', 5000);
};

// 電源OFF
denonavr.prototype.off = function() {
    pushExec(this, 'PWSTANDBY', 5000);
};

// ボリューム変更
denonavr.prototype.setVolume = function(vol) {
    pushExec(this, 'MV' + vol);
};

// ボリュームミュート
denonavr.prototype.setMute = function(mute) {
    pushExec(this, mute ? 'MUON' : 'MUOFF');
};

// 入力変更
denonavr.prototype.setInput = function(inp) {
    pushExec(this, 'SI' + inp);
};

// ダイナミックボリューム変更
denonavr.prototype.setDynamicVolume = function(dv) {
    pushExec(this, 'PSDYNVOL ' + dv);
};

module.exports = denonavr;
