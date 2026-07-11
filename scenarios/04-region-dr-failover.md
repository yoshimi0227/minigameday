---
id: scenario-04
title: 東京リージョン障害 (模擬) → 大阪へ DR 切替
type: rebuild
status: draft
fis_actions: [aws:network:disrupt-connectivity]
prerequisites:
  - dr-standby-osaka          # 大阪 (ap-northeast-3) の VPC + ALB + Fargate 一式 (縮小構成で常時稼働)
  - aurora-global-database    # 既存 Aurora を Global Database 化し大阪にセカンダリクラスタ
  - route53-hosted-zone       # 運営保有ドメインの public hosted zone + app レコード (ALIAS, 東京 ALB)
  - canary-dns-target         # canary の URL 環境変数を ALB DNS 名 → Route 53 レコード名に変更
  - participant-iam-role      # 参加者用ロール (Route 53 変更 + RDS フェイルオーバーのみ許可)
estimated_duration: 90m
difficulty: advanced
---

> **これは「リージョン障害の模擬」であり、本物のリージョン障害ではない。**
> AWS FIS にリージョン全体を落とすアクションは存在しない。本シナリオでは
> `aws:network:disrupt-connectivity` (scope=all) で **GameDay VPC の全サブネットを
> ネットワーク遮断**し、「東京のアプリが全面的に使えない」状態を作る。
> 遮断されるのは VPC のデータプレーンだけで、**RDS のコントロールプレーンと
> Aurora Global Database のストレージレベルのレプリケーションは生きたまま**である
> (本物との差は「学びの狙い」「想定される弱点」参照)。
>
> **ゲームルール: 東京リージョンの GameDay VPC 内リソースへの修復操作は禁止**
> (クローン NACL の付け替え直しは反則)。「東京リージョンは当面復旧見込みなし」という
> 設定で進行する。参加者 IAM ロールから EC2 書き込み権限を外して技術的にも抑止する。

## 学びの狙い

- **DR (ディザスタリカバリ) の意思決定と実行を体験する**: 「復旧を待つ」のをやめ「DR を発動する」判断は誰がいつ下すのか。切り替えるべき箇所は「データ (DB)」と「入口 (DNS)」の 2 つだけであることを、手を動かして確かめる。
- **RPO / RTO を実測で理解する**: RTO = canary が赤になった時刻 → 緑に戻った時刻 (ダッシュボードで実測できる)。RPO = 失われるデータ量 = フェイルオーバー時点のレプリケーション遅延 (`AuroraGlobalDBReplicationLag`)。目標 (RTO 45 分 / RPO 数秒) と実測を突き合わせる。
- **DR 戦略の 4 分類を自分の構成に当てはめる**: 本構成は **ウォームスタンバイ** (縮小版フルスタックを常時稼働)。バックアップ&リストア / パイロットライト / ウォームスタンバイ / マルチサイト・アクティブアクティブ の RTO・RPO・コストのトレードオフを、振り返りで「この構成をパイロットライト化したら RTO はどれだけ延び、コストはいくら下がるか」という形で議論する。
- **読み取りプローブの限界 (scenario-02 の学びの続き)**: canary の "/" は `SELECT 1` (読み取り) なので、**canary が緑でも書き込みが復旧した証明にはならない**。復旧宣言には「大阪クラスタがライターに昇格した」確認を別途要求する。
- **模擬と本物の差を言語化する**: この模擬ではレプリケーションが実際には切れないため RPO は 0 に見える。本物ではフェイルオーバー時点の遅延分が失われる。「実験が再現できていないもの」を認識することもカオスエンジニアリングの学び。

## 定常状態の仮説

- canary `gameday-top` (向き先: `http://app.<domain>` = Route 53 レコード経由で東京 ALB) 成功率 100%
- 東京: ALB HealthyHostCount = 2、5xx = 0
- 大阪スタンバイ: ALB (直接 URL) が応答する。ECS RunningTaskCount = 1
- Aurora Global Database: 東京がプライマリ、`AuroraGlobalDBReplicationLag` (大阪側) < 1 秒
- Route 53: `app.<domain>` の ALIAS A レコードが東京 ALB を指す

## 注入する障害

