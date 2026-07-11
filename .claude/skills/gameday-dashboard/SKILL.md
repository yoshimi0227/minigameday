---
name: gameday-dashboard
description: GameDay ダッシュボードサイト (dashboard/) の運用と変更を行う。「スコアを記録して」「インジェクトを追加して」「フィードバックを載せて」「ダッシュボードを起動して/直して」「スコアボードを見せて」など、GameDay のスコア表・KPT フィードバック・ダッシュボード画面に関わる作業全てで必ず使う。データ更新 (gameday.json 編集 → 即時反映)、採点ルーブリック、起動/ビルド、デザイン変更時の規約を提供する。
---

# GameDay ダッシュボード

GameDay 当日の運営コンソール兼、終了後の共有サイト。インジェクト (運営からの指示) ごとのスコア表、検知・復旧時間のチャート、KPT 振り返りフィードバックを表示する。

- 実体: `dashboard/` — React 19 + TypeScript (Vite+ / `@vitejs/plugin-react-oxc`)。コンポーネントは `src/` (App / Tiles / ScoreTable / TimeChart / KptBoard)、型は `src/types.ts`
- データ: `dashboard/public/data/gameday.json` **このファイルの編集がこのスキルの最頻作業**
- スキーマ: [references/data-schema.md](references/data-schema.md)

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
   - **採点** — `detectionMinutes` / `recoveryMinutes` / `score` / `status` を確定し、`notes` に採点理由を一言残す。
   - **フィードバック追加** — `feedback[]` に `type: keep | problem | try` で追加。
3. 保存すれば dev サーバが即時反映する。JSON の構文エラーは画面が読み込みエラーになるので、編集後に画面の表示を確認する。

## 採点ルーブリック (目安)

各インジェクト 100 点。配点は GameDay の学習目標に合わせて調整してよいが、初期値はこれを使う:

| 観点 | 配点 | 見るもの |
|---|---|---|
| 検知 | 40 | 気づくまでの速さ。canary / アラームなど正しい観測から気づけたか (偶然でなく) |
| 対応 | 40 | 影響範囲の説明が正確か。処置が適切か — **自己回復を見極めた「静観」も満点になりうる** |
| 伝達・記録 | 20 | 状況宣言、対応の宣言、タイムラインの記録が残っているか |

減点ではなく加点で考える。「壊れたのに高得点」が GameDay の理想形(система が守り、人が正しく観測した)。

## 振り返りとの連携

- 実験終了後、`gameday-retrospective` スキルが `retrospectives/` に作るレポートの「学び」「アクションアイテム」から、共有したいものを `feedback[]` (KPT) に転記する。
- 逆に、当日ダッシュボードに記録した `response` / `notes` は振り返りレポートのタイムラインの一次資料になる。

## 画面・デザインを変更するとき

- **チャートや色を触る前に dataviz スキルを読み込む**こと。このダッシュボードは dataviz の参照パレット準拠で作られている。
- 色は `dashboard/styles.css` の CSS 変数 (ロール名) のみを参照する。生の hex をコンポーネントに書かない。
- 系列色を増やす場合は dataviz の `scripts/validate_palette.js` でライト・ダーク両面を検証してから採用する。
- マーク仕様: バーは太さ ≤24px・データ端のみ 4px 丸め・隣接バーは 2px ギャップ、テキストは ink トークン (系列色の文字は禁止)、2 系列以上は凡例必須。
- データは JSX のテキストとしてのみ描画する。`dangerouslySetInnerHTML` は禁止 (フィードバックや対応記録は自由入力の文字列のため)。
- 描画ロジックを変えたら `npm test` を実行する。`dashboard/src/App.test.tsx` (Vitest + Testing Library + jsdom) が「データ → DOM」のスモークテスト (タイル数・行数・バー数・フィルタ動作) を守っている。スキーマにフィールドを足したらこのテストも更新する。
- 型チェックは `npm run build` に含まれる (`tsc -p dashboard`)。CDK 側の tsconfig とは分離されている (dashboard は root tsconfig の exclude 対象)。
