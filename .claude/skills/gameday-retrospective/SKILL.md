---
name: gameday-retrospective
description: GameDay / FIS 実験の振り返りを行う。「振り返りして」「実験の結果をまとめて」「障害の影響を見せて」「ドリフト検出して」「講評して」など、実験の前後比較・影響分析・講評作成の全てで必ず使う。実験の「前」から使うスキルであることに注意 — ベースライン取得 (実験前) → 観測 (実験中) → 3 視点分析と KPT 講評の gameday.json への書き込み (実験後) までを一連で扱う。cdk drift / CloudFormation ドリフト検出、Synthetics canary の結果確認、CloudWatch メトリクスの前後比較が絡む作業も該当する。
---

# GameDay 振り返り

FIS 実験の前後を突き合わせて「何が起き、どう見え、何を学んだか」を **KPT 形式の講評として
gameday.json の `feedback[]` に残す**スキル。かつては `retrospectives/` に Markdown レポートを
書いていたが、**2026-07-18 に廃止** — 講評の置き場はダッシュボードの KPT ボードに一本化した
(レポートファイルという別の存在を持たない。過去レポートは git 履歴にある)。

実験の成否そのものより「仮説と観測のズレ」が学びになる。ズレを見つけるには実験前のベースラインが必須なので、このスキルは実験後ではなく**実験前から**使う。

## 3 つの視点

| 視点 | 何が分かるか | 主なソース |
|---|---|---|
| 外形監視 (Synthetics) | ユーザーから見えた影響 | `SuccessPercent` / `Duration` メトリクス、スクリーンショット、失敗 run のログ |
| ドリフト (cdk drift) | 実験中に人間や自動化がインフラに施した「応急処置」の痕跡 | `cdk drift` / CloudFormation ドリフト検出 |
| メトリクス (CloudWatch) | システム内部で起きたこと | ALB `HTTPCode_ELB_5XX_Count` / `TargetResponseTime`、ECS `RunningTaskCount` / `CPUUtilization`、RDS `DatabaseConnections` |

加えて **CDK コードの `git diff`** も素材にする — 参加者が「コンソールで直した」(→ drift に出る) のか「CDK を修正して deploy した」(→ git diff に出る) のかで、対応の質 (IaC 整合性) が分かる。

**ヒント消費**も対応の質の材料になる。`dashboard/public/data/gameday.json` の `hintReveals[]` に「どのインジェクトのどのヒントに何ポイント使ったか」が時刻付きで記録されている。消費が多い = 詰まった/自力で解けなかった目安。講評では「早い段階で具体ヒントを買った」等を対応の妥当性に織り込む (実効スコア = 素点 − ヒント消費 は既にダッシュボードが計算済み)。

**機械記録のタイムライン (`events[]`)** が最も客観的な素材。gameday.json の `events[]` に「FIS 実験開始 (running) / 終了」「canary アラーム ALARM (影響開始) / OK (復旧)」「検知宣言 (ack)」が時刻付きで自動記録されている (GameEvents → DynamoDB → dev サーバ同期)。inject には導出済みの `impactStartAt` / `ackAt` / `recoveredAt` / `detectionMinutes` / `recoveryMinutes` と自動採点の内訳も残る。**「いつ気づいたか」を記憶に頼らず語れる**のがこの記録の価値で、タイムラインはまず events[] から起こし、人間のメモで補完する。

背骨は FIS 実験のタイムライン (`aws fis get-experiment`)。全ての観測は実験の開始・終了時刻に対して「前・中・後」で並べる。

**ドリフトの読み方 (このプロジェクトの核心)**: stop-task のような自己完結型の障害は ECS が自己修復するので、ドリフトが残らないのが正常。ドリフトが検出されたら、それは (a) GameDay 中の手動対応 (desiredCount 変更、セキュリティグループ編集など) の痕跡か、(b) 実験前から存在した管理外変更のどちらか。実験前に drift をクリーンにしておくのは、この切り分けを可能にするため。検出された手動対応は「IaC に反映すべきか、次回は自動化すべきか」まで踏み込んで Try に記録する。

## フェーズ

### 実験前 (ベースライン)

1. `npx cdk drift` を実行し、クリーンであることを確認する(実験後のドリフトを実験起因と断定できるように)。クリーンでなければ先に解消するか、既存ドリフトとして記録しておく。
2. canary の直近の成功率・Duration と、主要メトリクス (上の表) の直近値を控える (講評の「前」比較に使う)。

### 実験中

- `aws fis get-experiment --id <id>` で実験の状態を追う。
- canary と停止条件アラームの状態を観測する。「いつ・何で異常に気づいたか」をメモする — 検知の講評材料になる。

### 実験後 (分析 → KPT 講評)

