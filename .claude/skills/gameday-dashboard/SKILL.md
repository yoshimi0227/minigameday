---
name: gameday-dashboard
description: GameDay ダッシュボードサイト (dashboard/) の運用と変更を行う。「スコアを記録して」「インジェクトを追加して」「フィードバックを載せて」「ダッシュボードを起動して/直して」「スコアボードを見せて」など、GameDay のスコア表・KPT フィードバック・ダッシュボード画面に関わる作業全てで必ず使う。データ更新 (gameday.json 編集 → 即時反映)、採点ルーブリック、起動/ビルド、デザイン変更時の規約を提供する。
---

# GameDay ダッシュボード

GameDay 当日の運営コンソール兼、終了後の共有サイト。インジェクト (運営からの指示) ごとのスコア表、検知・復旧時間のチャート、KPT 振り返りフィードバックを表示する。

- 実体: `dashboard/` — React 19 + TypeScript (Vite+ / `@vitejs/plugin-react-oxc`)。コンポーネントは `src/` (App / Tiles / Architecture / AckBanner / ScoreTable / TimeChart / KptBoard / Hints / HintSummary / ReviewBoard / ReviewControl / GameControl)、型は `src/types.ts`、**採点・イベント導出ロジックは `src/scoring.ts` (唯一の置き場。UI と dev サーバの両方が import)**。AI 講評生成は `dashboard/review-generator.ts` (dev サーバ専用。ブラウザには載せない)
- データ: `dashboard/public/data/gameday.json` **このファイルの編集がこのスキルの最頻作業**
- スキーマ: [references/data-schema.md](references/data-schema.md)

## リアルタイム反映

App が `gameday.json` を **3 秒ごとにポーリング**し、内容が変わったら再描画する (`dashboard/src/App.tsx` の `POLL_MS`)。運営が当日 JSON を編集すると数秒で画面に反映され、リロード不要。ヘッダー右上の **LIVE インジケータ**が更新中を示し、ポーリングが失敗しても前回の表示を保持する (画面を消さない)。

## システム構成 (参考資料) — シナリオと連動

本物の GameDay と同様、参加者向けに**お題システムの「元の構成図」と軽い補足**をダッシュボードに載せる。
データは `gameday.json` の `systems[]` (スキーマ・書き方の指針は [references/data-schema.md](references/data-schema.md))、
描画は `dashboard/src/Architecture.tsx` — **AWS 公式アーキテクチャアイコン** (npm `aws-icons`、キー定義は
`dashboard/src/awsIcons.ts`) を使い、層 = グループボックス、リソース = アイコン + 名前、上から下へ矢印でつなぐ。
カードは折りたたみ可能で、タブで対象システムを切り替える (シナリオフィルタ連動は 2026-07-18 に
フィルタごと撤去し、手動タブのみ)。
新しいサービスのアイコンが要るときは `awsIcons.ts` に import + キー登録する (data-schema.md の一覧参照)。

**新規シナリオを追加したら `systems[]` も必ず更新する** (add-scenario スキルの手順に組み込み済み):

- 既存システムが対象のシナリオ → その system の `scenarioIds` に id を追加。前提インフラで観測手段やノードが増えるなら `tiers` / `notes` にも反映
- 新しい出発点スタックを使うシナリオ (scenario-03 の GameDay-Legacy 等) → system を新規追加
- 構成は**記憶で書かず `lib/` の実装から起こす** (どの層に何が何台、canary 名、停止条件アラーム名)

## ヒント (ポイント消費で開示)

インジェクトに `hints` (段階ヒント) を持たせると、参加者がダッシュボード上で**ポイントを消費して**開示できる。開示すると `cost` が獲得スコアから引かれ、**実効スコア = 素点 − 開示済み cost 合計**がタイル・スコアセルに反映される。開示状態はブラウザ localStorage に保持 (リロードしても残る)。scenarios の「段階ヒント」をポイント制にしたもの。追加はスキーマ ([references/data-schema.md](references/data-schema.md)) の `hints[]` 参照。

