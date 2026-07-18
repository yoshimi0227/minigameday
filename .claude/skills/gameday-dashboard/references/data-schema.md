# gameday.json スキーマ

`dashboard/public/data/gameday.json` の構造。1 ファイル = 1 回の GameDay。
過去回をアーカイブする場合は `dashboard/public/data/archive/YYYY-MM-DD.json` にコピーしてから書き換える。
なお **`npm run reset` (周回リセット) は自動で `dashboard/data-archive/gameday-<stamp>.json` に退避する** —
手動アーカイブ (public/data/archive = 画面から参照しうる公開用) とは別系統なので混同しない。

## トップレベル

```jsonc
{
  "event":    { /* 開催情報 */ },
  "systems":  [ /* お題システムの構成図 + 補足 (参考資料)。シナリオ追加と連動して増やす */ ],
  "injects":  [ /* インジェクト = 運営からの指示と、その対応・採点 */ ],
  "feedback": [ /* KPT フィードバック */ ],
  "hintReveals": [ /* ヒント開示の記録 (dev サーバが追記) */ ],
  "rounds":   [ /* ラウンドの見出し (任意。R1 観察 / R2 対応) */ ],
  "scoring":  { /* 自動採点のカーブ設定 (任意。無ければ既定値) */ },
  "escalation": { /* エスカレーションの運用スイッチ (任意。無ければ有効) */ },
  "events":   [ /* ゲームイベントログ (gameEventsSync が追記。手編集しない) */ ]
}
```

## rounds (ラウンドの見出し — 任意)

2 ラウンド制 (R1=観察 / R2=対応) の見出しと説明。`inject.round`(number)と結ぶ。無ければ inject の
round 番号だけでグルーピング表示される。観察ラウンド = 自己回復する障害 (静観・判断の練習)、
対応ラウンド = 自己回復しない障害 (人が直すまで復旧しない)。

```jsonc
"rounds": [
  { "round": 1, "title": "観察ラウンド", "description": "自己回復する障害。静観・判断の練習" },
  { "round": 2, "title": "対応ラウンド", "description": "自己回復しない障害。人が直すまで復旧しない" }
]
```

## event

| フィールド | 型 | 説明 |
|---|---|---|
| `title` | string | 画面ヘッダに表示 |
| `date` | string | `YYYY-MM-DD` |
| `team` | string | 参加チーム名 (任意) |
| `note` | string | フィルタ行に出る補足 (任意) |

## systems[] (システム構成 — 参考資料)

本物の GameDay で配られる「元のシステム構成図」に相当。画面では折りたたみ可能なカードに
タブ (システムごと) + 構成図 (層を点線ボックス、リソースをチップで描画) + 補足が出る。
シナリオフィルタを選ぶと `scenarioIds` が一致するシステムのタブへ自動で切り替わる。

**シナリオと連動して増やす**: 新規シナリオを追加したら必ずここも更新する
(既存システムが対象なら `scenarioIds` に id を追加、新しい出発点スタックなら system を新規追加)。
手順は add-scenario スキル参照。

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | 一意 (例 `gameday-main`) |
| `name` | string | タブに出る短い名前 |
| `summary` | string | システムについての軽い補足 (何をするアプリか。1〜3 文) |
| `scenarioIds` | string[] | このシステムを対象とするシナリオ id。フィルタ連動のキー |
| `tiers` | Tier[] | 構成図の層。配列の順に上から下へ矢印でつなぐ |
| `notes` | string[] | 箇条書きの補足 (観測手段・ハンドアウト・既知の死角など。任意) |

### systems[].tiers[]

| フィールド | 型 | 説明 |
|---|---|---|
| `name` | string | 層の名前 (例 `アプリ層 — app サブネット`、`東京 ap-northeast-1 (プライマリ)`) |
| `icon` | string | 層のグループアイコンのキー (任意)。`public-subnet` / `private-subnet` / `vpc` / `region` / `aws-cloud` |
| `nodes` | Node[] | 層に属するリソース |
| `note` | string | 層への補足 (任意。レプリケーション経路や復旧材料など) |

