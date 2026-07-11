---
id: scenario-03
title: 単一 EC2 の突然死 → ECS への作り替えで復旧
type: rebuild
status: implemented
fis_actions: [aws:ec2:terminate-instances]
prerequisites: [legacy-ec2-app-stack, rebuild-materials, participant-build-role]
estimated_duration: 90m   # 実験自体は数分。検知 5 分 + 復旧ワーク 30〜60 分 + 前後観測・レポート窓込み
difficulty: intermediate
---

## 学びの狙い

SPOF (単一障害点) を「体感」し、復旧を**原状回復ではなくアーキテクチャ改善**で行う判断を学ぶ。

1. 単一 EC2 構成の脆さを、canary が赤いまま自己回復しない時間として体感する (scenario-01 の「30 秒で勝手に戻る」との対比)
2. 「同じ EC2 を建て直す」誘惑を退け、コンテナ化済みアプリを ECS (Fargate) サービス + ALB に作り替える構築スキルを身につける (タスク定義 / サービス / ターゲットグループ / SG / iam:PassRole)
3. 手動復旧リソースは IaC の管理外に残る (snowflake 化) — drift・棚卸し・IaC 反映の 3 点セットで回収する運用を学ぶ

## 定常状態の仮説

- canary `gameday-top` (向き先 = 出発点スタックの ALB) 成功率 100%
- ALB 5xx = 0、TargetResponseTime 安定
- ターゲットグループ HealthyHostCount = **1** — この「1」こそが SPOF の証拠。ブリーフィングで参加者に見せておく

## 注入する障害

`aws:ec2:terminate-instances` — 出発点スタックの単一 EC2 インスタンスを終了する。

- ターゲット: `aws:ec2:instance`、`resourceTags` で `GameDayScenario=03` に絞り、`filters` で出発点 VPC の VpcId も指定 (二重の絞り込み)。`selectionMode: COUNT(1)`
- パラメータ: なし (検証済み 2026-07-11、[FIS Actions reference](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html))
- 実験ロール権限: `ec2:TerminateInstances`, `ec2:DescribeInstances`。マネージドポリシー `AWSFaultInjectionSimulatorEC2Access` でも可だが広いので、`ec2:TerminateInstances` に `ec2:ResourceTag/GameDayScenario = 03` の Condition を付けた最小 inline を推奨 (IAM 側でも爆発半径を二重化)
- **爆発半径**: EC2 1 台のみ。該当タグの付いたインスタンスは環境全体で 1 台であることをタグ検索で事前確認する。本体の TargetApp (Fargate) には EC2 インスタンスが存在せず波及しない
- **実装注意**: terminate はワンショットで実験は数十秒で completed になる。`aws:fis:wait` を後ろに足さないこと — 待機中に 5xx アラーム (停止条件) が発火して実験が stopped になり、実験レポートが生成されなくなる。復旧までの長い観測は実験レポートの `postExperimentDuration: PT75M` (上限 2 時間、確認済み 2026-07-11) で窓に収める

## 前提インフラ

### 出発点アーキテクチャ (運営が別途用意する — 現行 app-stack とは別物)

**本体の `lib/constructs/target-app.ts` は既に Fargate desiredCount=2 であり、EC2 インスタンスは存在しない。本シナリオは学習用の出発点として、あえて SPOF 構成の別スタック (`GameDay-Legacy`) を運営が事前デプロイすることが前提。**

- ALB (internet-facing) + リスナー :80
- ターゲットグループは **必ず target type `ip`** で作成し、EC2 のプライベート IP を登録する。理由: Fargate タスク (awsvpc) は `ip` 型にしか登録できない。`instance` 型で作ると参加者が既存 TG を再利用できず詰む。`ip` 型なら「既存 TG に Fargate を載せる」「新 TG を作ってリスナーを切り替える」の両復旧経路が通る
- EC2 × 1 台 (単一 AZ、**Auto Scaling Group なし** = 意図した SPOF)。user data で Docker により ECR の app イメージを起動 (DB_HOST 等の環境変数 + Secrets Manager からの DB 認証情報取得)。タグ `GameDayScenario=03` (FIS ターゲット用)
- データ層: 本体 (TargetApp) の Aurora を共有するか専用に立てるかは実装判断。共有する場合、**TargetApp の Fargate サービスをこの ALB に載せないこと** (載せると SPOF でなくなり障害が成立しない)
- ヘルスチェック: `/healthz`、interval 15 秒、unhealthyThreshold 2 (検知を速くする)
- canary `gameday-top` の向き先 (環境変数の URL) をこの ALB に変更して再デプロイ。**復旧先も同じ ALB なので、canary の向き先変更はこの 1 回で済む**

