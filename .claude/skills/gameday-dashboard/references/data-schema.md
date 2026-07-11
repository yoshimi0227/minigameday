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

開示状態はブラウザの localStorage (`gameday-revealed-hints`) に保持され、リロードしても残る。
運営が採点をやり直しても、開示済みヒントの消費は自動で反映される。

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
