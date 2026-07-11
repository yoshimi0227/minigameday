# GameDay 振り返り: Fargate タスク停止 + 応急処置ドリフトの実演 (scenario-01)

- 実施日時: 2026-07-11 23:32 – 23:36 (JST)
- シナリオ: `scenarios/01-stop-fargate-task.md`(drift 実演を追加した回)
- 実験テンプレート ID: `EXTAn5xUW7LkcwKAp`(stop-task) / `EXT4ZZGhyLiCmi4fr`(failover, B2 確認用)
- 実験 ID: **`EXP25ZpNYfB9QofuVTp`**(stop-task) / `EXPg3zcBPTsANmYgRY`(failover)
- 講評: Claude Code (`gameday-retrospective` スキル)。素材は `scripts/collect-retrospective.sh` で収集
- 目的: 「drift = コンソール応急処置の検出器」を実物で見せる。この回の主役は**障害そのものではなくドリフト**

## 仮説 (シナリオから転記)

- 定常状態の仮説: canary `gameday-top` 成功率 100%、ALB 5xx = 0、RunningTaskCount = 2
- 注入した障害: `aws:ecs:stop-task`(`GameDayTarget=true` タグのタスクを COUNT(1) で 1 つ停止)
- 期待した振る舞い: ECS が自己回復しユーザー影響なし。canary は失敗しない
- **追加要素(実演)**: インシデント中に運営が「慌てて」コンソールで desiredCount を 2→3 に上げる。この応急処置が drift に痕跡を残すはず

## 実験前ベースライン (23:2x JST)

- `cdk drift GameDay`: **No drift detected**(0 件)。以降のドリフトを実験・対応起因と断定できる
- canary 成功率: 直近 **100%**(RUNNING)
- 停止条件アラーム `gameday-5xx-stop-condition`: **OK**
- ECS: desired 2 / running 2、アプリ `/` = 200(DB 疎通)

## タイムライン (JST)

| 時刻 | 出来事 | ソース |
|---|---|---|
| 23:32:12 | stop-task 実験開始 | FIS `get-experiment` |
| 23:32:19 | **運営がコンソールで desiredCount 2→3 に緊急スケール(応急処置の演出)** | 手動 (ecs update-service) |
| 23:32:25–26 | `aws:ecs:stop-task` 実行・完了(対象タスク 1 個) | FIS 実験ログ |
| 23:32:26 | 実験 completed | FIS |
| 〜23:34 | `cdk drift` で `DesiredCount 2→3` を検出 | cdk drift |
| 23:34–23:36 | `cdk deploy --revert-drift` で desiredCount を 2 に戻す | CDK |
| 23:36 | `cdk drift` 再実行 → **No drift detected** | cdk drift |

## 観測結果

### 外形監視(ユーザーから見えた影響)= ゼロ

- canary `gameday-top`: 23:17–23:36 の全 run **PASSED**、SuccessPercent **100%** を維持
- ALB `/`: 実験を通して 200(DB 疎通あり)。stop-task はタスクを 1 つ落としただけで、残り 1 タスク + 自己補充で無停止

### メトリクス(顧客影響の量)= ゼロ

- ALB/Target 5xx: 実験窓で 0。顧客影響を示す 5xx は発生せず(停止条件アラームも終始 OK)

### ドリフト(応急処置の痕跡)← この回の主役

`cdk drift GameDay` の実出力:

```
Stack GameDay
Modified Resources
[~] AWS::ECS::Service TargetApp/Service/Service TargetAppServiceE810121B
 └─ [~] /DesiredCount
     ├─ [-] 2
     └─ [+] 3
1 resource has drifted from their expected configuration
✨  Number of resources with drift: 1 (16 unchecked)
```

- **CDK コードの `git diff`: 空**。参加者は CDK を直さず**コンソールで**対応した → IaC には痕跡が残らないが、**drift には残る**
- つまり「コンソールで直した応急処置」は git では不可視、drift 検出では可視。**この非対称性こそ drift 検出の価値**

### リセット(revert-drift)

`cdk deploy --revert-drift` 実行後、desiredCount は 2 に復帰し、再度の `cdk drift` は **No drift detected**。手動で入れた差分を、コードを唯一の正としてワンコマンドで巻き戻せることを実機で確認。

## 仮説と観測のズレ

1. **障害への自己回復(合致)**: 「ECS が自己回復・ユーザー影響なし」はそのとおり。canary 100% / 5xx 0
2. **応急処置は不要だった(=学びの核)**: desiredCount を上げる操作は**そもそも要らなかった**。ECS は 30 秒前後で自己補充するため、運営の「緊急スケール」は障害対応としては空振りで、残ったのは**構成ドリフトだけ**。「良かれと思った手動対応」が IaC との乖離を生む典型を、実データで可視化できた

## AI 講評

- **検知**: canary/5xx で「ユーザー影響なし」を即座に確認できる状態だった。にもかかわらず手動スケールに走ったのは過剰反応。**まず観測(canary 緑)を見て静観できたか**が分かれ目
- **対応の質**: コンソールでの desiredCount 変更は (a) 不要、(b) IaC 非整合(git diff に出ない)、(c) drift として残置、の三重に望ましくない。ただし**それを drift 検出が正しく捕捉し、`--revert-drift` で機械的に是正できた**点は運用として満点
- **IaC 整合性**: 復旧後に drift 0 を確認するまでが 1 セット。「直した」で終わらず「コードと一致するまで戻す」を回せている
- **総評**: 障害は無風、対応は過剰、しかし検出と是正の仕組みが効いた回。GameDay の主眼である「応急処置は drift で見え、コードで戻せる」を実演として成立させられた

## 学び

1. **drift は "コンソール応急処置" の検出器**。git diff(IaC 修正)と drift(手動修正)は補完関係で、両方見て初めて「誰がどう直したか」が分かる
2. **自己回復するものに手を出さない判断**の価値。canary 緑 = 静観の根拠
3. `cdk deploy --revert-drift` で手動ドリフトを機械的に巻き戻せる(実機確認済み)。次ラウンド前のリセットに使える
4. (B2 併せて確認)Aurora フェイルオーバーは一瞬 503(Target 5xx)を出すが、5xx 合計が閾値 10 未満のため停止条件は誤発火しない = ガードレールに余裕あり

## アクションアイテム

- [ ] 参加者ブリーフィングに「まず canary を見る/自己回復するものは静観」を明記(過剰反応の抑制)
- [ ] 「コンソール派 vs CDK 派」の対応を意図的に分けて実施し、drift と git diff の差を並べて見せる回を作る
- [ ] 停止条件の閾値(現状 10)を下げた「わざとガードレールを効かせる」回も選択肢として用意

## 添付

- FIS 実験ログ: CloudWatch Logs `/gameday/fis-experiments`(ストリーム `/aws/fis/EXP25ZpNYfB9QofuVTp`)
- CloudWatch ダッシュボード: `gameday-review`(ap-northeast-1)
- 収集素材: `scripts/collect-retrospective.sh EXP25ZpNYfB9QofuVTp` の出力