## 2 ラウンド構成 (観察 / 対応)

インジェクトを `round`(number)でグルーピングして表示する。スコア表はラウンドごとに見出し行 +
小計を出す(`rounds[]` があれば見出しにタイトルが出る)。ラウンド/シナリオの絞り込みプルダウンは
2026-07-18 のリハーサルで撤去した (参加者 1 人・少インジェクト運用では選択肢がほぼ無くノイズ)。

- **R1 観察ラウンド** — 自己回復する障害(scenario-01/02)。静観・判断の練習。復旧 40 点は待てば入る
- **R2 対応ラウンド** — 自己回復しない障害(scenario-05 scale-to-zero / scenario-03 EC2 rebuild)。
  **人が直すまで canary は赤のまま**で、MTTR が対応速度を実測する

運用: 各 inject に `round: 1|2` を付け、トップレベルに `rounds[]`(タイトル・説明)を置く。R1 を先に
走らせ切ってから R2 を開始する(同時に複数ラウンドを armed にしない — アラーム帰属が曖昧になる)。
round は採点ロジックに影響しない(表示のグルーピングだけ)。スキーマは references/data-schema.md。

## 自動採点 (検知宣言 + アラーム復旧)

「障害 → 検知 → 復旧」が AWS 側のイベントで自動記録され、点数が自動で入る (README「対応状況で
自動採点」参照)。ダッシュボード側の動き:

- inject に `experimentTemplateId` を記入しておくと、実験開始で「⏱ 実験進行中 (armed)」バナーが出る。
- canary アラームが ALARM になると「🚨 影響発生中 (impacted)」に変わり、**「検知を宣言する」ボタン**が
  有効になる (armed 中は押せない — 先押しで検知満点を取る抜け道防止。サーバ側 /api/ack も 409 で弾く)。
- アラーム OK で「復旧済み (recovered)」になり、検知 (速さ) + 復旧 (MTTR) + 伝達 (`commsScore` 手動) で
  自動採点され、スコアセルに内訳が小書きされる。
- 派生フィールド (`impactStartAt` 等) と `events[]` は **dev サーバの sync が管理するので手編集しない**。
  手動で直したいときは `scoreOverride` (最終裁定) か `commsScore` を使う。詳細は data-schema.md。
- 自動記録には AWS 認証済みシェルでの起動が必要 (DynamoDB `Scan` + `PutItem`)。未認証でも表示は壊れない。

## スコア到達で「次の障害」を自動発火 (エスカレーション)

合計実効スコアが閾値に達すると、AWS 側が自動で「次の障害」(Aurora フェイルオーバー) を発火する。
App は合計実効スコアを算出して dev サーバの `/api/score` に POST し、これが DynamoDB (`gameday-score`)
を更新 → DynamoDB Streams → Lambda (`score-escalator`) が閾値判定して `fis:StartExperiment` する
(実装は `lib/constructs/score-escalation.ts`、閾値は `-c escalateAtScore=N`、既定 100)。

- スコア同期は **AWS 認証済みシェルで `npm run dashboard` を起動している**ときだけ効く(既定クレデンシャル
  チェーンを使う)。未認証・スタック未デプロイでも同期はベストエフォートで、画面表示は壊れない。
- 発火は各トリガー 1 回だけ (`FIRED#<id>` の条件付き書き込みで冪等)。仕組みの詳細は README「スコア到達で
  『次の障害』を自動発火」を参照。
- **一時停止スイッチ**: `gameday.json` に `"escalation": { "enabled": false }` を書くと発火を止められる
  (scenario-03 の GameDay-Legacy ラウンド中に本体側の障害を出さないため)。無ければ有効。
  `npm run reset` では持ち越さない。スキーマは references/data-schema.md の escalation 節。

## ゲーム進行ボタン (開始 / リトライ — dev サーバのみ)

