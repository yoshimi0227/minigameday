import { test, expect } from 'vitest';
import {
  DEFAULT_SCORING,
  autoScore,
  decayPoints,
  deriveFromEvents,
  effectiveScore,
  resolveScore,
} from './scoring';
import type { GameEvent, GamedayData, Inject } from './types';

// ---- decayPoints (採点カーブ) ----

test('decayPoints: 満点圏内・線形減衰・ゼロ圏・負分 (影響前) を正しく返す', () => {
  const curve = { maxPoints: 40, fullWithinMinutes: 2, zeroAfterMinutes: 15 };
  expect(decayPoints(0, curve)).toBe(40); // 即時
  expect(decayPoints(2, curve)).toBe(40); // 境界 = 満点
  expect(decayPoints(15, curve)).toBe(0); // 境界 = 0
  expect(decayPoints(30, curve)).toBe(0); // 超過
  expect(decayPoints(8.5, curve)).toBe(20); // 中間 = 線形 (13 分幅の半分)
  expect(decayPoints(-1, curve)).toBe(40); // 影響前に検知 = 満点
});

// ---- resolveScore (優先順位) ----

const scoredInject: Inject = {
  id: 'i1',
  title: 't',
  impactStartAt: '2026-07-15T02:10:00Z',
  ackAt: '2026-07-15T02:12:00Z', // 検知 2 分 → 40 点
  recoveredAt: '2026-07-15T02:15:00Z', // 復旧 5 分 → 40 点
  commsScore: 15,
};

test('autoScore: 3 タイムスタンプが揃えば 検知+復旧+伝達 の合計', () => {
  expect(autoScore(scoredInject)).toBe(95); // 40 + 40 + 15
  // commsScore は上限で clamp、負は 0
  expect(autoScore({ ...scoredInject, commsScore: 99 })).toBe(100);
  expect(autoScore({ ...scoredInject, commsScore: -5 })).toBe(80);
  // 材料不足なら undefined (canary 死角の障害は自動採点しない)
  expect(autoScore({ ...scoredInject, recoveredAt: undefined })).toBeUndefined();
  expect(autoScore({ id: 'i', title: 't' })).toBeUndefined();
});

test('resolveScore: scoreOverride > 自動採点 > 手動 score の順に解決する', () => {
  expect(resolveScore({ ...scoredInject, score: 50, scoreOverride: 77 })).toBe(77);
  expect(resolveScore({ ...scoredInject, score: 50 })).toBe(95); // 自動が手動 score に勝つ
  expect(resolveScore({ id: 'i', title: 't', score: 50 })).toBe(50); // 手動フォールバック
  expect(resolveScore({ id: 'i', title: 't' })).toBeUndefined(); // 未採点
});

test('effectiveScore: 素点 − ヒント消費 (0 下限)。素点は resolveScore で解決する', () => {
  const withHints: Inject = {
    ...scoredInject,
    hints: [
      { id: 'h1', label: 'a', cost: 10, text: '' },
      { id: 'h2', label: 'b', cost: 20, text: '' },
    ],
  };
  expect(effectiveScore(withHints, new Set(['h1']))).toBe(85); // 95 - 10
  expect(effectiveScore(withHints, new Set())).toBe(95);
  expect(effectiveScore({ id: 'i', title: 't' }, new Set())).toBeUndefined();
});

// ---- deriveFromEvents ----

function makeData(injects: Inject[], events: GameEvent[]): GamedayData {
  return { event: { title: 't' }, injects, feedback: [], events };
}

const running = (at: string, expId: string, templateId: string): GameEvent => ({
  key: `EVENT#${at}#${expId}`,
  type: 'experiment',
  at,
  experimentId: expId,
  experimentTemplateId: templateId,
  status: 'running',
});
const alarm = (at: string, state: 'ALARM' | 'OK'): GameEvent => ({
  key: `EVENT#${at}#${state}`,
  type: 'alarm',
  at,
  alarmName: 'gameday-canary-health',
  state,
});
const ack = (at: string, injectId: string): GameEvent => ({
  key: `ACK#${injectId}`,
  type: 'ack',
  at,
  injectId,
});

test('deriveFromEvents: running → ALARM → ack → OK の正常系で armed/impacted/recovered が導出される', () => {
  const inject: Inject = { id: 'i1', title: 't', experimentTemplateId: 'EXT1' };
  const data = makeData(
    [inject],
    [
      running('2026-07-15T02:00:00Z', 'EXP1', 'EXT1'),
      alarm('2026-07-15T02:10:00Z', 'ALARM'),
      ack('2026-07-15T02:13:00Z', 'i1'),
      alarm('2026-07-15T02:20:00Z', 'OK'),
    ],
  );
  expect(deriveFromEvents(data)).toBe(true);
  expect(inject.experimentId).toBe('EXP1');
  expect(inject.experimentStartedAt).toBe('2026-07-15T02:00:00Z');
  expect(inject.impactStartAt).toBe('2026-07-15T02:10:00Z');
  expect(inject.ackAt).toBe('2026-07-15T02:13:00Z');
  expect(inject.recoveredAt).toBe('2026-07-15T02:20:00Z');
  expect(inject.detectionMinutes).toBe(3);
  expect(inject.recoveryMinutes).toBe(10);
  expect(inject.status).toBe('recovered');
});

