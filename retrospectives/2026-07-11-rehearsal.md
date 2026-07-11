# GameDay 振り返り: 通しリハーサル (scenario-01 + scenario-02)

- 実施日時: 2026-07-11 15:50 – (JST)
- シナリオ: リハーサル (タスク停止 / Aurora フェイルオーバーの 2 本)
- 実験テンプレート ID: stop-task=`EXT4CefKarE8Viek` / failover=`EXT6oWLHq6MnLLdAY`
- 実験 ID: (実行後に転記)
- 参加者: maehara (solo リハーサル)

## 仮説

- 定常状態の仮説: canary (gameday-top) 成功率 100%、ALB 5xx = 0、RunningTaskCount = 2
- 注入する障害:
  1. `aws:ecs:stop-task` — タスク 1 つ停止 (COUNT(1)、タグ選択)
  2. `aws:rds:failover-db-cluster` — Aurora ライター切替
- 期待した振る舞い:
  1. ECS が自己回復。desiredCount=2 / minHealthy=50% なので**ユーザー影響なし**、canary は成功継続
  2. フェイルオーバー中は "/" が 503 (canary 失敗)、アプリの再接続後に自動回復。ALB ヘルスチェックは /healthz (DB 非依存) なのでタスクは登録維持

## 実験前ベースライン (15:49–15:55 JST)

- `cdk drift`: **クリーン (drift 0 件)**。ただし 16 リソースはドリフト検出非対応 (unchecked) — 「ドリフトなし = 変更なし」ではない点に注意
- canary 成功率 (直近 5 run): **5/5 PASSED** (15:49–15:53)
- アプリ応答: `/healthz` 200 alive / `/` 200 db reachable
- 停止条件アラーム `gameday-5xx-stop-condition`: **OK**
- ECS: desired 2 / running 2

## タイムライン (JST)

| 時刻 | 出来事 | ソース |
|---|---|---|
| 15:50–15:51 | `cdk deploy --all` (既存スタックへの差分適用、3 スタック UPDATE_COMPLETE) | CDK |
| 15:55:29 | 実験1 開始 (`EXPLtguw23gC7TaXP8` / stop-task) | FIS |
| 15:55:51 | 実験1 完了 (アクション実行 15:55:50–51) | FIS |
| 15:56:12 | ターゲット登録解除・タスク停止 → 15:56:13 代替タスク起動 | ECS events |
| 15:56:42 | 代替タスクがターゲット登録 = **回復 (停止から約 30 秒)** | ECS events |
| 15:58:07 | 実験2 開始 (`EXP7hkWi4qi2Cy5iC2` / failover-db-cluster) | FIS |
| 15:58:21 | クロス AZ フェイルオーバー開始 | RDS events |
| 15:59:04 | フェイルオーバー完了 (**43 秒**)。ライターが reader インスタンスに切替 | RDS events |
| 16:10:21 | (演習) desiredCount を手動で 2→3 に変更 = 応急処置の模擬 | 手動 |
| 16:11 頃 | `cdk drift GameDay-App` が `DesiredCount 2→3` を検出 | cdk drift |
| 16:13 頃 | desiredCount を 2 に戻し、drift 0 件を確認 | cdk drift |

## 観測結果

### 外形監視 (ユーザーから見えた影響)

- canary `gameday-top`: 15:49–16:08 の全 run **PASSED**。実験 1・2 とも**ユーザー影響ゼロ**
- 15 秒間隔の HTTP ポーリング ("/" = DB 疎通): フェイルオーバー窓 (15:58:21–15:59:04) を跨いで**全て 200**
- 停止条件アラーム `gameday-5xx-stop-condition`: 終始 OK (発火なし)

### メトリクス (システム内部)

- ECS RunningTaskCount: 2 → 1 → 2 (実験 1、約 30 秒で復帰)
- RDS: ライターが `databasewriter…` → `databasereader…` に切替 (describe-db-clusters で確認)

### ドリフト (応急処置の痕跡)

- 実験前: 0 件 (クリーン)。実験 2 本の後も 0 件 — **自己完結型の障害はドリフトを残さない**(仮説どおり)
- 手動変更の演習: `DesiredCount 2→3` を `cdk drift` が正確に検出。差分表示は `[-] 2 / [+] 3` で登壇デモにそのまま使える。戻すと 0 件に復帰
- 注意: 各スタック 13–16 リソースはドリフト検出非対応 (unchecked)

## 仮説と観測のズレ

1. **実験 1 (合致)**: 「ECS が自己回復しユーザー影響なし」→ そのとおり。ただし回復は想定 (数分) よりずっと速い**約 30 秒**
2. **実験 2 (外れ — 最大の学び)**: 「フェイルオーバー中は '/' が 503 になり canary が失敗する」→ **一度も失敗しなかった**。フェイルオーバーは 43 秒で完了し、`SELECT 1` の読み取りプローブ + リクエスト毎の短命接続 (connectTimeout 3s) はこの速さの切替を可視化できない。皮肉にも「切断を素早く検知するため」の per-request 接続設計が、最強の回復戦略として機能した

## 学び

1. **読み取りプローブは速い Aurora フェイルオーバーに勝てない**。書き込み断を見せたいなら、書き込みを伴うエンドポイントと canary が必要
2. **GameDay の観測窓 (canary 1 分間隔) より速い障害は「起きなかったこと」になる**。シナリオの期待値は観測手段の分解能とセットで設計する
3. `cdk drift` の「実験前クリーン → 実験後もクリーン = 応急処置なしの証明」「手動変更は即検出」のストーリーは実機で成立する
4. FIS 実験レポート (experimentReportConfiguration) を設定していなかったため、振り返りの一次資料は手動収集になった

## アクションアイテム

- [ ] app に書き込みエンドポイント (`/write` 等、INSERT 実行) を追加し、canary から叩く (scenario-02 を「見える」障害にする)
- [ ] FIS テンプレートに experimentReportConfiguration (S3 + gameday-review ダッシュボード) を追加
- [x] scenario-02 の「期待する振る舞い」を観測結果に合わせて改訂 → `scenarios/02-aurora-failover.md` で改訂済み。あわせて観測可能性チェックを `add-scenario` スキルとして整備 (2026-07-11)
- [ ] 本番 GameDay ではフェイルオーバー方向が毎回入れ替わる点に留意 (今回 writer→reader に切替済み)

## 添付

- FIS 実験レポート: なし (experimentReportConfiguration 未設定 — アクションアイテム参照)
- CloudWatch ダッシュボード: `gameday-review` (ap-northeast-1)
