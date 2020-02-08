# denonavr

Denon社製AVアンプの制御を行うモジュールです。今のところ、下記のようなことができます。

* 電源ON/OFF
* マスターボリューム変更
* 入力切換
* ダイナミックボリューム変更

## 使用方法

### 初期化

```JavaScript
const avr_factory = require('denonavr');
const avr = new avr_factory();
// アンプの検索
avr.init((state) => {
    // 状態遷移を受け取るコールバック
}, 'AVR-X2400H', 'denon-avr-x2400h.local');
```
init()の引数でモデル名とホスト名を指定していますが、これらは省略可能です。

* hostnameを指定した場合は、mDNSでのアドレス解決を試みます。
* modelnameを指定した場合は、AMX Device Discovery Protocolで指定modelnameのビーコン送信元をAVアンプとします。
* modelnameの指定がない場合は、AMX Device Discovery Protocolでビーコンの送信元を無条件にAVアンプとします。

ビーコンは30秒に1回くらい送信しているようなので、タイミングによってはAVアンプの認識まで時間がかかります。

init()でAVアンプ検索後は、AVアンプとコマンド送受信用のtelnet接続したままとなり、AVアンプの状態変化を常に監視します。AVアンプを手動操作したときも、telnet通信ライン上にはこちらから操作したときと同様のレスポンスが返されるので、これを解析することでどのような手動操作が行われたかを判断することができるようです。

今のところ、後述のinit()コールバックで受け取れるオブジェクトに書かれた内容のみコールバックで通知します。

### 機器操作

```JavaScript
// アンプの電源ON/OFF
avr.on();
avr.off();
// マスターボリューム変更
avr.setVolume(20);
// ミュート
avr.setMute(true);
// 入力切換
avr.setInput('SAT/CBL');
// ダイナミックボリューム変更
avr.setInput('MED');
```
AVアンプの操作は、プロトコル的にはtelnetな無手順プロトコルなので、大層なことは何もしていません。
入力切換に使用できる引数は、下記のような感じになってます。

```
SAT/CBL, BD, DVD, AUX2, MPLAY, PHONO, CD, TUNER, TV, GAME
```
他にもありそうですが、アンプによって異なるようです。
init()のコールバックで状態遷移を受け取りながら、AVアンプを手動操作すると下記のようなオブジェクトを受け取れるので、inputプロパティをみることでお持ちのアンプの入力の指定文字列がわかります。

### init()コールバックで受け取れるオブジェクト

```JavaScript
state = {
    powerState: 'ON',
    volume: '35',
    muted: false,
    input: 'SAT/CBL',
    dynamicVolume: 'MED'
}
```

## 使用環境
以下のような環境で使用しています。

|項目|内容|
|:----|:--------------------------------------|
|ホスト|Raspberry Pi 3B+ Raspbian Stretch Lite|
|AVアンプ|Denon社製AVR-X2400H|
