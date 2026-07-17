---
id: scenario-05
title: Fargate サービスの desiredCount=0 → 参加者が戻すまで復旧しない
type: rebuild
status: executed
fis_actions: [aws:ssm:start-automation-execution]
prerequisites: [ssm-automation-doc, fis-ssm-role]
estimated_duration: 40m   # 実験は数秒。検知 + 復旧ワーク (desiredCount を戻す) + 前後観測
difficulty: intermediate
round: 2
---

## 学びの狙い

対応ラウンド (R2) の入口。**自己回復しない障害**を体感し、人が手を動かして直すまで MTTR が伸び続けることを学ぶ。

1. scenario-01 (タスク停止 → 30 秒で自己回復) との対比で、「壊れたまま待っても戻らない」状態を体感する
2. 検知宣言 → 影響範囲の把握 → 復旧操作 (desiredCount を 2 に戻す) の一連を実際に手で行う
3. コンソールで直すと `cdk drift` に痕跡が出る / CDK で直すと git diff に出る、の違いを対応ラウンドでも確認する

## 定常状態の仮説

- canary `gameday-top` 成功率 100%、ALB 5xx = 0
- ターゲットグループ HealthyHostCount = **2** (Fargate desiredCount=2)

## 注入する障害

`aws:ssm:start-automation-execution` — SSM Automation ドキュメント (`aws:executeAwsApi` で `ecs:UpdateService desiredCount=0`) を実行し、Fargate サービスを 0 タスクに落とす。

- FIS には ECS の desiredCount を変えるネイティブアクションが無いため、SSM Automation 経由で実行する
- **復元ステップは入れない** = 実験が completed になってもサービスは 0 のまま。参加者が戻すまで復旧しない
- `maxDuration: PT1M`。自動化は数秒で終わり、fault の 5xx が停止条件 (5xx > 10) に達する前に実験は completed になる (停止条件で誤って止まらない)
- `faultDelayMinutes` の遅延 (aws:fis:wait) にも対応 — 障害の発生時刻をランダムにできる

## 期待する振る舞い

- desiredCount=0 → タスクがドレインし、ALB ターゲットが 0 → canary の "/" が 503 → 成功率が落ちる
- **自己回復しない**: ECS は desiredCount を勝手に戻さない。canary は赤のまま
- 参加者が desiredCount を 2 に戻す → タスク起動 → ターゲット healthy → canary 緑に復帰

## 観測ポイント

- canary 成功率 (外形監視) が赤に落ちて**戻らない**こと (scenario-01 との最大の違い)
- ターゲットグループ HealthyHostCount が 2 → 0 → (復旧後) 2
- ECS RunningTaskCount が 2 → 0 → 2
- ダッシュボード: 実験開始で armed → 503 で impacted → 検知宣言 → 復旧操作 → canary OK で recovered。MTTR = 影響開始 → 復旧が「人の対応時間」を実測する
- `cdk drift`: 障害中は `AWS::ECS::Service` の DesiredCount が 0 vs 期待 2 のドリフト。復旧 (2 に戻す) 後はクリーン

## 停止条件

既存の `gameday-5xx-stop-condition` (5xx > 10)。ただし実験は数秒で completed になるため、実運用では停止条件が発火する前に実験は終わっている (fault は残る)。手動で止めたいときは FIS コンソールから stop-experiment。

## 復旧タスク (参加者)

canary が緑に戻れば成功。復旧手段は自由:

- **A. コンソール / CLI**: `aws ecs update-service --cluster <cluster> --service <service> --desired-count 2` (速いが drift に残る)
- **B. CDK**: desiredCount は既にコードで 2 なので、`cdk deploy` で期待状態に戻す (drift を解消)

運営はどちらを選んだか (と所要時間) を記録する。

## 段階ヒント (ポイント消費)

- 方針 (cost 5): 「まず ECS サービスの desiredCount と RunningTaskCount を見る」
- 使う道具 (cost 10): 「ecs update-service で desiredCount を戻せる」
- 具体手順 (cost 20): 「`aws ecs update-service --cluster <名> --service <名> --desired-count 2`」

## 成功・失敗条件

- 成功: canary が緑に復帰し、HealthyHostCount が 2 に戻る
- 一部達成: 復旧はしたが手段が場当たり的 (drift を残したまま棚卸し未了)
- 失敗: 制限時間内に復旧できない

## 想定される弱点

- desiredCount を戻す操作をコンソールでやると、実験前の期待状態 (2) に戻るだけなので復旧後の drift は消える。「コンソール vs CDK の判別」は R1・scenario-03 側が担い、R2 の主眼は「人が直すまで赤 = MTTR 実測」に置く
- 後片付け: 実験後に念のため `cdk drift` を確認し、desiredCount が 2 に戻っていること

## 後片付け

- 復旧漏れがあれば `aws ecs update-service ... --desired-count 2` または `cdk deploy`
- `cdk drift` で "No drift detected" を確認
