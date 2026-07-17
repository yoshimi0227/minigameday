# ミニ GameDay (振り返り機能付き)

生成AI × AWS CDK × AWS FIS で「振り返れる」ミニ GameDay。
ALB + Fargate の Web アプリに FIS で障害を注入し、CloudWatch Synthetics (Playwright ランタイム) と `cdk drift` で振り返る。

## スタック構成

本体は **`GameDay` 1 スタック**。3 本柱は `lib/constructs/` 配下の Construct で分離する(cross-stack Strong Reference を避けるため。詳細は CLAUDE.md)。

| スタック / Construct | 役割 |
|---|---|
| `GameDay` スタック | 下記 3 Construct を束ねる本体スタック |
| └ `TargetApp` | お題の対象アプリ(3層)。ALB + Fargate(DB に ping する Node アプリ ×2)+ Aurora MySQL Serverless v2。`/healthz`=生存、`/`=DB 疎通(200/503) |
| └ `Observability` | 振り返り。Synthetics canary(Playwright)、5xx 停止条件アラーム、ダッシュボード `gameday-review`(ALB/Target/Aurora 指標) |
| └ `FaultInjection` | 障害注入。FIS 実験テンプレート2種(①Fargate タスク停止 / ②Aurora フェイルオーバー) |
| └ `ScoreEscalation` | スコア置き場(DynamoDB)+ Streams 起動 Lambda。実効スコアが閾値到達で「次の障害」を自動発火 |
| `GameDay-Legacy` スタック | scenario-03 用の SPOF 出発点(単一 EC2)。deploy ライフサイクルが異なるので独立。必要な回だけデプロイ |

## セットアップ

```bash
npm install
npx cdk bootstrap        # 初回のみ (アカウント/リージョンごと)
```

> アプリ層は `app/` を Docker ビルドする(`ContainerImage.fromAsset`)。
> **`cdk deploy` 時は Docker デーモンの起動が必要**(`cdk synth` は不要)。

## GameDay の流れ(6 フェーズ)

### フェーズ1: 環境構築 & ベースライン確認

```bash
npm run deploy                 # cdk deploy --all
#    出力 GameDay.TargetAppAlbUrl をブラウザで開いて正常 (200) を確認

# ★ 注入前ベースライン (振り返りの説得力の土台):
npm run drift                  # cdk drift が "No drift detected" であること
#    → 出ていたら先に解消するか「既存ドリフト」として記録。
#      こうしておくと実験後のドリフトを "実験(や参加者の対応)起因" と断定できる。
aws synthetics get-canary --name gameday-top --query "Canary.Status.State"  # RUNNING を確認
#    canary 成功率が直近 100% (定常状態) であることが MTTR 算出の起点になる

# (別ターミナル) 当日ダッシュボード — スコア表 / 検知・復旧チャート / KPT
#    dashboard/public/data/gameday.json の編集で画面に即時反映
npm run dashboard
```

### フェーズ2: シナリオ生成(Claude Code)

Claude Code で `add-scenario` スキル(+ `gameday-scenario` エージェント)を使い、
`scenarios/NN-<slug>.md` を生成 → `fis-experiment` スキルで `lib/constructs/fault-injection.ts` に実装。
生成後は必ず `npm run build && npm test && npm run synth:nag` で検証する(詳細は CLAUDE.md / 各スキル)。

### フェーズ3: 障害注入(FIS 実行)— 2 ラウンド制

本番の GameDay と同様、障害を性質で 2 ラウンドに分ける(ダッシュボードは `round` でグルーピング表示):

- **R1 観察ラウンド** — 自己回復する障害。静観・判断の練習(壊れても待てば戻る)
- **R2 対応ラウンド** — 自己回復しない障害。**人が手を動かして直すまで復旧しない**(MTTR が対応速度を実測)

```bash
# --- R1 観察ラウンド (自己回復。静観が正解になりうる) ---
#    シナリオ1: Fargate タスクを1つ停止 (出力 GameDay.FaultInjectionStopTaskTemplateId)
aws fis start-experiment --experiment-template-id <StopTaskTemplateId>
#    シナリオ2: Aurora をフェイルオーバー (出力 GameDay.FaultInjectionFailoverDbTemplateId)
aws fis start-experiment --experiment-template-id <FailoverDbTemplateId>

# --- R2 対応ラウンド (自己回復しない。参加者が直すまで赤のまま) ---
#    シナリオ5: Fargate を desiredCount=0 に落とす (出力 GameDay.FaultInjectionScaleToZeroTemplateId)
aws fis start-experiment --experiment-template-id <ScaleToZeroTemplateId>
#    シナリオ3: 単一 EC2 を terminate → Fargate に作り替えて復旧 (GameDay-Legacy スタック)
aws fis start-experiment --experiment-template-id <GameDay-Legacy の ExperimentTemplateId>

aws fis get-experiment --id <experiment-id>   # 状態・タイムライン
#    実験ログは CloudWatch Logs /gameday/fis-experiments に残る (振り返りの素材)
```