`aws:network:disrupt-connectivity`

| 項目 | 値 |
|---|---|
| アクション | `aws:network:disrupt-connectivity` |
| パラメータ | `scope: all`、`duration: PT60M` (= 制限時間。後述) |
| ターゲット | `aws:ec2:subnet`、`selectionMode: ALL`、**GameDay AppStack の VPC に限定** (VPC ID フィルタ、またはサブネットへの `GameDayTarget=true` タグ) |
| 爆発半径 | **東京の GameDay VPC の全サブネット (2 AZ × public/app/data = 6 つ) のみ**。仕組みはクローン NACL (`managedByFIS=true` タグ付き) の一時付け替えで、実験終了時に FIS が自動復元する。他 VPC・他リージョン・AWS コントロールプレーンには波及しない |

`duration` を制限時間と同じ **60 分固定**にする理由:

1. **FIS 実験レポートは手動停止 (キャンセル) では生成されない**。自然終了させて振り返りの一次資料 (PDF) を確保する。
2. 60 分経過で東京が自動復旧する = **後片付けの安全網**。ただし未切替のまま 60 分を迎えて canary が緑に戻っても、それは「東京の自動復旧」であって DR 成功ではない (成功条件参照)。

実装メモ (fis-experiment スキル向け): 実験ロールにはマネージドポリシー `AWSFaultInjectionSimulatorNetworkAccess` + `cloudwatch:DescribeAlarms`。`experimentReportConfiguration` は `gameday-review` ダッシュボード + 前後 `PT10M` を指定する。

## 前提インフラ

**DR スタンバイは事前に存在しないとこのシナリオは成立しない** (数十分で新規リージョンにフルスタックは構築できない)。以下を運営が GameDay 前日までにプロビジョニングする。

1. **大阪 (ap-northeast-3) の DR アプリスタック** — 縮小版ウォームスタンバイ
   - VPC (public/app/data)、ALB、Fargate サービス (desiredCount=1)、同一アプリイメージ
   - CDK で `dr-app-stack` として ap-northeast-3 にデプロイ (要 `cdk bootstrap ap-northeast-3`。イメージアセットは大阪側ブートストラップ ECR に自動で入る)
   - DR アプリの `DB_HOST` は**大阪セカンダリクラスタの cluster endpoint** を指す
2. **Aurora Global Database 化** — 既存 app-stack の Database を Global Database のプライマリにし、大阪にセカンダリクラスタ (Serverless v2, 0.5 ACU, リーダー 1 台) を追加。Aurora MySQL 3.10.4 は東京・大阪とも Global Database 対応を確認済み (2026-07-11)
3. **Route 53 public hosted zone** — 運営保有のドメイン。`app.<domain>` の **ALIAS A レコード → 東京 ALB** (ALIAS のため TTL は実質 60 秒)。シンプルルーティングのまま置く (フェイルオーバールーティングを事前設定してしまうと自動切替になり、参加者の仕事がなくなる)
4. **canary の向き先変更** — observability-stack の canary URL 環境変数を `http://<東京ALB DNS>` から `http://app.<domain>` に変更。**これにより参加者の DNS 切替だけで canary が緑に戻り、復旧完了が自動判定できる**
   - *ドメインが用意できない場合のフォールバック (Plan B)*: canary は東京 ALB 直指しのままにし、参加者の切替タスクを「`aws synthetics update-canary` で canary の URL 環境変数を大阪 ALB に変更する」に置き換える (= ユーザー告知による URL 変更、という設定の劣化 DR)。この場合 canary の変更が cdk drift に出る
5. **参加者 IAM ロール** — 与える: 対象 hosted zone への `route53:ChangeResourceRecordSets` / `route53:List*`、`rds:FailoverGlobalCluster`・`rds:RemoveFromGlobalCluster` (対象クラスタ限定)・`rds:Describe*`、`ecs:Describe*/List*`、`elasticloadbalancing:Describe*`、CloudWatch / Synthetics の読み取り。与えない: EC2 書き込み系 (NACL 修復 = 反則の抑止)、`fis:StopExperiment` (運営専用)
6. **運営用 kill switch** — カスタムメトリクス `GameDay/Abort` に対するアラーム `gameday-manual-abort` (>= 1 で ALARM、`treatMissingData: notBreaching`)。停止条件セクション参照
7. (推奨) `gameday-review` ダッシュボードに大阪 ALB の RequestCount / HealthyHostCount のクロスリージョンウィジェットを追加 — FIS レポートに大阪側の回復も写り込む

