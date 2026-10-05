# Water background tuning log

採点軸: C = clarity, Ca = caustics, S = surface, D = depth & colour, H = harmony (各 1–5、`water-judge.md`)。
数値は `water-stats.json` の water-only (参照写真: meanL 207.3 / σL 19.4 / 局所 σ 13.05 / 白飛び 7.2% / 彩度 0.202 / 高周波 5.54)。
syncDraw は水面 + glass canvas の 1 frame (ms、基準 11.85 → 上限 16.6)。

| iter | commit | 仮説 / 変更 | C | Ca | S | D | H | gates | meanL / σL / 局所 σ / 白 % / 彩度 / 高周波 | syncDraw | 判断 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | (this) | 今の shader (基準) | 2 | 3 | 2 | 2 | 3 | all true | 229.1 / 14.0 / 7.38 / 26.5 / 0.153 / 1.22 | 11.85 | 網目の内側が平らなミントで砂が見えない。細い 2 本目の網がひび割れたタイルに見える。網目が流れていない。水面の筋・星がない。全体が一色で白っぽい。泡が漫画的。Home は大半が quiet zone で平らな塗りに見える |