**R2 の復旧は人手が要る**:
- **scale-to-zero** → 参加者が desiredCount を 2 に戻す(`aws ecs update-service --cluster <名> --service <名> --desired-count 2` またはコード整合なら `cdk deploy`)。放置しても ECS は戻さない。
- **EC2 rebuild** (scenario-03) → 参加者が同じイメージを Fargate + ALB に組み直す(ハンドアウトの CfnOutput を使う)。詳細は `scenarios/03-ec2-to-ecs-rebuild.md` / `scenarios/05-scale-to-zero.md`。
- **GameDay-Legacy は GameDay の後にデプロイする**(canary イベントを本体の `gameday-score` テーブルに名前参照で書くため。テーブルは GamedayStack が作る)。

**障害開始を遅らせる**: デプロイ時に `-c faultDelayMinutes=5` を渡すと、各実験の先頭に
`aws:fis:wait` (5 分) が入る。`start-experiment` を叩くと実験は「実行中(待機)」になり、
**5 分後に障害が発生**する (デプロイ直後に叩けば実質デプロイ+5分)。待機は障害の前なので
停止条件は誤発火しない。0/未指定なら即時 (既定)。

**ランダム分後に障害を発生させる (本番モード)**: `-c faultDelayMinutes=5-15` のように範囲で
渡すと、synth 時に**実験テンプレートごとに独立な乱数**で分数が決まる (両端含む)。参加者は
「いつ障害が来るか」を知らないまま待つことになり、エスカレーションで発火する 2 発目の遅延も
別の値になる。値はテンプレートに焼き込まれるため変えるには再デプロイ。なお synth 出力や
FIS コンソールには PT{N}M が見えるので、**運営も当日は見ない**運用にするとフェアになる。

```bash
npx cdk deploy GameDay -c faultDelayMinutes=5     # 開始 5 分後に障害 (固定)
npx cdk deploy GameDay -c faultDelayMinutes=5-15  # 開始 5〜15 分後のどこかで障害 (実験ごとに乱数)
```

### フェーズ4: 復旧対応(参加者)

**参加者向けルール** — 復旧の直し方は**自由**。この選択の差が振り返りで可視化されるのが今回の肝:

- **A. コンソール / CLI で直接直す** — 速いが `cdk drift` に痕跡(応急処置)が残る
- **B. CDK を修正して `cdk deploy`** — IaC 整合を保つが手間がかかる

どちらを選んでもよい。運営はどちらを選んだか(と所要時間)を記録する。

**復旧判定** — canary ヘルスアラーム (`gameday-canary-health`) の **OK 遷移**が復旧時刻 = MTTR の
終点として自動記録される (ダッシュボードの成功率グラフが赤→緑に戻る時刻と同じ)。安定確認の
目安は canary **3 回連続(≒ 3 分)成功**。

**検知宣言と自動採点** — 障害の影響が出る (アラーム ALARM) とダッシュボードに
「🚨 影響発生中」バナーが現れる。チームは対応を始めるときに**「検知を宣言する」ボタン**を押す。
点数は次の 3 つから自動計算され、スコア表にリアルタイムで入る (詳細は「対応状況で自動採点」節):

- **検知 40 点** — 影響開始 → 検知宣言の速さ (2 分以内満点、15 分で 0 に線形減衰)
- **復旧 40 点** — 影響開始 → アラーム OK の MTTR (5 分以内満点、30 分で 0)
- **伝達・記録 20 点** — 状況宣言・記録の質。これだけ運営が手動で `commsScore` に記入

ヒントを開示すると消費ポイント分が引かれる。運営の最終裁定は `scoreOverride` で上書きできる。

### フェーズ5: 振り返り(AI 講評)

```bash
# 収集: drift / canary メトリクス / FIS タイムライン / CDK コードの git diff を 1 つに束ねる
bash scripts/collect-retrospective.sh <experiment-id> > retro-data.md
```

