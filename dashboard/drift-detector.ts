// `cdk drift` の実行 (dev サーバ専用 — ブラウザには載せない)。
// AI 講評の材料として「実験後にコードへ還元されていない手動変更 (コンソール操作) の痕跡」を
// 集める。CloudFormation API を直接叩かず、このプロジェクトの振り返りの正規手段である
// CDK CLI の `cdk drift` をそのまま子プロセスで実行する (対象はアプリの全スタック =
// GameDay / GameDay-Legacy)。出力は人間向けテキストだが、消費者は LLM なのでパースせず
// 生のまま渡す — パーサを持たないので CLI の表示変更にも壊れない。
//
// ベストエフォート設計: 未デプロイ・未認証・タイムアウトは status: 'UNAVAILABLE' の結果に
// して返し、決して reject しない (講評本体を止めない)。「取れなかった」ことも材料として
// LLM に渡す — 黙って欠落させると「手動変更なし」と誤読されるため。
//
// 認証は dev サーバの起動シェルを引き継ぐ (reset の cdk deploy と同じ前提)。

import { spawn } from 'node:child_process';

// --no-color: ANSI エスケープをプロンプトに混ぜない
const DRIFT_COMMAND = 'npx cdk drift --no-color';
// synth (tsx) + スタックごとのドリフト検出で通常 1〜3 分。ボタン側の案内 (数分) に収める
const TIMEOUT_MS = 240_000;
// プロンプトに入れる出力の上限。超えたら末尾優先 (サマリと差分は後半に出る)
const OUTPUT_LIMIT = 12_000;

/** `cdk drift` の実行結果 (AI 講評へ渡す形) */
export interface DriftMaterial {
  /** 実行したコマンド (講評の try でそのまま案内できるように) */
  command: string;
  /** OK = 検出が完了し output が有効 / UNAVAILABLE = 検出できず (note に理由) */
  status: 'OK' | 'UNAVAILABLE';
  /** cdk drift の生出力 (スタックごとの差分リソース or "No drift detected") */
  output?: string;
  note?: string;
}

/**
 * `npx cdk drift` をプロジェクトルートで実行し、生出力を AI 講評の材料にする形で返す。
 * 決して reject しない (失敗は UNAVAILABLE として返す)。
 */
export function collectDriftMaterial(projectRoot: string): Promise<DriftMaterial> {
  const command = DRIFT_COMMAND;
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    // Windows では npx が npx.cmd のため shell 経由で起動する (resetApi と同じ)。
    // コマンドは固定文字列 1 本でリクエスト内容を一切混ぜない (args 配列 + shell は DEP0190)。
    const child = spawn(command, { cwd: projectRoot, shell: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);
    const onChunk = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ command, status: 'UNAVAILABLE', note: `起動失敗: ${String(e)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const clipped =
        output.length > OUTPUT_LIMIT ? `…(先頭を省略)\n${output.slice(-OUTPUT_LIMIT)}` : output;
      if (timedOut) {
        resolve({
          command,
          status: 'UNAVAILABLE',
          note: `${TIMEOUT_MS / 1000} 秒以内に完了しなかった`,
          output: clipped,
        });
      } else if (code !== 0) {
        resolve({
          command,
          status: 'UNAVAILABLE',
          note: `exit ${code} (未認証シェル / スタック未デプロイ?)`,
          output: clipped,
        });
      } else {
        resolve({ command, status: 'OK', output: clipped });
      }
    });
  });
}
