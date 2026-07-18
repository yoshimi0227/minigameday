import { defineConfig } from 'vite-plus';

// Vite+ 一元設定: Vitest (test) と Oxlint (lint) をここに集約する。
// oxlint.config.ts / .oxlintrc.json は作らない (Vite+ 非推奨)。
export default defineConfig({
  test: {
    // CDK テスト (node) + dashboard の React コンポーネントテスト (jsdom はファイル側の
    // @vitest-environment ディレクティブで指定) + dashboard の純ロジックテスト (.test.ts)
    include: ['test/**/*.test.ts', 'dashboard/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // CDK 合成は Lambda を esbuild でバンドルする (NodejsFunction) ため既定 5s を超え得る。
    testTimeout: 30000,
  },
  lint: {
    ignorePatterns: ['cdk.out/**', '*.d.ts', 'dashboard/dist/**'],
    // AWS CDK 静的チェック: https://awscdk-lint.dev/ja/getting-started/oxlint/
    // 注意: jsPlugins は overrides でスコープできない (プラグインは全ファイルを訪問する)。
    // 非 CDK コード側には tsconfig.json を置いて corsa の型解決を成立させる (dashboard/tsconfig.json)
    jsPlugins: ['oxlint-plugin-awscdk'],
    // corsa-oxlint (型認識リントの実行系) が Windows で JS シムを直接 spawn して
    // os error 193 になるため、tsgo.exe 本体を明示する (プロジェクトルートからの相対)。
    // Windows 限定の回避策 (win32 用の tsgo.exe パスは他 OS には存在しない)。
    settings:
      process.platform === 'win32'
        ? {
            corsaOxlint: {
              corsa: {
                executable: './node_modules/@typescript/native-preview-win32-x64/lib/tsgo.exe',
              },
            },
          }
        : {},
    // awscdk ルールは CDK コードのみに適用する。dashboard/ 等の非 CDK コードで
    // 型解決 (tsconfig 外) が走ると corsa が "no project found" で落ちるため
    overrides: [
      {
        files: ['bin/**/*.ts', 'lib/**/*.ts', 'test/**/*.ts'],
        rules: {
          // oxlint-plugin-awscdk v0.1.3 の recommended 相当 (プラグイン更新時に見直す)
          'awscdk/construct-constructor-property': 'error',
          'awscdk/no-construct-in-interface': 'error',
          'awscdk/no-construct-in-public-property-of-construct': 'error',
          'awscdk/no-construct-stack-suffix': 'error',
          'awscdk/no-mutable-property-of-props-interface': 'warn',
          'awscdk/no-mutable-public-property-of-construct': 'warn',
          'awscdk/no-parent-name-construct-id-match': ['error', { disallowContainingParentName: false }],
          'awscdk/no-unused-props': 'error',
          'awscdk/no-variable-construct-id': 'error',
          'awscdk/pascal-case-construct-id': 'error',
          'awscdk/prefer-grants-property': 'warn',
          'awscdk/require-passing-this': ['error', { allowNonThisAndDisallowScope: true }],
        },
      },
    ],
  },
});
