---
id: scenario-02
title: Aurora フェイルオーバー
type: observe
status: executed
fis_actions: [aws:rds:failover-db-cluster]
prerequisites: [aurora-reader-instance]
estimated_duration: 30m
difficulty: intermediate
---

## 学びの狙い

データ層のライター切替に対するアプリの回復挙動を観測する。**副次的な学び (リハーサルで判明): 観測手段の分解能がシナリオの成否を決める。**

## 定常状態の仮説

canary 成功率 100%、"/" (DB 疎通) が 200、DatabaseConnections が安定。

## 注入する障害

`aws:rds:failover-db-cluster` — 対象クラスタを ARN 指定 (実装: `GameDay-Fis` の `gameday-failover-db`)。

## 前提インフラ

- Aurora クラスタに**リーダーインスタンスが必要** (昇格先)。現行 app-stack は writer+reader 構成で充足
- **(未整備) 書き込みプローブ**: 現行の観測 (canary → "/" → `SELECT 1`) は読み取りのみ

## 期待する振る舞い

**実測 (2026-07-11): フェイルオーバーは約 43 秒で完了し、読み取りプローブ + リクエスト毎の短命接続では canary・15 秒ポーリングとも影響ゼロ。** 現行構成ではこのシナリオは「ユーザー影響が出ないことの検証」になる。書き込み断を可視化したい場合は `/write` エンドポイント + 書き込み canary を先に整備すること (このズレの経緯は実施記録を参照)。

## 観測ポイント

- canary SuccessPercent (現行構成では影響なしの確認)
- RDS イベント (フェイルオーバー開始・完了時刻、切替先) — **1 分未満の事象はここが一次資料**
- `describe-db-clusters` でライターの切替確認
- DatabaseConnections / TargetResponseTime

## 停止条件

`gameday-5xx-stop-condition`。

## 成功条件 / 失敗条件

- 成功: 参加者が RDS イベントからフェイルオーバーの事実と切替先を特定し、「ユーザー影響なし」を根拠付きで説明できる
- 失敗: 影響がないことを「何も起きていない」と誤認する (検知経路を持たない)

## 想定される弱点

接続プールを持つ実アプリでは stale connection により回復が遅れる (本アプリは per-request 接続のため最速で回復してしまう — 教材としては「実アプリとの差」を議論する材料)。

---
実施記録: [retrospectives/2026-07-11-rehearsal.md](../retrospectives/2026-07-11-rehearsal.md) — 仮説「503 が出る」は外れ。期待する振る舞いを実測に合わせて本ファイルで改訂済み。