1. **タイムライン確定**: events[] と `get-experiment` から「実験開始 → 影響開始 → 検知宣言 → 復旧」を実測時刻で並べる。停止条件で強制停止された場合はその時刻と発火したアラームも。
2. **3 視点の差分**: canary (前・中・後の成功率、失敗 run の中身)、`npx cdk drift` (手動対応の痕跡)、CloudWatch メトリクス。FIS 実験レポート PDF (S3) と実験ログ (`/gameday/fis-experiments`) も一次資料。
3. **KPT 講評を gameday.json の `feedback[]` に書き込む** (スキーマは gameday-dashboard スキルの references/data-schema.md):
   - `type: keep` — 実測に裏付けられた良い動き (例: 「影響 2 分で検知宣言。canary 起点の観測が機能」)
   - `type: problem` — 実測が示す課題 (例: 「検知 19.7 分は減衰ゼロ圏。Slack 通知の欠落が初動を遅らせた」)。事実ベースで責めない
   - `type: try` — 次の周回・本番でそのまま実行できる改善 (コマンド・手順・観測の張り方)
   - `author` は **`AI 講評`** にする (ダッシュボードの「AI 講評」ボタンと同じキー。ボタンで再生成すると author='AI 講評' のエントリは**入れ替わる**ので、人間の判断として残したいものは author 無し/別名で書く)
   - 特定インジェクトの講評には `scenarioId` を付ける (全体の話なら省略)
   - 「仮説と観測のズレ」が本体。合っていたことも違ったことも両方書く
4. 書いた瞬間にダッシュボードの KPT ボードへ表示される (3 秒ポーリング)。

**AI 自動生成という選択肢**: ダッシュボードの「AI 講評を KPT で生成」ボタン (dev サーバの `POST /api/review` → `dashboard/review-generator.ts` が Bedrock Converse API で LLM (既定 Amazon Nova Lite) を呼ぶ) でも同じ形式の KPT を生成できる。`review-generator.ts` の SYSTEM_PROMPT は採点ルーブリック (検知40/対応40/伝達20 等) を再掲しているので、**ルーブリックを変えたらそちらも同期する**。環境変数・モデル既定は gameday-dashboard スキルの「振り返りとの連携」を参照。このスキル (Claude Code) による講評は drift / git diff / canary スクショまで踏み込める分だけ厚くできる — どちらも出力先は同じ `feedback[]`。

### リセット (次のラウンド前 / 撤収前)

**一括: `npm run reset`** (`scripts/reset-gameday.ts`) — ①実行中の実験停止 → ②`cdk deploy --all --revert-drift` (ドリフトをコードの状態へ) → ③DynamoDB `gameday-score` の全消去 (**`FIRED#` 冪等キーが残ると 2 周目のエスカレーションが発火しない**) → ④gameday.json をインジェクト定義だけに初期化 (KPT 含む旧データは `dashboard/data-archive/` へ退避) → ⑤`cdk drift` で No drift 確認、まで自動で行う。`--dry-run` で事前確認できる。ダッシュボードの「⟳ リトライ」ボタンでも同じものが走る。

手動で個別にやる場合:

1. **前チェック**: 実験が停止していること。`aws fis list-experiments --query "experiments[?state.status=='running'].id"` が空。
2. **revert**: `npx cdk deploy --revert-drift` — ドリフトを検出し「現実 → 期待状態 (コード)」へ戻す change set を作る (新しめの CDK CLI が必要)。
3. **確認**: `npx cdk drift` が再び "No drift detected" になればリセット完了。
4. **ゲーム状態**: gameday.json の派生フィールド・`events[]` と DynamoDB のアイテムが残っていると次ラウンドの採点が壊れる — 一括リセットを使わないなら両方を手で消す。
5. 撤収なら `npm run destroy` (スタック外の手作りリソースは scenario-03 の棚卸しリストで別途削除)。

## コマンドレシピ

```bash
# 実験の状態・タイムライン
aws fis list-experiments
aws fis get-experiment --id <experiment-id>

# canary の実行履歴 (成否・失敗理由・アーティファクトの場所)
aws synthetics get-canary --name <canary-name>
aws synthetics get-canary-runs --name <canary-name>

# canary 成功率の時系列 (実験前後を 1 分粒度で)
aws cloudwatch get-metric-statistics \
  --namespace CloudWatchSynthetics --metric-name SuccessPercent \
  --dimensions Name=CanaryName,Value=<canary-name> \
  --start-time <ISO8601> --end-time <ISO8601> --period 60 --statistics Average

# ドリフト検出 (CDK: 検出開始からポーリング・結果表示まで面倒を見てくれる)
npx cdk drift

# ドリフト検出 (CLI 直。detect は非同期なのでポーリングが要る)
aws cloudformation detect-stack-drift --stack-name <stack-name>
aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id <id>
aws cloudformation describe-stack-resource-drifts --stack-name <stack-name> \
  --stack-resource-drift-status-filters MODIFIED DELETED

# ALB のエラー・レイテンシ (namespace AWS/ApplicationELB, dimensions LoadBalancer=<full-name>)
aws cloudwatch get-metric-statistics --namespace AWS/ApplicationELB \
  --metric-name HTTPCode_ELB_5XX_Count ...
```

注意: `cdk drift` は CloudFormation のドリフト検出を呼ぶ(実リソース vs スタックの期待状態)。`cdk diff` はローカルコード vs デプロイ済みテンプレートの比較で、別物。振り返りで使うのは drift。ドリフト検出に対応していないリソースタイプもあるため、「ドリフトなし」=「変更なし」とは限らない点も講評に書く。