### systems[].tiers[].nodes[]

| フィールド | 型 | 説明 |
|---|---|---|
| `service` | string | サービス名 (例 `ALB` / `ECS Fargate`) |
| `icon` | string | AWS 公式アイコンのキー (任意)。下の一覧参照。キーが無い/不明でもアイコン無しで描画され壊れない |
| `label` | string | 一言補足 (任意。例 `internet-facing / HTTP:80`) |
| `count` | number | 台数 (任意)。2 以上で `×N` バッジが出る |

### アイコン (AWS 公式アーキテクチャアイコン)

構成図は AWS 公式アイコン (npm `aws-icons` パッケージの SVG) で描く。キーの定義は
`dashboard/src/awsIcons.ts` の `AWS_ICONS`。現在使えるキー:

- ノード用: `users` `client` `synthetics` `alarm` `cloudwatch` `alb` `ecs` `fargate` `ec2`
  `aurora` `rds` `route53` `secrets-manager` `fis` `dynamodb` `lambda` `s3`
  `nat-gateway` `internet-gateway`
- 層 (グループ) 用: `aws-cloud` `region` `vpc` `public-subnet` `private-subnet`

**新しいサービスのアイコンが要るとき**は `node_modules/aws-icons/icons/` から該当 SVG を探し、
`awsIcons.ts` に import + キー登録してから JSON で使う (シナリオ追加でノードが増えるときの連動作業)。

書くときの指針:

- **「元の構成」= 障害注入前の定常状態**を描く。どこに障害を入れるかは書かない (検知が試験項目)。
- ただし観測手段 (canary 名・ダッシュボード名・停止条件アラーム) は書く — 参加者が「正しい観測から気づく」ための参考資料なので。
- 未構築の予定構成を載せる場合は `summary` に「未構築」と明記する。

## injects[]

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | `inject-1` 形式。一意 |
| `scenarioId` | string \| null | `scenarios/` のシナリオ id (`scenario-01` 等)。フィルタと振り返りの突き合わせに使う |
| `round` | number | ラウンド番号 (1=観察 / 2=対応)。スコア表のグルーピング・小計とラウンドフィルタに使う。採点には影響しない。未設定なら「ラウンド未分類」 |
| `time` | string | 指示を出した実時刻 `HH:MM` |
| `title` | string | 一言タイトル (チャートの行ラベルにもなる。13 文字程度まで) |
| `instruction` | string | 運営が出した指示の内容 |
| `response` | string | チームの対応の記録。いつ・誰が・何をしたか。手動対応は必ず明記 (drift との突き合わせ用) |
| `status` | string | 手動確定: `success` / `partial` / `failed` / `pending`。ライブ状態 (sync が導出): `armed` (実験進行中) / `impacted` (影響発生中) / `recovered` (復旧済み)。**手動確定値は自動導出に上書きされない** |
| `detectionMinutes` | number | 影響開始から検知宣言までの分。自動記録された inject では sync が再計算する (手入力は上書きされ得る → 補正は `scoreOverride` で) |
| `recoveryMinutes` | number | 影響開始から復旧までの分。同上 |
| `score` | number | 手動採点の素点 (ヒント消費前)。**自動採点が成立した inject では自動値が優先**される |
| `maxScore` | number | 満点 (通常 100) |
| `notes` | string | 採点理由・気づき (任意) |
| `hints` | Hint[] | 段階ヒント (任意)。ポイント消費で開示。下記参照 |

### injects[] の自動採点フィールド

自動採点 (検知宣言 + アラーム復旧) に使うフィールド。**手書きしてよいもの**と
**sync (dev サーバ) が管理するもの**を区別する:

| フィールド | 型 | 誰が書くか | 説明 |
|---|---|---|---|
| `experimentTemplateId` | string | **運営 (セットアップ時)** | FIS 実験テンプレート ID (deploy 出力)。イベントと inject の突き合わせキー。これが無いと自動記録されない |
| `commsScore` | number | **運営 (ゲーム中〜終了時)** | 伝達・記録の点数 0〜20 (ルーブリックで判断して手動記入) |
| `scoreOverride` | number | **運営 (最終裁定)** | これがあると自動採点・手動 score より優先。帰属ミスや特殊事情の補正に使う |
| `experimentId` | string | sync | 実際に走った FIS 実験 ID |
| `experimentStartedAt` | string | sync (取り逃し時のみ手書き可) | FIS running の時刻 = armed。FIS イベントは best effort 配信なので、来ないときはここを手書きすれば同じに動く |
| `impactStartAt` | string | sync | canary アラーム ALARM の時刻 = 影響開始 |
| `recoveredAt` | string | sync | 最後の ALARM より後の最後の OK = 復旧 (フラッピング対応) |
| `ackAt` | string | /api/ack (検知宣言ボタン) | 検知宣言の時刻。最初の 1 回だけ有効 |

**自動採点の素点** = 検知点 (impactStartAt→ackAt の速さ) + 復旧点 (impactStartAt→recoveredAt の
MTTR) + `commsScore`。3 タイムスタンプが揃わないうちは未確定で、`score` (手動) にフォールバック
する。canary に映らない障害 (読み取りプローブの死角など) は自動採点できないので手動採点する。
優先順位: `scoreOverride` > 自動採点 > `score`。計算ロジックは `dashboard/src/scoring.ts` が唯一の正。

## injects[].hints[] (段階ヒント)

参加者がポイントを消費して開示するヒント。開示すると `cost` が獲得スコアから引かれ、
実効スコア = `score − 開示済みヒントの cost 合計` (0 下限) がタイル・スコアセルに反映される。
scenarios の「段階ヒント (詰まったら 10 分刻みで開示)」をポイント制にしたもの。cost は
方針 < 使う道具 < 具体手順 のように上げていくとよい。

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | 一意 (例 `h1-1`)。開示状態のキー。**変更・再利用しない** (localStorage に紐づく) |
| `label` | string | 短い名前 (例 `方針` / `使う道具` / `具体手順`) |
| `cost` | number | 消費ポイント。開示するとこの分スコアから引かれる |
| `text` | string | ヒント本文 |

## hintReveals[] (ヒント開示の記録 — 振り返りの集計元)

参加者がヒントを開示すると、dev サーバ (`dashboard/vite.config.ts` の `/api/reveal-hint`
ミドルウェア) が gameday.json のこの配列に追記する。**これがイベントの永続記録**で、
振り返りで「どのヒントに何ポイント使ったか」を集計する。ダッシュボードの「ヒント消費サマリ」
セクションもここを読む。開示の即時反映はクライアントの localStorage 楽観更新が担い、
最終的な開示集合は `hintReveals` (サーバ記録) ∪ localStorage の和になる。

| フィールド | 型 | 説明 |
|---|---|---|
| `injectId` | string | どのインジェクトのヒントか |
| `hintId` | string | 開示されたヒントの id |
| `label` | string | ヒントの短い名前 (サーバが hints から転記) |
| `cost` | number | 消費ポイント (サーバが hints から転記) |
| `at` | string | 開示時刻 (ISO8601、サーバが付与) |

注意: 追記は dev サーバ (`npm run dashboard`) 稼働時のみ。静的ビルドや手編集運用では
記録されない (その場合は localStorage 開示のみ)。書き込みは追記直前に読み直すので
運営の手編集となるべく競合しないが、同時編集は避ける。

## scoring (自動採点のカーブ設定 — 任意)

無ければ既定値 (`dashboard/src/scoring.ts` の `DEFAULT_SCORING`) が使われる。ルーブリック
(検知 40 / 対応 40 / 伝達 20) の配点・減衰を GameDay の難易度に合わせて調整するときに書く。

```jsonc
"scoring": {
  "detection": { "maxPoints": 40, "fullWithinMinutes": 2, "zeroAfterMinutes": 15 },
  "recovery":  { "maxPoints": 40, "fullWithinMinutes": 5, "zeroAfterMinutes": 30 },
  "commsMaxPoints": 20
}
```

## escalation (エスカレーションの運用スイッチ — 任意)

