## 概要

<!-- 何を・なぜ。関連 issue があれば #番号 -->

## 変更の種類

<!-- 該当するものに x -->

- [ ] バグ修正・改善
- [ ] シナリオ追加・改訂 (`scenarios/`)
- [ ] FIS 実験の追加・変更 (`lib/constructs/fault-injection.ts`)
- [ ] ダッシュボード (`dashboard/`)
- [ ] ドキュメント・スキル定義

## チェックリスト

- [ ] `npm run build` (型チェック) が通る
- [ ] `npm test` が通る (スナップショット更新した場合は差分が意図どおりか確認済み)
- [ ] `npm run lint` が通る
- [ ] `npm run synth:nag` (cdk-nag) が通る (新規抑制は `lib/nag-suppressions.ts` に理由付きで)
- [ ] アカウント固有の値 (アカウント ID・ARN・FIS テンプレート ID 等) を含めていない
- [ ] **FIS 実験を触った場合**: `stopConditions` あり / 爆発半径 (ターゲティング) 明示 / `logConfiguration` あり (`.claude/skills/fis-experiment` の基準)
- [ ] **ゲーム定義 (インジェクト・systems・scoring) を変えた場合**: `dashboard/gameday.seed.json` を更新した (`dashboard/public/data/gameday.json` は git 管理外の実行時状態)

## 動作確認

<!-- 実機確認した場合はその内容 (deploy / FIS 実験の実行 / ダッシュボード表示など)。
     未実施なら「CI のみ」と書く。破壊的な変更 (FIS アクション・SSM Automation) は
     実機一巡の結果があるとレビューが速い -->
