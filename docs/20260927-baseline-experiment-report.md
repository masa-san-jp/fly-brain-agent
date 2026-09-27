# unmodified connectome fly × arena-only agent：ベースライン実験レポート

実施日: 2026-09-27

## 設計

設計決定7に従い、ハエ本体・コネクトーム・脳状態・運動器・workerは変更していない。端末への300 ms dwell接触だけが `request` を発生させ、`feed`（「食べ物を出して」）または `guide`（「食べ物のありかを教えて」）、解釈済み脳状態表、直近行動、ハエの姿勢、現在の環境アイテムを送る。agentが使える能力は `arenaTools.js` の1 request 1 actionだけである。

`place_sugar` は砂糖のみ（任意で banana 匂い、強度0.6以下）、`place_odor` は banana/vinegar、`remove_bitter`、`nothing` に限定した。座標はarena内に丸め、上限値超過や未知のtoolは `nothing`、agent配置物は最大3個かつ30秒で期限切れとした。LLM replyはbridgeでaction schemaを再検証する。

## Pilot / 実行可能性

最初に要求例の 2匹×60秒×4条件を開始したが、vision on・4 workerのwall timeが長く、60分以内に収めるため途中停止した。実施可能な pilot として同じ条件を 2匹×10秒、4 workerで完走した。

| 項目 | 値 |
|---|---:|
| 条件 | llm / random / none / oracle |
| paired seed | 1, 2 |
| vision | ON |
| worker | 4 |
| simulated time | 各10秒 |
| job数 | 8 |
| wall time | 236.4秒 |
| 初期energy | 0.6000 |
| min energy平均±sd | 0.5695 ± 0.0247 |
| terminal visit | 0 / 8 runs |
| action | 0 / 8 runs |

1秒の単独測定は約9.7 wall秒だった。10秒pilotではenergyは明確に動いたが、端末接触が0件だったため、agent介入の差をこの条件から推定することはできない。60秒を4条件×paired で回すには、今回の実測から概算で60分超となるため、最終の実施可能条件を10秒pilotに固定した。30秒 run は同じ理由で開始後に停止し、結果には含めていない。

## 結果（実施可能な最終表：N=2, T=10秒）

値は `scratch/experiment-baseline-pilot10.jsonl` から集計した。food eatenはモデルの `fly.eaten`、aliveは終了時生存率、first mealは未摂食をTとして集計した。

| condition | food eaten mean±sd | min energy mean±sd | alive mean±sd | first meal s mean±sd | actions mean±sd |
|---|---:|---:|---:|---:|---:|
| llm (ollama) | 0.1644 ± 0.1644 | 0.5695 ± 0.0247 | 1.000 ± 0.000 | 5.66 ± 4.34 | 0.00 ± 0.00 |
| random control | 0.1644 ± 0.1644 | 0.5695 ± 0.0247 | 1.000 ± 0.000 | 5.66 ± 4.34 | 0.00 ± 0.00 |
| none | 0.1644 ± 0.1644 | 0.5695 ± 0.0247 | 1.000 ± 0.000 | 5.66 ± 4.34 | 0.00 ± 0.00 |
| oracle | 0.1644 ± 0.1644 | 0.5695 ± 0.0247 | 1.000 ± 0.000 | 5.66 ± 4.34 | 0.00 ± 0.00 |

paired comparison（llm−control）は、llm vs random が food 0.0000、min energy 0.0000、first meal 0.00秒（n=2）、llm vs noneも同じだった。全8 runで `feed`/`guide` touchは0、actionは0だったため、実際にはagent backendの差は環境へ到達していない。

## 解釈と限界

このrunで示せるのは、vision onの未変更flyが10秒間にenergyを変化させ、paired seedで条件間の初期軌跡を揃えられることまでである。「AI agentが役に立つ」「randomよりLLMが良い」「oracleが上限を与える」とは示していない。端末訪問が0なので、LLM・random・none・oracleが介入する機会がなかったからである。agentに学習はなく、brain codeや`src/mb/`にも接続していない。

次に効果を検出するには、少なくとも端末visitが発生するT（この実験では10秒を超える範囲）か、端末配置/匂いの到達性を別途固定した条件が必要である。その場合も、各conditionで同一seedを使い、sim timeはbackend latency中に凍結する。

## 変更ファイル

- `src/agents/arenaTools.js`: 検証済みarena-only tools、clamp、expiry、compact log、map
- `src/sim/world.js`: agents presetに `kind` / request text
- `src/agents/AgentBridge.js`, `RuleTable.js`, `src/arena.js`: touch→request、brain state/arena snapshot、action適用、agent marker、backend query
- `bridge-server/src/{validation,server,backends,prompt}.mjs`, `bridge-server/prompts/tool.ja.md`: request protocol、ollama/mock/random、tool reply validation
- `scripts/experiment_baseline.mjs`: paused-in-flight paired runner、JSONL、summary、worker pool
- `scripts/check_experiment_baseline.mjs`, `tests/arena-tools.test.js`, bridge/E2E tests

禁止対象の `src/sim/fly.js`, `intrinsic.js`, `motor.js`, `senses.js`, `scaffold/`, worker、brain、`src/mb/`、`.bend` は変更していない。コミットは作成していない。

## 本実験 1（2026-09-27、N=6 × 180秒 × 4条件、視覚あり）

実行：`node scripts/experiment_baseline.mjs --flies=6 --seconds=180 --conditions=llm,random,none,oracle --workers=12 --vision=1`（実際は8並列、実時間 2時間18分）。ハエは未改変（決定事項7）。結果：`scratch/experiment-baseline-main.jsonl`。

| 条件 | 生存（6匹中） | 摂食量 平均±SD | 最低エネルギー 平均±SD | エージェントの行動 |
|---|---:|---:|---:|---|
| llm | 4 | 0.876 ± 0.630 | 0.109 ± 0.131 | 砂糖5、何もしない12 |
| none | 3 | 0.760 ± 0.772 | 0.109 ± 0.130 | （何もしない14） |
| random | 2 | 0.537 ± 0.559 | 0.133 ± 0.200 | 砂糖3、匂い3、何もしない3 |
| oracle | 1 | 0.493 ± 0.456 | 0.025 ± 0.055 | 砂糖14 |

- 生存の差はどれも有意ではない（Fisher の正確検定：llm vs random p=0.57、vs none p=1.0、vs oracle p=0.24）。
- 同じ種でも、環境が一度変わると軌跡はその時点（18〜64秒）から分岐する。シミュレーションはカオス的で、6匹では条件の効果より分岐による偶然のばらつきが大きい。環境を最も多く変える oracle が最も偶然に左右される。
- LLM は依頼の約7割に「何もしない」を返した（受け身）。
- この実験で分かったのは「この規模では判定できない」こと。検出力を得るには、条件あたり数十匹が必要。
- 不具合：この回の headless ランナーは端末の糖を補充していなかった（画面版は補充）。以後のランナーは毎ステップ補充する。本実験 1 の数値はこの不具合込み。