スコア到達で「次の障害」を自動発火する仕組み (score-escalator) の一時停止スイッチ。
`/api/score` が SCORE アイテムの `escalationEnabled` (BOOL) として DynamoDB に写し、
false のあいだ Lambda は閾値判定ごとスキップする。セクションが無ければ**有効**。

```jsonc
"escalation": { "enabled": false }
```

使いどころ: scenario-03 (GameDay-Legacy) のラウンド中。累計スコアが閾値 (既定 100) を
超えても、誰も見ていない本体スタック側の Aurora フェイルオーバーを発火させないために切る。
`npm run reset` はこのセクションを持ち越さない (毎周回、有効に戻る)。再度有効化したあとの
最初のスコア同期で改めて判定される (閾値超過中なら発火する) ことに注意。

カーブは線形減衰: `fullWithinMinutes` 以内 = 満点、`zeroAfterMinutes` 以降 = 0、間は線形。

## events[] (ゲームイベントログ — 手編集しない)

GameEvents (EventBridge → Lambda → DynamoDB) が記録したイベントを、dev サーバの
gameEventsSync が 5 秒ごとにここへマージする。inject の派生フィールド (armed/impacted/
recovered、検知・復旧時刻) はこの配列から**毎回再計算**されるため、events[] と派生フィールドは
手編集しない。振り返りのタイムライン素材にもなる。

| フィールド | 型 | 説明 |
|---|---|---|
| `key` | string | 重複排除キー (DynamoDB pk)。`EVENT#<time>#<id>`、検知宣言は `ACK#<injectId>` |
| `type` | string | `experiment` (FIS 状態遷移) / `alarm` (canary ヘルスアラーム) / `ack` (検知宣言) |
| `at` | string | 発生時刻 (ISO8601) |
| `experimentId` / `experimentTemplateId` / `status` | string | type=experiment のとき。status は `running` / `completed` / `stopped` / `failed` |
| `alarmName` / `state` / `reason` | string | type=alarm のとき。state は `ALARM` / `OK` |
| `injectId` | string | type=ack のとき |

## feedback[]

KPT ボードの内容。人間のフィードバックと **AI 講評** (author=`AI 講評`) が同じ配列に同居する。
独立した `review` セクションと `retrospectives/` レポートは 2026-07-18 に廃止 — 講評は全て
KPT 形式でここに載る。AI 講評の再生成 (ダッシュボードのボタン / gameday-retrospective スキル)
は `author: "AI 講評"` のエントリだけを入れ替える (人間の KPT は残る)。

| フィールド | 型 | 説明 |
|---|---|---|
| `type` | string | `keep` (続けたい) / `problem` (課題) / `try` (次に試す) |
| `scenarioId` | string \| null | 特定シナリオに紐づくなら id、全体なら null |
| `author` | string | 発言者 (任意)。AI 講評は固定値 `AI 講評` (types.ts の AI_FEEDBACK_AUTHOR) |
| `comment` | string | 内容。1〜3 文で簡潔に |

## 手編集の運用規約 (ゲーム中)

書き込みは dev サーバ内で直列化されるが、**運営の手編集との競合窓はゼロではない**。ゲーム中の
手編集は `response` / `notes` / `feedback` / `commsScore` / `scoreOverride` に限り、
sync が管理するフィールド (`events[]`、inject の `experimentId` / `impactStartAt` /
`recoveredAt` / `status` のライブ状態) は触らない。保存はエディタで一括 1 回にする。

## 最小の追記例

インジェクトを 1 件追加して自動記録の対象にする (`experimentTemplateId` は deploy 出力の値):

```json
{
  "id": "inject-3",
  "scenarioId": "scenario-03",
  "time": "13:30",
  "title": "ネットワーク遅延",
  "instruction": "FIS 実験 gameday-task-latency を開始。落ちないが遅い状態の検知を見る。",
  "response": "",
  "status": "pending",
  "maxScore": 100,
  "experimentTemplateId": "EXT..."
}
```

実験を開始すると sync が `pending → armed → impacted → recovered` と状態を進め、
検知宣言 (ackAt) と合わせて自動採点される。
