# Element Drift — Max/MSP 版 (Phase 1)

ZIG SIM PRO のセンサーストリームから運動共感エレメント10要素の活性度を抽出し可視化する。

## ファイル

- `ElementDrift.maxpat` — メインパッチ (udpreceive → js → multislider)
- `elements.js` — OSCパース・特徴抽出・走行正規化・セルフテスト (ロジックは全部ここ)

## ZIG SIM PRO 側の設定

- **SENSOR**: Acceleration / Gravity / Gyro を ON (Quaternion は Phase 2 で使用予定なので ON でも可)
- **SETTINGS**:
  - DATA DESTINATION: OTHER APP
  - PROTOCOL: UDP
  - IP ADDRESS: Mac の IP (同一 Wi-Fi)
  - PORT NUMBER: **9600**
  - MESSAGE FORMAT: **OSC**
  - MESSAGE RATE (PER SEC): 最大値 (60)

## 使い方

1. `ElementDrift.maxpat` を開く (elements.js は同フォルダにあるので自動で読まれる)
2. **電話なしで動作確認**: `selftest 1` をクリック。5秒ごとに
   静止 → 傾き → 振動 → リズム → 回転 → 加減速 のパターンを合成生成し、
   対応するバーが順に立てば正常。Max ウィンドウに segment 名が print される。
   `selftest 0` で停止。
3. 実機: ZIG SIM PRO を上記設定で送信開始。「受信Hz」に実効レートが表示される。
   accel が重力込みか否かは受信開始後 約100サンプルで自動判定される
   (Max ウィンドウに `accelmode ...` と表示)。
4. `reset` で走行正規化の min/max をリセット。

## v2 (element_drift_v2.html) からの変更点

- 重力分離: 窓平均ハックを廃止し、CoreMotion 由来の gravity / userAcceleration を直接使用
- 傾き (tilt): gravity ベクトルから直接算出
- 重力要素: 自由落下に加え「重力への抗い」(重力と逆向きの持続加速) を追加、max で合成
- 処理: 取り込みはセンサーレートそのまま、特徴計算・出力は 50ms (20Hz)
- 正規化: 走行 min/max (減衰つき) を維持 — インスタレーション形式のため

## 単位の前提

- accel / gravity: G (×9.80665 で m/s²)
- gyro: rad/s (deg/s だった場合は elements.js の `GYRO_DEG = 1` に)