**コスト注意 (スタンバイも課金される)**: 大阪側は ALB (~0.03 USD/h) + NAT (~0.06 USD/h) + Fargate 1 タスク (~0.02 USD/h) + Aurora Serverless v2 0.5 ACU (~0.10 USD/h) で**目安 0.2 USD/h ≒ 150 USD/月**。加えて Global Database のレプリケーション I/O とクロスリージョン転送、hosted zone 0.50 USD/月 + ドメイン代。**GameDay 当日に合わせてデプロイし、振り返り後に destroy する運用を基本とする** (これ自体が「ウォームスタンバイの維持費」という学びの材料)。

## 復旧タスク (参加者のミッション)

**制限時間 60 分。コンソール / CLI での操作を正とする。IaC 化は振り返りの宿題。**

1. **検知と切り分け**: canary 赤・東京 ALB タイムアウトを確認し、「東京の GameDay 環境が全面不通」と切り分ける (何分かかったか記録)
2. **DR 発動の宣言**: 「東京の復旧を待つ」のではなく「大阪に切り替える」と口頭で宣言し、時刻を記録する (意思決定の演習)
3. **データ層の切替**: Aurora Global Database を大阪へフェイルオーバーし、大阪クラスタが**ライター**になったことを確認する
4. **入口の切替**: Route 53 の `app.<domain>` を大阪 ALB の ALIAS に変更する
5. **復旧確認**: canary が緑に戻ったことをダッシュボードで確認し、復旧宣言 (RTO を記録)

## 期待する振る舞い

| 時刻 (目安) | 事象 |
|---|---|
| T+0 | FIS 開始。1 分以内にクローン NACL が全サブネットに適用され、東京 VPC が外部から不通に |
| T+1〜3 分 | canary が赤に (1 分間隔 + タイムアウト。2〜3 回目の実行までに確実に失敗)。**canary の赤がゲームの進行表示になる** |
| T+3〜10 分 | 参加者が検知・切り分け。東京側では ALB ヘルスチェック失敗 → ECS タスク入替ループが始まる (イメージ取得も不通のため起動失敗が続く) — **これは放置してよい。実験終了後に自己回復する** |
| T+10〜40 分 | DR 発動: Aurora フェイルオーバー (昇格自体は数分)、Route 53 切替 (ALIAS 反映 + TTL で数分) |
| 切替後 2〜3 分 | canary が緑に復帰 = 復旧。**RTO 実測は赤の初回 → 緑の初回で 20〜45 分を想定** |
| T+60 分 | FIS 実験が自然終了し NACL 自動復元。東京 ECS は数分で RunningTaskCount=2 に自己回復 |

模擬ゆえの注意: 東京の RDS は実際には健在なので、`failover-global-cluster --allow-data-loss` は即座に成功し、データ損失も起きない (本物ではレプリケーション遅延分を失う)。また昇格前でも大阪アプリの "/" (読み取り) が 200 を返す可能性がある — **昇格前後の大阪アプリの挙動はリハーサルで実測して本欄を更新すること**。いずれにせよ canary 緑だけでは書き込み復旧の証明にならない。

## 段階ヒント (詰まったら 10 分刻みで開示)

