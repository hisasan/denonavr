'use strict';

const denon    = require('./');
const readline = require('readline');
const {once}   = require('events');
const _        = require('lodash');

// モデル名 AMX Device Discoveryで探す名前
const model    = (process.argv.length > 2) ? process.argv[2] : 'AVR-X2400H';
// ホスト名 mDNSで探す名前
const hostname = (process.argv.length > 3) ? process.argv[3] : 'denon-avr-x2400h.local';

async function main() {
    // 初期化
    const avr = new denon();
    avr.init(obj => console.log('callback:', JSON.stringify(obj)), model, hostname);

    // サラウンドモードコマンド追加
    avr.registerCommand({
        // setSurroundMode / getSurroundMode
        name:  'surroundMode',
        cmd:   'MS',
        regs:  /^MS(.+)/
    });

    // サポートしているメソッドを表示
    console.log('--- Supported functions');
    _.keysIn(avr).filter(key => _.isFunction(avr[key]) && key !== 'callback').forEach(name => console.log(name + '()'));
    console.log('---');

    // メソッド名を入力するとそのメソッドを呼び出す
    //   setProperty volume 35
    //   getInput
    //   など
    // それ以外の入力はダイレクトコマンドとしてそのままデバイスに送信される
    //   MV35
    //   SI?
    //   など
    while (true) {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        let [line] = await once(rl, 'line');
        rl.close();
        line = line.trim();
        if (line == '') {
            continue;
        }

        try {
            let ret;
            const ws = line.split(' ');
            const cmd = ws.shift();
            if (_.hasIn(avr, cmd) && _.isFunction(avr[cmd])) {
                // メソッド呼び出し
                ret = await avr[cmd](...ws);
            } else {
                // ダイレクトコマンド発行
                ret = await avr.command(line);
            }
            console.log(`${line} => ${ret}`)
        } catch (e) {
            console.dir(e);
        }
    }
}

main();