画面上部の運営用コントロール (`GameControl`。`import.meta.env.DEV` ガードで静的ビルドには出ない):

- **▶ GameDay 開始** — まだ何も始まっていないとき (全インジェクト pending・実験イベントなし) に出る。
  押すと dev サーバの `POST /api/start` が**最初の `experimentTemplateId` 付きインジェクト**の FIS 実験を
  開始する。以降の armed/impacted/採点は GameEvents の自動記録に乗る。対象判定は
  `scoring.ts` の `findStartCandidate` (UI とサーバ側ガードで共用。二重クリックや古い画面からの
  発火は 409)。2 発目以降は従来どおり CLI かエスカレーション。
- **⟳ リトライ (周回リセット)** — 振り返りフィードバック (KPT `feedback[]` か `review`) が残ると出る
  (`canRetry`)。誤爆防止の 2 段階クリックで `POST /api/reset` → dev サーバが **`npm run reset` を
  子プロセス実行** (実験停止 → revert-drift → gameday-score ワイプ → gameday.json 初期化)。数分かかり、
  進行状況は `GET /api/reset` (running / ok / tail) をポーリングして末尾ログを表示する。完了すると
  gameday.json が初期化されるので、ポーリング経由で画面も初期状態に戻り、開始ボタンが再び出る。

どちらも **AWS 認証済みシェルで `npm run dashboard` を起動している**前提 (score 同期と同じ)。

## 起動・ビルド

```bash
npm run dashboard        # 開発サーバ (Vite)。gameday.json の保存で画面に即時反映
npm run dashboard:build  # 静的ビルド → dashboard/dist (S3 等で配る場合)
```

GameDay 中はプロジェクタに映したまま `npm run dashboard` を起動しておき、記録係 (または Claude) が JSON を編集する運用。ビルドは配布・アーカイブ用で、当日は不要。

## データ更新の手順

1. `dashboard/public/data/gameday.json` を読む。
2. 依頼内容をスキーマに従って反映する:
   - **インジェクト追加** — `injects[]` に追加。`time` は実時刻、`status` は最初 `"pending"`。FIS 実験と対応する場合は `scenarioId` を scenarios/ の id と一致させる(スコア表・フィルタ・振り返りの突き合わせに使う)。
   - **対応の記録** — 該当インジェクトの `response` に「いつ・誰が・何をしたか」を書く。手動対応 (コンソール操作) は必ず明記する。実験後の `cdk drift` と突き合わせるため。
   - **採点 (自動記録あり)** — 検知/復旧/素点は自動。運営は `commsScore` (伝達 0〜20) を記入し、補正が要るときだけ `scoreOverride`。`notes` に採点理由を一言残す。
   - **採点 (自動記録なし = canary 死角や手動運用)** — 従来どおり `detectionMinutes` / `recoveryMinutes` / `score` / `status` を確定する。
   - **フィードバック追加** — `feedback[]` に `type: keep | problem | try` で追加。
3. 保存すれば dev サーバが即時反映する。JSON の構文エラーは画面が読み込みエラーになるので、編集後に画面の表示を確認する。

## 採点ルーブリック (目安)

各インジェクト 100 点。配点は GameDay の学習目標に合わせて調整してよいが、初期値はこれを使う:

| 観点 | 配点 | 見るもの | 自動/手動 |
|---|---|---|---|
| 検知 | 40 | 気づくまでの速さ。canary / アラームなど正しい観測から気づけたか (偶然でなく) | 自動 (影響開始→検知宣言。2 分以内満点→15 分で 0 に線形減衰) |
| 対応 | 40 | 影響範囲の説明が正確か。処置が適切か — **自己回復を見極めた「静観」も満点になりうる** | 自動 (影響開始→アラーム OK。5 分以内満点→30 分で 0) |
| 伝達・記録 | 20 | 状況宣言、対応の宣言、タイムラインの記録が残っているか | 手動 (`commsScore`) |