### 復旧材料 (事前に存在しないと制限時間内に終わらない)

- ECR リポジトリ + `app/` のコンテナイメージ push 済み
- 空の ECS クラスタ (例: `gameday-rebuild`)
- タスク実行ロール作成済み (ECR pull / CloudWatch Logs / DB シークレットの `secretsmanager:GetSecretValue`)。タスクロールは不要 (アプリは AWS API を直接呼ばない)
- app 用セキュリティグループ (Aurora の SG が受信許可済み。出発点 EC2 も同じ SG を使っており、参加者はこれを流用する)
- CloudWatch Logs ロググループ事前作成 (`logs:CreateLogGroup` の権限ではまるのを防ぐ)
- **値のハンドアウト** (紙 or ダッシュボードのテキストウィジェット): イメージ URI / DB_HOST / DB_PORT / DB_NAME / シークレット ARN / app サブネット ID / SG ID / TG ARN / クラスタ名 / タスク実行ロール ARN

### 参加者権限 (participant-build-role)

- 付与: `ecs:RegisterTaskDefinition`, `ecs:CreateService`, `ecs:UpdateService` ほか ECS 操作一式、`elasticloadbalancing:CreateTargetGroup` / `ModifyListener` / `RegisterTargets` / `DescribeTargetHealth`、EC2 の Describe 系、CloudTrail / CloudWatch の読み取り、`iam:PassRole` (**事前作成のタスク実行ロールに限定**)
- 付与しない: `ec2:RunInstances` (「EC2 を建て直す」近道を封じ、ECS 化へ誘導する)、IAM ロール作成、対象スタック外への書き込み

## 期待する振る舞い

- **自己回復は起きない** (ASG なし)。これが本シナリオの核心
- 終了から 30〜60 秒でヘルスチェックが失敗し (15 秒 × 2 回)、ALB は 503/504 を返し始める。canary は次の実行 (1 分間隔) で赤転 — 終了から**遅くとも 2 分以内**
- `gameday-5xx-stop-condition` アラームも 1〜2 分で ALARM に遷移 (実験は既に completed のため停止対象はなく、検知信号として機能する)
- canary は参加者が復旧を完了するまで**赤のまま** — ダッシュボード `gameday-review` がそのまま進行表示になる
- 復旧予想: 中級者 1 チームで 30〜60 分。復旧完了 = 参加者が作った Fargate タスクが TG で healthy になり、canary が緑に戻る (ALB のターゲットが EC2 の IP から Fargate タスクの IP に入れ替わる)

## 復旧タスク (参加者が作るもの)

1. **状況確認 (目標 5 分)** — canary 赤 / ALB 503 / TG のターゲット unhealthy / EC2 が terminated であることを確認。CloudTrail の `TerminateInstances` イベントから実行者 (FIS の実験ロール) を特定する
2. **方針決定** — EC2 の再作成ではなく ECS 化を選ぶ (RunInstances は権限で封じてあるが、「なぜ再作成ではだめか」をチームで言語化してから進む)
3. **タスク定義の登録** — Fargate / awsvpc / CPU 256 / メモリ 512 / ハンドアウトのイメージ URI / ポート 80 / 環境変数 (DB_HOST, DB_PORT, DB_NAME) / シークレット (DB_SECRET) / タスク実行ロール / awslogs
4. **サービスの作成** — クラスタ `gameday-rebuild`、**desiredCount は 2 を推奨** (1 だと SPOF の作り直しになる)、app サブネット、既存 SG を流用、ALB 統合 (既存の `ip` 型 TG を選ぶ、または新規 TG を作ってリスナーを切り替える)
5. **復旧宣言** — TG で healthy を確認 → canary の緑転を確認してから宣言する (「動いたはず」での宣言は失敗条件)
6. **発展 (加点)** — 作った仕組みが「自動復旧する」ことの実証: タスクを 1 つ手で止め、ECS が自己補充して canary が緑のままであることを確認 (scenario-01 の再演)

