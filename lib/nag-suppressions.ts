import { Stack } from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';

/**
 * この GameDay は「使い捨ての学習ラボ」。本番なら必須のいくつかのベストプラクティスを
 * 意図的に見送っている (短命・低コスト優先、あるいは題材そのもの)。
 * cdk-nag (`npm run synth:nag`) の指摘のうち、その意図的トレードオフを理由付きで抑制する。
 *
 * ここに列挙されていない指摘が新たに出たら、それは想定外なので抑制せず対処すること。
 * 本物のプロダクションへ転用する場合は、この抑制を外して各指摘に対応する。
 */
export function suppressGamedayLabFindings(stack: Stack): void {
  NagSuppressions.addStackSuppressions(stack, [
    // --- IAM ---
    {
      id: 'AwsSolutions-IAM4',
      reason:
        '学習ラボ: AWS マネージドポリシー (ECSTaskExecution / FIS アクセス / SSMManagedInstanceCore) を利用。最小権限へのインライン化は本番転用時の宿題',
    },
    {
      id: 'AwsSolutions-IAM5',
      reason:
        '学習ラボ: grant*() やタグ検索・FIS が要求するワイルドカード。対象はスタック内リソース/タグ条件に限定済み',
    },
    // --- ネットワーク / ログ (使い捨てのため運用系は非対象) ---
    { id: 'AwsSolutions-S1', reason: '学習ラボ: 使い捨てのため S3 サーバアクセスログは非対象' },
    { id: 'AwsSolutions-VPC7', reason: '学習ラボ: 使い捨てのため VPC Flow Logs は非対象' },
    { id: 'AwsSolutions-ELB2', reason: '学習ラボ: 使い捨てのため ALB アクセスログは非対象' },
    {
      id: 'AwsSolutions-EC23',
      reason:
        '意図的: ALB はインターネット公開の Web アプリ (:80)。GameDay の対象アプリなので 0.0.0.0/0 からの受信を許可する',
    },
    // --- データ層 (短命な Aurora / デモ用) ---
    { id: 'AwsSolutions-SMG4', reason: '学習ラボ: 短命な Aurora のためシークレット自動ローテーションは非対象' },
    { id: 'AwsSolutions-RDS6', reason: '学習ラボ: IAM DB 認証は非対象 (アプリは Secrets Manager 経由で接続)' },
    {
      id: 'AwsSolutions-RDS10',
      reason: '意図的: GameDay 終了後に cdk destroy で片付けるため削除保護を無効化している',
    },
    { id: 'AwsSolutions-RDS11', reason: '学習ラボ: 既定ポートのまま (隔離サブネット + SG でネットワーク保護)' },
    { id: 'AwsSolutions-RDS14', reason: '学習ラボ: 短命なため Aurora Backtrack は非対象' },
    // --- コンピュート (デモ用 EC2 / ECS) ---
    {
      id: 'AwsSolutions-EC29',
      reason:
        '意図的 (scenario-03): 単一 EC2 を SPOF にするのが題材。Auto Scaling Group を付けないのが仕様',
    },
    { id: 'AwsSolutions-EC28', reason: '学習ラボ: デモ用インスタンスの詳細モニタリングは非対象' },
    { id: 'AwsSolutions-EC26', reason: '学習ラボ: デモ用インスタンスの EBS 暗号化は非対象' },
    {
      id: 'AwsSolutions-ECS2',
      reason:
        '学習ラボ: 非機密の接続情報 (DB_HOST 等) を環境変数で渡す。認証情報 (DB_SECRET) は Secrets Manager 経由',
    },
  ]);
}