`retro-data.md` を Claude Code に渡し、`gameday-retrospective` スキルで 3 視点(canary / drift /
メトリクス = 復旧時間 / IaC 整合性 / 対応の妥当性)を講評 → `retrospectives/` に Markdown レポート。

講評はレポートに加えて **gameday.json の `review` セクション**にも書き込まれ、ダッシュボード末尾に
「振り返りレビュー」(総評 + インジェクトごとの講評カード) として表示される。ゲーム中に自動記録された
`events[]` (実験開始 / ALARM / OK / 検知宣言) のタイムラインとヒント消費が講評の一次資料になる。

### フェーズ6: リセット(周回 / 撤収)

**周回リセット** — destroy せずに「もう一度遊べる」状態へ戻す(約 5 分。destroy→deploy の 20〜30 分待ちを避ける):

```bash
npm run reset                # 一括リセット (下の 5 ステップ)
npm run reset -- --dry-run   # 何が起きるかの確認だけ (変更なし)
```

`scripts/reset-gameday.ts` が行うこと:

1. 実行中の FIS 実験(`gameday-*` テンプレート由来)を停止し、終了を待つ
2. `cdk deploy --all --revert-drift` — 手動対応のドリフトをコードの状態へ巻き戻す
   (drift-aware change set。新しめの CDK CLI が必要 — この環境の 2.1126.0 で確認済み。
   terminate 済みの legacy EC2 の再作成もここで行われる)
3. DynamoDB `gameday-score` の全アイテム削除 — **エスカレーションの `FIRED#` 冪等キーが
   残っていると 2 周目に自動発火しない**ため、ゲーム状態のワイプは必須
4. gameday.json をインジェクト定義だけの初期状態へ(旧データは `dashboard/data-archive/` に退避)
5. `npm run drift` 相当で "No drift" を確認

スタックを保つので **FIS テンプレート ID は変わらない**(gameday.json の
`experimentTemplateId` もそのまま使える)。scenario-03 で参加者が作った**スタック外**リソース
だけは revert の対象外 — `scenarios/03-ec2-to-ecs-rebuild.md` の棚卸しリストで手動削除する。

**完全撤収 (課金停止)**:

```bash
npm run destroy                 # cdk destroy --all
```

## 対応状況で自動採点 (検知宣言 + アラーム復旧)

「障害発生 → 検知 → 復旧」を AWS 側のイベントで記録し、ダッシュボードが自動採点する仕組み。
実装は `lib/constructs/game-events.ts` + `lambda/game-events/index.mjs` (記録) と
`dashboard/src/scoring.ts` (採点・導出ロジックの唯一の置き場):

```
FIS 実験状態遷移 (running=armed/completed…) ┐
canary ヘルスアラーム (ALARM=影響/OK=復旧) ┴→ EventBridge → Lambda game-events
   ▼
DynamoDB gameday-score { pk:'EVENT#<time>#<id>', ... }   ← 冪等 (条件付き put)
   ▼ dev サーバ (vite.config.ts) が 5 秒ごとに Scan して gameday.json へマージ
injects[] の armed / impacted / recovered・検知/復旧時刻を自動導出 → 自動採点して表示
   ▼ 実効スコア合計を POST /api/score → (下のエスカレーションへ)
```

- **inject と実験の紐づけ**: `injects[].experimentTemplateId` に FIS テンプレート ID を記入して
  おく (deploy 出力の `StopTaskTemplateId` 等)。実験を開始すると該当 inject が「実験進行中
  (armed)」になる。
- **検知宣言のガード**: 宣言ボタンは影響発生 (ALARM) 後にだけ有効。armed 中に押して検知満点を
  取る抜け道は dev サーバ側 (409) でも塞いでいる。
- **フォールバック**: FIS イベントは best effort 配信なので、取り逃したら inject に
  `experimentStartedAt` を手書きすれば同じに動く。canary に映らない障害 (読み取りプローブの
  死角など) は自動採点が成立しないので従来どおり `score` に手動記入する。
- **運用上の前提**: dev サーバの実行クレデンシャルに DynamoDB の **`Scan`**(イベント同期)と
  `PutItem`(スコア同期)が要る。未認証でも画面は壊れない (同期はベストエフォート)。

## スコア到達で「次の障害」を自動発火 (エスカレーション)