test('deriveFromEvents: 段階遷移 — running だけなら armed、ALARM で impacted', () => {
  const inject: Inject = { id: 'i1', title: 't', experimentTemplateId: 'EXT1' };
  const data = makeData([inject], [running('2026-07-15T02:00:00Z', 'EXP1', 'EXT1')]);
  deriveFromEvents(data);
  expect(inject.status).toBe('armed');

  data.events!.push(alarm('2026-07-15T02:10:00Z', 'ALARM'));
  deriveFromEvents(data);
  expect(inject.status).toBe('impacted');
  expect(inject.recoveredAt).toBeUndefined();
});

test('deriveFromEvents: フラッピング — 再 ALARM で recoveredAt が消え、最後の OK で確定する', () => {
  const inject: Inject = { id: 'i1', title: 't', experimentTemplateId: 'EXT1' };
  const data = makeData(
    [inject],
    [
      running('2026-07-15T02:00:00Z', 'EXP1', 'EXT1'),
      alarm('2026-07-15T02:10:00Z', 'ALARM'),
      alarm('2026-07-15T02:12:00Z', 'OK'),
      alarm('2026-07-15T02:14:00Z', 'ALARM'), // フラップ (再発)
    ],
  );
  deriveFromEvents(data);
  expect(inject.status).toBe('impacted');
  expect(inject.recoveredAt).toBeUndefined(); // 途中の OK では確定しない

  data.events!.push(alarm('2026-07-15T02:25:00Z', 'OK'));
  deriveFromEvents(data);
  expect(inject.recoveredAt).toBe('2026-07-15T02:25:00Z'); // 最後の OK
  expect(inject.impactStartAt).toBe('2026-07-15T02:10:00Z'); // 最初の ALARM のまま
  expect(inject.recoveryMinutes).toBe(15);
});

test('deriveFromEvents: 多重実験 — アラームは「その時刻以前に armed になった最新の inject」に帰属する', () => {
  const i1: Inject = { id: 'i1', title: 't1', experimentTemplateId: 'EXT1' };
  const i2: Inject = { id: 'i2', title: 't2', experimentTemplateId: 'EXT2' };
  const data = makeData(
    [i1, i2],
    [
      running('2026-07-15T02:00:00Z', 'EXP1', 'EXT1'),
      alarm('2026-07-15T02:05:00Z', 'ALARM'),
      alarm('2026-07-15T02:08:00Z', 'OK'),
      running('2026-07-15T02:30:00Z', 'EXP2', 'EXT2'), // i1 復旧後に 2 発目 armed
      alarm('2026-07-15T02:40:00Z', 'ALARM'),
      alarm('2026-07-15T02:50:00Z', 'OK'),
    ],
  );
  deriveFromEvents(data);
  expect(i1.impactStartAt).toBe('2026-07-15T02:05:00Z');
  expect(i1.recoveredAt).toBe('2026-07-15T02:08:00Z');
  expect(i2.impactStartAt).toBe('2026-07-15T02:40:00Z');
  expect(i2.recoveredAt).toBe('2026-07-15T02:50:00Z');
  expect(i1.status).toBe('recovered');
  expect(i2.status).toBe('recovered');
});

test('deriveFromEvents: staleness 窓 — 実験開始から 2 時間超のアラーム遷移は帰属させない (フレーク対策)', () => {
  // ラウンド終了後 (次の inject が armed になる前) の canary フレークが、最後の inject の
  // recoveredAt を引き伸ばして MTTR を汚さないこと
  const inject: Inject = { id: 'i1', title: 't', experimentTemplateId: 'EXT1' };
  const data = makeData(
    [inject],
    [
      running('2026-07-15T02:00:00Z', 'EXP1', 'EXT1'),
      alarm('2026-07-15T02:10:00Z', 'ALARM'),
      alarm('2026-07-15T02:20:00Z', 'OK'),
      alarm('2026-07-15T06:00:00Z', 'ALARM'), // 4 時間後のフレーク
      alarm('2026-07-15T06:01:00Z', 'OK'),
    ],
  );
  deriveFromEvents(data);
  expect(inject.impactStartAt).toBe('2026-07-15T02:10:00Z');
  expect(inject.recoveredAt).toBe('2026-07-15T02:20:00Z'); // フレークの OK に引き伸ばされない
  expect(inject.recoveryMinutes).toBe(10);
  expect(inject.status).toBe('recovered');
});

