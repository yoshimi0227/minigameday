---
id: scenario-01
title: Fargate タスクを 1 つ停止
type: observe
status: executed
fis_actions: [aws:ecs:stop-task]
prerequisites: []
estimated_duration: 20m
difficulty: beginner
---

## 学びの狙い

アプリ層の冗長性 (desiredCount=2 / minHealthyPercent=50) が実際に機能するかを、ユーザー目線 (canary) で確かめる。「壊れてもユーザーに見えない」を体験し、静観という対応の正当性を学ぶ。

## 定常状態の仮説

canary `gameday-top` 成功率 100%、ALB 5xx = 0、ECS RunningTaskCount = 2。

## 注入する障害

`aws:ecs:stop-task` — `GameDayTarget=true` タグのタスクから `COUNT(1)` で 1 つ停止。爆発半径はタスク 1 個 (実装: `GameDay-Fis` の `gameday-stop-one-task`)。

## 前提インフラ

なし (コントロールプレーン操作のため SSM サイドカー不要)。

## 期待する振る舞い

ECS がタスクを自動補充しユーザー影響なし。**実測: 停止から代替タスクのターゲット登録まで約 30 秒** (2026-07-11)。canary は失敗しない。

## 観測ポイント

- canary SuccessPercent (影響なしの確認)
- ECS RunningTaskCount (2→1→2) と ECS サービスイベント (停止・起動・登録の時刻)
- ALB HealthyHostCount / 5xx

## 停止条件

`gameday-5xx-stop-condition` (ELB+Target 5xx 合計 > 10/分)。

## 成功条件 / 失敗条件

- 成功: canary 全 PASSED のまま RunningTaskCount が 2 に自己復帰。参加者が ECS イベント等から 2 分以内に原因を特定し「静観」を宣言できる
- 失敗: canary が失敗する (冗長性の破れ)、または参加者が不要な操作 (手動タスク起動等) を行う

## 想定される弱点

デプロイ直後は 1 タスク構成になりがち (minHealthyPercent の誤解)。ヘルスチェック間隔が長いと登録が遅れる。

---
実施記録: [retrospectives/2026-07-11-rehearsal.md](../retrospectives/2026-07-11-rehearsal.md) — 仮説どおり影響ゼロ。回復は見積もり (数分) より速い約 30 秒。