- **ヒント 1 (T+10, 方針)**: 東京は当面復旧しない。運営が大阪リージョンにスタンバイ一式を用意してある。切り替えるべきは 2 つ — 「データ (DB) の書き込み先」と「ユーザーの入口 (DNS)」。まず大阪のコンソールで何があるか棚卸しせよ。
- **ヒント 2 (T+20, 使うサービス)**: DB は Aurora **Global Database** になっている。RDS コンソールでグローバルクラスタを選び「Fail over global database」(計画外・データ損失許容) で大阪をプライマリに昇格させる。入口は Route 53 の hosted zone にある `app.<domain>` レコード — 向き先を大阪 ALB の ALIAS に変えれば、canary (と利用者) はそのまま新しい環境に流れる。
- **ヒント 3 (T+30, 具体手順)**:

  ```bash
  # 1. 大阪 ALB の DNS 名を確認
  aws elbv2 describe-load-balancers --region ap-northeast-3 \
    --query 'LoadBalancers[].{name:LoadBalancerName,dns:DNSName,zone:CanonicalHostedZoneId}'

  # 2. Aurora を大阪へ計画外フェイルオーバー (本物の DR 手順。この模擬では即成功する)
  aws rds failover-global-cluster --region ap-northeast-1 \
    --global-cluster-identifier <global-cluster-id> \
    --target-db-cluster-identifier <大阪クラスタの ARN> \
    --allow-data-loss
  # 昇格確認: 大阪が IsWriter=true になるまで待つ
  aws rds describe-global-clusters --query 'GlobalClusters[].GlobalClusterMembers'

  # 3. Route 53 レコードを大阪 ALB の ALIAS に変更
  aws route53 change-resource-record-sets --hosted-zone-id <zone-id> \
    --change-batch '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{
      "Name":"app.<domain>","Type":"A",
      "AliasTarget":{"HostedZoneId":"<大阪ALBのCanonicalHostedZoneId>",
                     "DNSName":"<大阪ALBのDNSName>","EvaluateTargetHealth":false}}}]}'

  # 4. canary が緑に戻るのをダッシュボードで確認
  ```

## 観測ポイント

- **canary `gameday-top` SuccessPercent** — 赤→緑の時刻が RTO の実測値。進行表示と復旧判定を兼ねる
- **FIS 実験レポート (PDF)** — `gameday-review` ダッシュボード + 前後 10 分のスナップショット。振り返りの一次資料 (自然終了させないと生成されない点に注意)
- **`AuroraGlobalDBReplicationLag`** (大阪側) — 平常時の値が「本物なら失われた RPO」の根拠。模擬中も切れないこと自体が議論の材料
- **`aws rds describe-global-clusters`** — フェイルオーバー前後の `IsWriter` の変化 (書き込み復旧の証拠)
- 大阪 ALB の RequestCount / HealthyHostCount — 切替後にトラフィックが移った証拠
- 東京 ECS サービスイベント — 障害中のタスク入替ループと、実験終了後の自己回復の記録
- **CloudTrail** — `ChangeResourceRecordSets`, `FailoverGlobalCluster` の実行時刻 (誰が・いつ・何をしたか = 手動変更の棚卸しの素材)
- **`cdk drift`** — Route 53 レコードが CDK 管理なら切替が drift として出る。大阪 `dr-app-stack` も別途 drift 検出する。参加者の操作はスタック外リソースには及ばないため、drift + CloudTrail 棚卸し + IaC 反映ワークの 3 点セットで振り返る

## 停止条件

**このシナリオでは canary ベースの停止条件を意図的に使わない。** rebuild 型では「canary が赤」が正常なゲーム進行であり、canary 連動アラームを停止条件にすると開始直後に実験が自動停止してしまう。既存の `gameday-5xx-stop-condition` は形式上アタッチするが、トラフィックが ALB に届かない本障害では発火しない (発火しないことも記録する)。

- **主停止手段 (運営)**: kill switch アラーム `gameday-manual-abort` を停止条件に設定。緊急時は運営が
  `aws cloudwatch put-metric-data --namespace GameDay --metric-name Abort --value 1`
  で発火させる。`aws fis stop-experiment` でも即時停止できる (どちらも NACL は自動復元されるが、**FIS レポートは生成されない**)
- **安全網**: アクション duration = PT60M。何もしなくても 60 分で自動復元される

## 成功条件 / 失敗条件

**成功** (すべて満たす):

1. 参加者が canary 赤から **5 分以内**に「東京の GameDay 環境が全面不通」と切り分け、**15 分以内**に DR 発動を宣言する (検知経路: canary 2 連続失敗 + 東京 ALB への直接アクセス不能)
2. 制限時間 60 分以内に canary が緑に復帰する (= Route 53 経由で大阪に到達。RTO 実測 ≤ 45 分なら優秀)
3. 復旧宣言に **canary 緑 + 大阪クラスタが `IsWriter=true`** の 2 つの根拠が揃っている (読み取りプローブだけで「全復旧」と言わない)
4. 実施した手動変更を参加者自身が列挙できる (Route 53 変更、RDS フェイルオーバー、その他)

