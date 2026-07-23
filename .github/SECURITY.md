# セキュリティポリシー

## 脆弱性の報告

このリポジトリのコード自体に脆弱性を見つけた場合は、公開 issue ではなく
**[GitHub の Private Vulnerability Reporting](https://github.com/yoshimi0227/minigameday/security/advisories/new)**
から報告してください。

## 対象範囲の注意

このプロジェクトは**意図的に障害を起こして学ぶ**カオスエンジニアリング学習環境です。
以下は脆弱性ではなく仕様です:

- FIS 実験によるリソースの停止・破壊 (`stopConditions` と爆発半径の制御下で行われる)
- cdk-nag の警告を `lib/nag-suppressions.ts` で理由付き抑制している箇所 (GameDay のトレードオフ)
- scenario-03 の GameDay-Legacy スタックが単一 EC2 の SPOF であること (それが出題意図)

報告対象になるのは、たとえば「対象スタックの**外**に影響が及ぶ」「IAM 権限が実験に必要な範囲を
超えている」「ダッシュボード dev サーバの API に外部から書き込める」といった、
学習環境の意図を超えるリスクです。

## サポート対象

`main` ブランチの最新のみ。