参加者の実効スコア(獲得 − ヒント消費)が閾値に達すると、**次の障害 (Aurora フェイルオーバー) を
自動で発火**する仕組み。「うまく対応できたら難易度が上がる」エスカレーション演出。実装は
`lib/constructs/score-escalation.ts` + `lambda/score-escalator/index.mjs`。スコアはゲーム状態なので
CloudWatch メトリクスではなく **DynamoDB** に持ち、そこから先はイベント駆動で AWS 側に閉じる:

```
ダッシュボード (実効スコアを計算)
   │ POST /api/score   ← dev サーバ (vite.config.ts) が DynamoDB に put-item
   ▼
DynamoDB gameday-score { pk:'SCORE', total:N }
   │ DynamoDB Streams (NEW_IMAGE, pk=SCORE の INSERT/MODIFY だけに絞る)
   ▼
Lambda score-escalator (閾値判定 → FIRED#id を条件付き put で冪等クレーム)
   ▼
fis:StartExperiment  → 次の障害が自動発火 (1 回だけ)
```

- **閾値の変更**: `-c escalateAtScore=150`(既定 100)。到達スコアで発火する。
- **冪等性**: 各トリガーは `FIRED#<id>` アイテムの条件付き書き込みで「先勝ち」クレームし、1 回だけ発火。
- **運用上の前提**: スコア同期 (dev サーバ → DynamoDB) は **AWS 認証済みシェルで `npm run dashboard`
  を起動している**こと(既定クレデンシャルチェーンを使う)。未認証・スタック未デプロイでも
  ダッシュボードの表示は壊れない(同期はベストエフォート)。テーブル名は既定 `gameday-score`
  (別名にするなら `GAMEDAY_SCORE_TABLE` env で dev サーバ側と CDK 側を合わせる)。
- **発火の確認**: `aws fis list-experiments` に escalation 由来の実験(タグ `TriggeredBy=score-escalator`)が
  現れる。Lambda ログは CloudWatch Logs のエスカレーター用ロググループ。

```bash
npx cdk deploy GameDay -c escalateAtScore=150   # スコア 150 到達で次の障害
```

## Slack 通知 (障害発生・復旧)

canary の成功率を監視する CloudWatch アラーム (`gameday-canary-health`) の状態遷移を
SNS → AWS Chatbot 経由で Slack に流す。**成功率が 100% を下回る = 🔴 障害発生 (ALARM)**、
**100% に戻る = 🟢 復旧 (OK)**。1 つのアラームで発生・復旧の両方を通知する
(自己回復型でユーザー影響が出ないシナリオは鳴らない)。実装は `lib/constructs/slack-notify.ts`。

**初回だけ手作業が必要** (Slack ワークスペースの認可):

1. AWS コンソールで **Amazon Q Developer in chat applications** (旧 AWS Chatbot) を開く。
2. Slack クライアントを設定し、対象ワークスペースを認可する (OAuth)。
3. 認可後にコンソールに表示される **ワークスペース ID** を控える。

その ID を context で渡してデプロイすると Slack 連携が有効になる:

```bash
npx cdk deploy GameDay \
  -c slackWorkspaceId=<ワークスペースID> \
  -c slackChannelId=<チャンネルID>
```

- context を渡さない場合は SNS までを作り Slack 連携はスキップする (他環境でも deploy 可)。
- 起動直後に監視が有効化される際、INSUFFICIENT_DATA → OK の遷移で「正常」通知が 1 度出る
  (= GameDay の監視が稼働した合図)。以降は 🔴 障害 / 🟢 復旧 のみ。
- ワークスペース/チャンネル ID を毎回打ちたくなければ、gitignore 済みの
  `cdk.context.json` に入れておくとよい (公開リポジトリには commit されない)。

## コスト注意

Fargate / ALB / NAT Gateway は起動中ずっと課金される。GameDay が終わったら必ず `npm run destroy`。

## 開発

```bash
npm run build      # tsc 型チェック (CDK + dashboard)
npm run lint       # Oxlint + awscdk プラグイン (CDK の静的チェック)
npm test           # ユニットテスト (FIS/Synthetics の要点 + dashboard の描画を守る)
npm run synth      # 合成 (env 非固定なのでオフラインで通る)
npm run diff       # 差分
npm run dashboard  # GameDay ダッシュボード (React。dashboard:build で静的ビルド)
```

シナリオ立案は Claude Code のサブエージェント `gameday-scenario` を使う。