**失敗**:

- 60 分以内に切替が完了しない (T+60 の東京自動復旧で canary が緑に戻っても DR 成功とは認めない)
- 東京 VPC の修復 (NACL 操作等) を試みる — ルール違反。IAM で拒否されるが、試みた時点で振り返りの議題にする
- canary 緑のみを根拠に復旧宣言する (書き込み復旧の確認漏れ)

## 後片付け

DR 切替後の状態を放置すると「大阪がプライマリ・東京が空回り」のまま課金が続く。振り返りの前後で以下を実施する。

1. **実験終了の確認** (T+60 自然終了後): `managedByFIS=true` タグの NACL が東京 VPC に残っていないこと、東京 ECS が RunningTaskCount=2 に自己回復し東京 ALB が 200 を返すことを確認
2. **データ層のフェイルバック**: managed failover を使っていれば、東京復旧後に旧プライマリは自動でセカンダリとして再組込みされる。レプリケーション再確立を待ち、**計画切替 (switchover, RPO 0)** で東京をプライマリに戻す:
   `aws rds failover-global-cluster --global-cluster-identifier <id> --target-db-cluster-identifier <東京クラスタ ARN> --switchover`
   ※ 参加者が detach-and-promote (`remove-from-global-cluster`) で復旧した場合はこの自動再組込みが効かず、大阪の昇格済みクラスタを削除してセカンダリを作り直す必要がある (managed failover を推奨する理由)
3. **入口のフェイルバック**: Route 53 の `app.<domain>` を東京 ALB の ALIAS に戻す → canary が緑のままであること (= 切り戻しでもユーザー影響なし) を確認。Plan B の場合は canary の URL 環境変数を戻す (`cdk deploy` で正に戻すのが確実)
4. **手動変更の棚卸し**: CloudTrail から `ChangeResourceRecordSets` / `FailoverGlobalCluster` / (`UpdateCanary`) を抽出し、変更一覧を作る。東京・大阪の両スタックで `cdk drift` を実行し、棚卸しと突き合わせる
5. **IaC 反映ワーク (宿題)**: 今日手動でやった切替を CDK に落とすとしたら — Route 53 フェイルオーバールーティング + ヘルスチェックによる自動化、DR スタックの本管理化 — を振り返りで設計させる
6. **コスト後始末**: GameDay 終了後、大阪 `dr-app-stack` を destroy する (Global Database は先に大阪セカンダリを detach/削除してからクラスタを消す)。継続開催するなら「パイロットライト化 (大阪の Fargate を 0 タスク・DB インスタンスなしにする)」のコスト試算を宿題に含める

## 想定される弱点

- **DR 手順が存在しない / 属人化**: 「どこを切り替えれば復旧するのか」を誰も即答できず、切り分けだけで 20 分溶ける (→ ランブックの必要性)
- **DNS 直書きの発見**: canary や利用者がレコード名でなく ALB DNS 名を直接参照していると DNS 切替では救えない (Plan B はまさにこの弱点の疑似体験)
- **読み取り復旧と書き込み復旧の混同**: canary 緑で復旧宣言してしまい、ライター昇格の確認が漏れる (scenario-02 の学びの再演)
- **TTL / キャッシュの見落とし**: レコード TTL が長いと切替が「効かない」ように見える (本構成は ALIAS で 60 秒だが、実世界では数時間の TTL が刺さる)
- **スタンバイの構成ドリフト**: 大阪側がいつの間にか古いイメージ・古い設定のままで、切り替えたら動かない — スタンバイも継続的にテストする必要 (まさにこの GameDay がそのテスト)
- **模擬の限界**: レプリケーションと RDS コントロールプレーンが生きているため、フェイルオーバーが本物より確実・高速に成功する。「本物のリージョン障害では RDS API 自体が東京で応答しない可能性がある」ことを振り返りで必ず補足する
