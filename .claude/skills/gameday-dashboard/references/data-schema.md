# gameday.json スキーマ

`dashboard/public/data/gameday.json` の構造。1 ファイル = 1 回の GameDay。
過去回をアーカイブする場合は `dashboard/public/data/archive/YYYY-MM-DD.json` にコピーしてから書き換える。

## トップレベル

```jsonc
{
  "event":    { /* 開催情報 */ },
  "injects":  [ /* インジェクト = 運営からの指示と、その対応・採点 */ ],
  "feedback": [ /* KPT フィードバック */ ]
}
```

## event

| フィールド | 型 | 説明 |
|---|---|---|
| `title` | string | 画面ヘッダに表示 |
| `date` | string | `YYYY-MM-DD` |
| `team` | string | 参加チーム名 (任意) |
| `note` | string | フィルタ行に出る補足 (任意) |

## injects[]

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | `inject-1` 形式。一意 |
| `scenarioId` | string \| null | `scenarios/` のシナリオ id (`scenario-01` 等)。フィルタと振り返りの突き合わせに使う |
| `time` | string | 指示を出した実時刻 `HH:MM` |
| `title` | string | 一言タイトル (チャートの行ラベルにもなる。13 文字程度まで) |
| `instruction` | string | 運営が出した指示の内容 |
| `response` | string | チームの対応の記録。いつ・誰が・何をしたか。手動対応は必ず明記 (drift との突き合わせ用) |
| `status` | string | `success` / `partial` / `failed` / `pending` |
| `detectionMinutes` | number | 指示 (障害注入) から検知までの分。未計測なら省略 |
| `recoveryMinutes` | number | 定常状態に戻るまでの分。未計測なら省略 |
| `score` | number | 獲得点 (ヒント消費前の素点)。未採点なら省略 |
| `maxScore` | number | 満点 (通常 100) |
| `notes` | string | 採点理由・気づき (任意) |
| `hints` | Hint[] | 段階ヒント (任意)。ポイント消費で開示。下記参照 |

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

## feedback[]

| フィールド | 型 | 説明 |
|---|---|---|
| `type` | string | `keep` (続けたい) / `problem` (課題) / `try` (次に試す) |
| `scenarioId` | string \| null | 特定シナリオに紐づくなら id、全体なら null |
| `author` | string | 発言者 (任意) |
| `comment` | string | 内容。1〜3 文で簡潔に |

## 最小の追記例

インジェクトを 1 件追加して進行中にする:

```json
{
  "id": "inject-3",
  "scenarioId": "scenario-03",
  "time": "13:30",
  "title": "ネットワーク遅延",
  "instruction": "FIS 実験 gameday-task-latency を開始。落ちないが遅い状態の検知を見る。",
  "response": "",
  "status": "pending",
  "maxScore": 100
}
```