## 段階ヒント (詰まったら 10 分刻みで開示)

- **ヒント 1 (+10 分 / 方針)**: 「同じものをもう一度建てる」と「二度と手で建て直さなくて済むようにする」は違う。落ちたら勝手に戻る仕組みは何か? アプリのコンテナイメージは既に ECR にある。
- **ヒント 2 (+20 分 / 使うサービス)**: ECS (Fargate) + ALB。クラスタとタスク実行ロールは用意済み (ハンドアウト参照)。順番はタスク定義 → サービス。サービス作成ウィザードの中で ALB に接続できる。
- **ヒント 3 (+30 分 / 具体手順)**: タスク定義の各フィールドはハンドアウトの値をそのまま使う。詰まりやすいのは 3 点 — (a) ターゲットグループの target type は `ip` (instance 型には Fargate を登録できない)、(b) セキュリティグループは既存の app 用 SG を流用しないと DB に届かず "/" が 503 になる、(c) サービス作成でエラーになるなら `iam:PassRole` のロール指定を確認。
- **最終ヒント (+45 分)**: 運営が画面共有でペア作業に切り替える。制限時間超過なら運営がサービス作成を完了させ、振り返りに移行する (中止プラン)。

## 観測ポイント

- **canary SuccessPercent の赤 → 緑** (ダッシュボード `gameday-review` が進行表示を兼ねる)
- **断面時刻の記録から MTTR を測る**: EC2 終了時刻 (FIS レポート / CloudTrail) → ALB 5xx 開始 → canary 赤転 → TG healthy → canary 緑転
- ALB `HTTPCode_ELB_5XX_Count` / TG HealthyHostCount (1 → 0 → 参加者の desiredCount)
- 参加者が作成した ECS サービスのイベント (タスク起動・TG 登録の時刻)
- **FIS 実験レポート (PDF)** — `postExperimentDuration: PT75M` で復旧完了までをレポート窓に収める (赤→緑の全過程が一次資料として残る)
- **drift + 棚卸し + IaC 反映の 3 点セット** (rebuild 型の振り返りの核):
  1. `cdk drift` は**出発点スタック (GameDay-LegacyApp) に対して**実行 — 終了した EC2 がドリフトとして出る。**参加者が作った ECS リソースはスタック外なので drift には出ない**ことを体験する
  2. 手動作成リソースの棚卸し — タグの付いていないリソースの検索 + CloudTrail の書き込み操作履歴 (この一覧がそのまま後片付けリストになる)
  3. IaC 反映ワーク (宿題) — 復旧構成を CDK 化する。種明かし: 答えはこのリポジトリの `lib/constructs/target-app.ts` とほぼ同型。手で 60 分かけた構成が `cdk deploy` 一発である事実が IaC の説得材料になる

## 停止条件

`gameday-5xx-stop-condition` を規約どおり設定する。ただし本アクションはワンショットで実験は数十秒で完了し、terminate は取り消せないため、**FIS の停止条件は実質的な安全装置にならない** (アラームは検知信号として活きる)。実質的な中止プランは運営ランブック側に置く:

- 制限時間超過 → 運営が ECS サービス作成を代行して復旧させ、振り返りへ
- 進行不能 (材料不備など) → 出発点スタックを再デプロイして EC2 を再作成 (ドリフトにより no-op になる場合はスタック削除 → 再作成)

## 成功条件 / 失敗条件

- **成功**:
  1. 検知 — canary / アラームの発報から 5 分以内に「EC2 が terminated」を EC2 コンソール + CloudTrail で特定できる
  2. 復旧 — 60 分以内に Fargate サービス経由で canary が緑に戻る
  3. 説明 — 「なぜ EC2 再作成ではなく ECS 化か」(SPOF の恒久対策、再発時は自己回復する) を根拠付きで説明できる
  4. 振り返り — 手動作成リソースの棚卸しリストが CloudTrail と突き合わせて完全である (IaC 反映ワークの入力になる)
