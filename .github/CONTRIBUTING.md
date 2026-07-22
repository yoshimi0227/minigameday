# コントリビュートガイド

PR を歓迎します。このリポジトリは「クローンして各自の AWS アカウントで GameDay を回す」配布物なので、
以下の 2 点だけ守ってください。詳細な規約は [CLAUDE.md](../CLAUDE.md) にあります。

## 1. 検証ループを一巡させる

```bash
npm ci
npm run build      # 型チェック (CDK 本体 + dashboard)
npm test           # ユニットテスト (Vitest + aws-cdk-lib/assertions)
npm run lint       # Oxlint + awscdk プラグイン (pre-commit フックでも走る)
npm run synth:nag  # cdk-nag コンプライアンス検査
```

CI (GitHub Actions) も同じ 4 つを回します。すべて AWS 認証なしで動きます
(スタックは environment-agnostic、コンテナビルドは deploy-time-build)。

FIS 実験・SSM Automation など**デプロイしないと分からない変更**は、可能なら自分のアカウントで
`npm run deploy` → 実験実行まで確認してから PR にしてください (結果を PR の「動作確認」欄へ)。

## 2. 定義と実行時状態を混ぜない

- **ゲーム定義** (インジェクト・ヒント・構成図・採点カーブ) の正は `dashboard/gameday.seed.json`。
  ここにはアカウント固有の値を入れない — FIS 実験は ID ではなく `experimentTemplateName`
  (Name タグ、例 `gameday-scale-to-zero`) で指す。混入は `dashboard/src/seed.test.ts` が検出する。
- `dashboard/public/data/gameday.json` は各利用者の実行時状態 (git 管理外)。PR に含めない。

## FIS 実験を書くときの必須制約

- `stopConditions` (アラームベース) の無い実験は受け入れない
- ターゲティングで爆発半径を明示 (`resourceTags` + `selectionMode`、または CDK 参照の `resourceArns`)
- `logConfiguration` と実験レポート設定を付ける (振り返りの素材)
- アクション仕様は記憶で書かず `.claude/skills/fis-experiment/references/fis-actions.md` を参照

## AI レビューについて

- **同一リポジトリ発の PR**: 開くと Claude による自動レビューが走り、指摘がインラインコメントで付きます。
- **フォークからの PR**: secrets が渡らないため自動レビューは走りません。メンテナが
  「@claude この PR をレビューして」とコメントするとレビューが起動します。

nit: 付きの指摘への対応は任意ですが、正当性 (correctness) や FIS 安全装置の指摘は
解消するか理由を返信してください。CI (lint / test / build / synth:nag) は全 PR で必須です。

## 前提環境

- Node.js >= 22 (ツールチェーンの Vite+ / Oxlint が要求。古い Node では npm がネイティブバイナリを黙ってスキップして壊れる)
- AWS アカウント (デプロイして動かす場合のみ。CI と静的検証はローカルだけで完結)