減衰カーブは gameday.json の `scoring` セクションで調整できる (無ければ上記の既定値)。
減点ではなく加点で考える。「壊れたのに高得点」が GameDay の理想形(システムが守り、人が正しく観測した)。
自動採点が実態に合わないとき (帰属ミス・特殊事情) は `scoreOverride` で最終裁定する。

## 振り返りとの連携

- 講評は **KPT 形式で `feedback[]` に一本化** (2026-07-18。独立した `review` セクションと `retrospectives/` レポートは廃止)。AI 講評は `author: "AI 講評"` 付きで KPT ボードに人間のフィードバックと並ぶ。
- **AI 講評の自動生成 (dev 専用)**: KPT カード内の「AI 講評を KPT で生成」ボタン (ReviewControl。`import.meta.env.DEV` ガードで静的ビルドには出ない) → dev サーバの `POST /api/review` → まず `dashboard/drift-detector.ts` が **`cdk drift` (CDK CLI)** を子プロセスで実行 (全スタック対象、240 秒で打ち切り、生出力をそのまま材料化) し、`dashboard/review-generator.ts` が **Bedrock Converse API** で LLM を呼び、events タイムライン・採点・ヒント消費・**drift (宣言されていない手動変更 = 想定外の手作業の検知)** から Keep/Problem/Try を生成して `feedback[]` に書き込む (updateGamedayJson 経由)。drift はベストエフォート (未デプロイ・未認証は UNAVAILABLE として LLM に渡り、講評自体は止まらない)。宣言済み手動対応の drift には `cdk deploy --revert-drift` での IaC 還元を try として出させる。
  - 認証: `AWS_BEARER_TOKEN_BEDROCK` (Bedrock API キー) か既定の AWS 認証チェーン。モデル既定 `apac.amazon.nova-lite-v1:0` / リージョン既定 `ap-northeast-1` (`GAMEDAY_REVIEW_MODEL` / `GAMEDAY_BEDROCK_REGION` で上書き)。**Nova 既定なのはこのアカウントが Claude 全世代を推論不可のため** (CLAUDE.md 検証済みメモ 2026-07-18)。
  - 生成は数分 (`cdk drift` 1〜3 分 + LLM)。生成中の再実行は 409。**再生成は author='AI 講評' のエントリだけを入れ替える** (人間の KPT は残る)。より厚い講評 (git diff / canary スクショまで踏み込む) は gameday-retrospective スキル (Claude Code) で — 出力先は同じ `feedback[]`。
- 当日自動記録された `events[]` (実験開始 / ALARM / OK / 検知宣言) と `response` / `notes` / `hintReveals` が講評のタイムラインの一次資料になる。

## 画面・デザインを変更するとき

- **チャートや色を触る前に dataviz スキルを読み込む**こと。このダッシュボードは dataviz の参照パレット準拠で作られている。
- 色は `dashboard/src/styles.css` の CSS 変数 (ロール名) のみを参照する。生の hex をコンポーネントに書かない。
- 系列色を増やす場合は dataviz の `scripts/validate_palette.js` でライト・ダーク両面を検証してから採用する。
- マーク仕様: バーは太さ ≤24px・データ端のみ 4px 丸め・隣接バーは 2px ギャップ、テキストは ink トークン (系列色の文字は禁止)、2 系列以上は凡例必須。
- データは JSX のテキストとしてのみ描画する。`dangerouslySetInnerHTML` は禁止 (フィードバックや対応記録は自由入力の文字列のため)。
- 描画ロジックを変えたら `npm test` を実行する。`dashboard/src/App.test.tsx` (Vitest + Testing Library + jsdom) が「データ → DOM」のスモークテスト (タイル数・行数・バー数・フィルタ動作) を守っている。採点ロジックは `dashboard/src/scoring.test.ts` が守る。スキーマにフィールドを足したらこれらのテストも更新する。
- 型チェックは `npm run build` に含まれる (`tsc -p dashboard`)。CDK 側の tsconfig とは分離されている (dashboard は root tsconfig の exclude 対象)。
