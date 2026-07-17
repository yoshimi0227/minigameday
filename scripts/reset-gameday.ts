// GameDay 周回リセット (モード A: destroy しない)。
//
//   npm run reset            # フル: 実験停止 → revert-drift → DDB ワイプ → gameday.json 初期化 → drift 確認
//   npm run reset -- --dry-run      # 何が起きるかの報告だけ (書き込み・デプロイなし)
//   npm run reset -- --skip-deploy  # revert-drift デプロイを飛ばす (ゲーム状態のリセットだけしたい時)
//   npm run reset -- --skip-drift   # 最後の cdk drift 確認を飛ばす
//   npm run reset -- -c faultDelayMinutes=5-15   # 上記以外の引数は cdk deploy へそのまま渡す
//
// destroy→deploy (20〜30 分) をせずに再プレイ可能な状態へ戻すのが目的:
//   - インフラ: cdk deploy --all --revert-drift (drift-aware change set)。手動対応の巻き戻しと
//     terminate 済み legacy EC2 の再作成。スタックを保つので FIS テンプレート ID は変わらない。
//   - ゲーム状態: gameday-score テーブルの全アイテム (SCORE / EVENT# / ACK# / FIRED#)。
//     特に FIRED#<id> はエスカレーションの冪等クレームで、残っていると 2 周目に発火しない。
//   - ダッシュボード: gameday.json から前回の実績 (導出フィールド・スコア・events・review 等) を
//     除去し、インジェクト定義だけの初期状態に戻す。元ファイルは dashboard/data-archive/ に退避。
//
// 前提: AWS 認証済みシェルで実行する (dev サーバと同じ既定クレデンシャルチェーン)。
// scenario-03 で参加者が手で作ったスタック外リソース (ECS サービス等) はここでは戻せない —
// scenarios/03-ec2-to-ecs-rebuild.md の棚卸しリストに従って手動で削除する。

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  FisClient,
  ListExperimentTemplatesCommand,
  ListExperimentsCommand,
  StopExperimentCommand,
  GetExperimentCommand,
  type ListExperimentsCommandOutput,
} from '@aws-sdk/client-fis';
import {
  DynamoDBClient,
  ScanCommand,
  BatchWriteItemCommand,
  type WriteRequest,
} from '@aws-sdk/client-dynamodb';

const ROOT = join(__dirname, '..');
const DATA_PATH = join(ROOT, 'dashboard', 'public', 'data', 'gameday.json');
const ARCHIVE_DIR = join(ROOT, 'dashboard', 'data-archive');
const TABLE_NAME = process.env.GAMEDAY_SCORE_TABLE ?? 'gameday-score';
const MAIN_STACK = 'GameDay';

// FIS の実行中扱いのステータス (これらは停止対象。stopping は停止待ちで拾う)
const ACTIVE_STATUSES = new Set(['pending', 'initiating', 'running']);

// gameday.json のインジェクトで「セットアップ時に運営が書く静的フィールド」。
// これ以外 (導出フィールド・実績・スコア類) はリセットで落とす。
const KEEP_INJECT_FIELDS = [
  'id',
  'scenarioId',
  'round',
  'title',
  'instruction',
  'maxScore',
  'hints',
  'experimentTemplateId',
] as const;

interface Options {
  dryRun: boolean;
  skipDeploy: boolean;
  skipDrift: boolean;
  cdkArgs: string[];
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { dryRun: false, skipDeploy: false, skipDrift: false, cdkArgs: [] };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--skip-deploy') opts.skipDeploy = true;
    else if (arg === '--skip-drift') opts.skipDrift = true;
    else opts.cdkArgs.push(arg);
  }
  return opts;
}