- **加点**: desiredCount ≥ 2 で構築し、タスク 1 つの手動停止 → 自己補充 → canary 緑のままを実証する
- **失敗**: 60 分超過 (最終ヒント後も未達) / canary の緑転を確認せずに復旧宣言 / SG や PassRole で詰まったままヒントを使わない / 棚卸しに漏れがあり後片付けでリソースが残る

## 想定される弱点

- **手順知識**: TG の target type (`instance` / `ip`) の非互換、awsvpc タスクへの SG 割当、`iam:PassRole` — この 3 つが典型的な詰まりどころ (ヒント 3 で回収)
- **設計バイアス**: 「同じものを建て直す」への引力。MTTR 最短化と再発防止のトレードオフを議論できないチームは EC2 再作成を試みる (権限エラー自体が教材)
- **運用**: 手動復旧リソースは IaC 管理外に残り、次の変更で消される・二重管理になる (snowflake 化)。drift に「出ない」ことが盲点になる
- **出発点の設計そのもの**: ヘルスチェックが遅い・ASG がない・単一 AZ — 振り返りで「そもそも何が悪かったか」を列挙させる

## 後片付け

参加者の手動作成リソースは `cdk destroy` では消えない。棚卸しリストを流用して以下を消す:

1. 参加者作成分: ECS サービス (desiredCount 0 → 削除) / タスク定義 (deregister) / 新規作成した TG / リスナー変更の戻し
2. 運営側: 出発点スタック (GameDay-Legacy) を destroy、canary の向き先を本体 (TargetApp) の ALB に戻して再デプロイ、復旧材料 (ECR リポジトリ・クラスタ・実行ロール・ハンドアウト) の destroy
3. 確認: CloudTrail の書き込み操作履歴を GameDay 時間帯で横断確認し、消し漏れゼロを確認する (棚卸しの完全性がそのまま片付けの完全性)

---

## 実装 (status: implemented)

実装: `lib/legacy-app-stack.ts` (スタック名 `GameDay-Legacy`)。本体スタックとは独立してデプロイ・破棄できる。

```bash
npx cdk deploy GameDay-Legacy   # Docker デーモン必要 (app/ をイメージビルド)
# 出力 (ハンドアウト): AlbUrl / ExperimentTemplateId / RebuildImageUri / RebuildDbHost /
#   RebuildDbSecretArn / RebuildClusterName / RebuildTaskExecRoleArn / RebuildLogGroup /
#   RebuildTargetGroupArn / AppSecurityGroupId / AppSubnetIds
npx cdk destroy GameDay-Legacy  # 後片付け (手動作成した ECS リソースは別途削除)
```

設計からの実装上の決定 (シナリオ本文との差分):

- **canary / ダッシュボードは専用に持つ**: 本文は「gameday-top の向き先変更」としていたが、実装は自己完結性のため専用 canary `gameday-legacy-top` と ダッシュボード `gameday-legacy-review` を同スタックに持つ (observability-stack を汚さない)。
- **停止条件は手動 kill switch**: canary 赤が正常進行のため、canary 連動アラームは使わない。`gameday-legacy-abort` (カスタムメトリクス `GameDay/Abort` >= 1) を停止条件にする。緊急停止: `aws cloudwatch put-metric-data --namespace GameDay --metric-name Abort --value 1`。
- **参加者 IAM ロールは CDK で作らない**: 信頼ポリシー (誰が assume するか) が組織の ID 基盤 (SSO / IAM ユーザー等) に依存するため、CDK には含めず本文「参加者権限」節の記述を運営が環境に合わせて用意する。
- **データ層は専用 Aurora (ライターのみ)**: 本文の「既存 Aurora 共有」ではなく、独立デプロイのため専用の Aurora Serverless v2 を持つ。
- **アプリは HTTP (TLS なし)**: 学習用の使い捨てターゲットのため ALB は :80 のみ。本番構成ではない。
- 未実施: **ライブデプロイでの通し確認**。synth / unit test (`test/legacy-app.test.ts`) / lint は通過済み。初回デプロイ時に EC2 の user data (Docker 起動・ECR pull・シークレット取得) が実際に steady state に到達するかを要確認。
