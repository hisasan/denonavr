'use strict';

var dgram     = require('dgram');

const address = '239.255.250.250';
const port    = 9131;

// 成功するまでaddMembershipを繰り返す
function tryAddMembership(client, address) {
    try {
        client.addMembership(address);
    } catch (e) {
        setTimeout(function () {tryAddMembership(client, address);}, 5000);
    }
}

var amxb      = {
};

// AMXB対応機器を検出するとコールバックする
// DenonのAVR-X2400Hでしか動作確認してないが同じようにビーコンを
// マルチキャストで送信している機器なら見つけられると思う
amxb.discover = function(cb) {
    this.callback = cb;
    var client = dgram.createSocket('udp4');

    // マルチキャストでAMXBビーコンを待ち受ける
    client.on('listening', () => {
        client.setMulticastLoopback(true);
        tryAddMembership(client, address);
    });

    // フレーム受信
    client.on('message', (message, remote) => {
        if (message.toString('ascii', 0, 4) != 'AMXB') {
            // ヘッダがAMXBではない
            return;
        }
        // AMXBビーコンフレームをJSON形式に変換してコールバックする
        let js = {};
        let result;
        let m = message.toString();
        while ((result = m.match(/<-([^=]+)=([^>]+)>/)) != null) {
            js[result[1]] = result[2];
            m = m.slice(result[0].length + result.index);
        }
        this.callback(remote.address, js);
    });

    // 待ち受けポート設定
    client.bind(port);
};

module.exports = amxb;