function log(message: string): void {
  console.log(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** npx コマンドを stdio 引き継ぎで実行 (Windows では .cmd のため shell 経由が必要) */
function runCli(args: string[]): number {
  const result = spawnSync('npx', args, { stdio: 'inherit', shell: true, cwd: ROOT });
  return result.status ?? 1;
}

/** ステップ 0: スタックの存在確認。未デプロイで deploy するとフルデプロイ (20〜30 分) になるため止める */
async function ensureStackDeployed(cfn: CloudFormationClient): Promise<void> {
  try {
    await cfn.send(new DescribeStacksCommand({ StackName: MAIN_STACK }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('does not exist')) {
      throw new Error(
        `スタック ${MAIN_STACK} が未デプロイ。周回リセットはデプロイ済み環境が対象 — 初回は npm run deploy を使う`,
      );
    }
    throw e; // 認証エラー等はそのまま見せる
  }
}

/** ステップ 1: gameday-* テンプレート由来の実行中 FIS 実験を停止し、終了を待つ */
async function stopRunningExperiments(fis: FisClient, dryRun: boolean): Promise<void> {
  // GameDay の実験テンプレート = tags.Name が gameday- で始まるもの (本体 3 種 + legacy 1 種)
  const templateIds = new Set<string>();
  let nextToken: string | undefined;
  do {
    const page = await fis.send(new ListExperimentTemplatesCommand({ nextToken }));
    for (const t of page.experimentTemplates ?? []) {
      if (t.id && t.tags?.Name?.startsWith('gameday-')) templateIds.add(t.id);
    }
    nextToken = page.nextToken;
  } while (nextToken);
  log(`   GameDay の実験テンプレート: ${templateIds.size} 件`);

  const active: { id: string; status: string }[] = [];
  nextToken = undefined;
  do {
    const page: ListExperimentsCommandOutput = await fis.send(
      new ListExperimentsCommand({ nextToken }),
    );
    for (const exp of page.experiments ?? []) {
      const status = exp.state?.status ?? '';
      if (!exp.id || !ACTIVE_STATUSES.has(status)) continue;
      if (exp.experimentTemplateId && !templateIds.has(exp.experimentTemplateId)) continue;
      active.push({ id: exp.id, status });
    }
    nextToken = page.nextToken;
  } while (nextToken);

  if (active.length === 0) {
    log('   実行中の実験なし');
    return;
  }
  for (const exp of active) {
    if (dryRun) {
      log(`   [dry-run] 停止対象: ${exp.id} (${exp.status})`);
      continue;
    }
    log(`   停止: ${exp.id} (${exp.status})`);
    await fis.send(new StopExperimentCommand({ id: exp.id }));
  }
  if (dryRun) return;

  // 停止完了 (stopped/completed/failed) を待つ。aws:fis:wait 中の停止は数秒で終わる
  const deadline = Date.now() + 180_000;
  for (const exp of active) {
    for (;;) {
      const res = await fis.send(new GetExperimentCommand({ id: exp.id }));
      const status = res.experiment?.state?.status ?? '';
      if (!ACTIVE_STATUSES.has(status) && status !== 'stopping') {
        log(`   ${exp.id} → ${status}`);
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`実験 ${exp.id} が 3 分待っても止まらない (現在: ${status})。手で確認して再実行を`);
      }
      await sleep(5000);
    }
  }
}

/** ステップ 3: gameday-score テーブルの全アイテム削除 (SCORE / EVENT# / ACK# / FIRED#) */
async function truncateScoreTable(ddb: DynamoDBClient, dryRun: boolean): Promise<void> {
  const keys: { pk: { S: string } }[] = [];
  let startKey: Record<string, { S?: string }> | undefined;
  try {
    do {
      const page = await ddb.send(
        new ScanCommand({
          TableName: TABLE_NAME,
          ProjectionExpression: 'pk',
          ExclusiveStartKey: startKey as never,
        }),
      );
      for (const item of page.Items ?? []) {
        const pk = item.pk?.S;
        if (pk) keys.push({ pk: { S: pk } });
      }
      startKey = page.LastEvaluatedKey as never;
    } while (startKey);
  } catch (e) {
    if (e instanceof Error && e.name === 'ResourceNotFoundException') {
      log(`   テーブル ${TABLE_NAME} が無い (スタック未デプロイ?) — スキップ`);
      return;
    }
    throw e;
  }

  if (keys.length === 0) {
    log('   アイテムなし (既にクリーン)');
    return;
  }
  const summary = new Map<string, number>();
  for (const k of keys) {
    const kind = k.pk.S.split('#')[0];
    summary.set(kind, (summary.get(kind) ?? 0) + 1);
  }
  const detail = [...summary.entries()].map(([k, n]) => `${k}×${n}`).join(', ');
  if (dryRun) {
    log(`   [dry-run] 削除対象: ${keys.length} アイテム (${detail})`);
    return;
  }

  // BatchWriteItem は 25 件ずつ。未処理分は少し待って再送する
  for (let i = 0; i < keys.length; i += 25) {
    let requests: WriteRequest[] = keys
      .slice(i, i + 25)
      .map((key) => ({ DeleteRequest: { Key: key } }));
    while (requests.length > 0) {
      const res = await ddb.send(
        new BatchWriteItemCommand({ RequestItems: { [TABLE_NAME]: requests } }),
      );
      requests = res.UnprocessedItems?.[TABLE_NAME] ?? [];
      if (requests.length > 0) await sleep(500);
    }
  }
  log(`   削除: ${keys.length} アイテム (${detail})`);
}

/** ステップ 4: gameday.json をアーカイブしてインジェクト定義だけの初期状態に戻す */
function resetGamedayJson(dryRun: boolean): void {
  const raw = readFileSync(DATA_PATH, 'utf8');
  const data = JSON.parse(raw) as Record<string, unknown>;
  const injects = (data.injects ?? []) as Record<string, unknown>[];

  if (dryRun) {
    const dynamic = ['events', 'review', 'feedback', 'hintReveals']
      .filter((k) => {
        const v = data[k];
        return Array.isArray(v) ? v.length > 0 : v !== undefined;
      })
      .join(', ');
    log(`   [dry-run] インジェクト ${injects.length} 件を初期化。クリア対象: ${dynamic || '(なし)'}`);
    return;
  }

  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = join(ARCHIVE_DIR, `gameday-${stamp}.json`);
  writeFileSync(archivePath, raw);

  // インジェクトは静的フィールドだけ残し、status を pending へ。トップレベルの実績も落とす
  const reset: Record<string, unknown> = {};
  if (data.event !== undefined) reset.event = data.event;
  if (data.rounds !== undefined) reset.rounds = data.rounds;
  if (data.systems !== undefined) reset.systems = data.systems;
  reset.injects = injects.map((inject) => {
    const out: Record<string, unknown> = {};
    for (const field of KEEP_INJECT_FIELDS) {
      if (inject[field] !== undefined) out[field] = inject[field];
    }
    out.status = 'pending';
    return out;
  });
  reset.feedback = [];
  reset.hintReveals = [];
  if (data.scoring !== undefined) reset.scoring = data.scoring;
  reset.events = [];
  // review は意図的に持ち越さない (前回の講評は archive とレポートに残る)

  // dev サーバのポーリングに部分書き込みを読ませない (vite.config.ts と同じ tmp→rename)
  const tmp = `${DATA_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(reset, null, 2)}\n`);
  renameSync(tmp, DATA_PATH);
  log(`   初期化完了。旧データ: ${archivePath}`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const mode = opts.dryRun ? ' (dry-run: 変更なし)' : '';
  log(`=== GameDay 周回リセット${mode} ===`);

  log('[0/5] スタックの確認');
  await ensureStackDeployed(new CloudFormationClient({}));
  log(`   ${MAIN_STACK} はデプロイ済み`);

  log('[1/5] 実行中の FIS 実験を停止');
  await stopRunningExperiments(new FisClient({}), opts.dryRun);

  log('[2/5] ドリフトをコードの状態へ revert (cdk deploy --all --revert-drift)');
  if (opts.dryRun || opts.skipDeploy) {
    log('   スキップ');
  } else {
    const args = ['cdk', 'deploy', '--all', '--revert-drift', '--require-approval', 'never', ...opts.cdkArgs];
    const code = runCli(args);
    if (code !== 0) throw new Error(`cdk deploy --revert-drift が失敗した (exit ${code})`);
  }

  log(`[3/5] ゲーム状態のワイプ (DynamoDB ${TABLE_NAME})`);
  await truncateScoreTable(new DynamoDBClient({}), opts.dryRun);

  log('[4/5] gameday.json の初期化');
  resetGamedayJson(opts.dryRun);

  log('[5/5] ドリフト確認 (cdk drift --fail)');
  if (opts.dryRun || opts.skipDrift) {
    log('   スキップ');
  } else if (runCli(['cdk', 'drift', '--fail']) !== 0) {
    log('⚠ ドリフトが残っている。スタック外の手動リソース (scenario-03 の復旧物など) は revert の');
    log('  対象外なので、シナリオの棚卸しリストに従って手動で片付けてから再確認する。');
    process.exitCode = 1;
    return;
  }

  log('');
  if (opts.dryRun) {
    log('dry-run 完了 (何も変更していない)。本実行は npm run reset。');
    return;
  }
  log('リセット完了。canary が緑に戻るまで数分待ってから次のラウンドを開始する。');
  log('(ダッシュボードは開き直せば初期状態。FIS テンプレート ID は変わっていない)');
}

main().catch((e: unknown) => {
  console.error(`リセット失敗: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