test('deriveFromEvents: 窓内 (2 時間以内) の再 ALARM は従来どおりフラッピングとして扱う', () => {
  const inject: Inject = { id: 'i1', title: 't', experimentTemplateId: 'EXT1' };
  const data = makeData(
    [inject],
    [
      running('2026-07-15T02:00:00Z', 'EXP1', 'EXT1'),
      alarm('2026-07-15T02:10:00Z', 'ALARM'),
      alarm('2026-07-15T02:20:00Z', 'OK'),
      alarm('2026-07-15T03:30:00Z', 'ALARM'), // 90 分後 = 窓内の再発
    ],
  );
  deriveFromEvents(data);
  expect(inject.status).toBe('impacted');
  expect(inject.recoveredAt).toBeUndefined();
});

test('deriveFromEvents: 冪等 — 同じ events で 2 回呼ぶと 2 回目は変更なし (false)', () => {
  const inject: Inject = { id: 'i1', title: 't', experimentTemplateId: 'EXT1' };
  const data = makeData(
    [inject],
    [
      running('2026-07-15T02:00:00Z', 'EXP1', 'EXT1'),
      alarm('2026-07-15T02:10:00Z', 'ALARM'),
      alarm('2026-07-15T02:20:00Z', 'OK'),
    ],
  );
  expect(deriveFromEvents(data)).toBe(true);
  expect(deriveFromEvents(data)).toBe(false);
});

test('deriveFromEvents: 影響なし (ALARM が来ない) は自動採点材料を作らない = 手動フォールバック', () => {
  const inject: Inject = { id: 'i1', title: 't', experimentTemplateId: 'EXT1', score: 80 };
  const data = makeData([inject], [running('2026-07-15T02:00:00Z', 'EXP1', 'EXT1')]);
  deriveFromEvents(data);
  expect(inject.impactStartAt).toBeUndefined();
  expect(autoScore(inject)).toBeUndefined();
  expect(resolveScore(inject)).toBe(80); // 手動 score が生きる
});

test('deriveFromEvents: 手動確定 status と手動採点済みの既存 inject を上書きしない', () => {
  // 既存の手動採点データ (イベント材料なし) は一切触らない
  const manual: Inject = {
    id: 'old',
    title: '手動採点済み',
    status: 'success',
    score: 93,
    detectionMinutes: 1,
    recoveryMinutes: 0.5,
  };
  // 手動確定 status はイベント材料があっても維持される
  const finalized: Inject = {
    id: 'i1',
    title: 't',
    experimentTemplateId: 'EXT1',
    status: 'partial',
  };
  const data = makeData(
    [manual, finalized],
    [
      running('2026-07-15T02:00:00Z', 'EXP1', 'EXT1'),
      alarm('2026-07-15T02:10:00Z', 'ALARM'),
      alarm('2026-07-15T02:20:00Z', 'OK'),
    ],
  );
  deriveFromEvents(data);
  expect(manual).toEqual({
    id: 'old',
    title: '手動採点済み',
    status: 'success',
    score: 93,
    detectionMinutes: 1,
    recoveryMinutes: 0.5,
  });
  expect(finalized.status).toBe('partial'); // 上書きされない
  expect(finalized.recoveredAt).toBe('2026-07-15T02:20:00Z'); // タイムスタンプは記録される
});

test('deriveFromEvents: 手書きの impactStartAt + ackAt からも分数を再計算する (アラームイベント不在)', () => {
  const inject: Inject = {
    id: 'i1',
    title: 't',
    impactStartAt: '2026-07-15T02:10:00Z', // 運営が手書き (イベント取り逃し時のフォールバック)
    ackAt: '2026-07-15T02:14:30Z',
  };
  const data = makeData([inject], [ack('2026-07-15T02:14:30Z', 'i1')]);
  deriveFromEvents(data);
  expect(inject.detectionMinutes).toBe(4.5);
  expect(inject.status).toBe('impacted');
});

test('deriveFromEvents: FIS イベント取り逃し時は experimentStartedAt の手書きで同じに動く', () => {
  const inject: Inject = {
    id: 'i1',
    title: 't',
    experimentTemplateId: 'EXT1',
    experimentStartedAt: '2026-07-15T02:00:00Z', // 運営が手書き (running イベント無し)
  };
  const data = makeData(
    [inject],
    [alarm('2026-07-15T02:10:00Z', 'ALARM'), alarm('2026-07-15T02:20:00Z', 'OK')],
  );
  deriveFromEvents(data);
  expect(inject.impactStartAt).toBe('2026-07-15T02:10:00Z');
  expect(inject.status).toBe('recovered');
});

test('DEFAULT_SCORING: ルーブリック配分 (検知 40 / 復旧 40 / 伝達 20) を守る', () => {
  expect(DEFAULT_SCORING.detection.maxPoints).toBe(40);
  expect(DEFAULT_SCORING.recovery.maxPoints).toBe(40);
  expect(DEFAULT_SCORING.commsMaxPoints).toBe(20);
});
