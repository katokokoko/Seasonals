# SKR read資料

- `idl.json`: 公式react-native-samplesのIDL。SHA-256 `6e71d7a36ee9ea4410394ec69d9007dca4fb05ad902741004f1d3746b607df03`。
- `protocol-reference-20260920.json`: mainnet-beta / confirmed / slot `448756823`のconfig、pool、vault、mint、Clock。raw account bytesと採用IDLによるdecode、11項目の参照検証を含む。

これは共通accountの参照資料であり、利用者のUserStakeは含まない。pending、追加解除、LIVE合格のfixtureとしては未完成。観測したcooldown_secondsは`172800`だが、実装では毎回configから読む。

利用者の公開walletを受け取ったらUserStakeをPDA導出し、同じ必須account群と一緒に単一batchで取り直す。追加解除の前後もそれぞれ別batchで保存する。秘密鍵、認証token、API key付きRPC URLを保存しない。

ソース: https://github.com/solana-mobile/react-native-samples/blob/main/skr-staking/program/idl.json
