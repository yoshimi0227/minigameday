// gameday.seed.json (定義シード) の配布ガード。
// seed はクローンした利用者全員の初期状態になるため、アカウント固有の値
// (experimentTemplateId 等) や前回プレイの実績が紛れ込んでいたら落とす。
import { test, expect } from 'vitest';
import seed from '../gameday.seed.json';
import type { GamedayData } from './types';

const data = seed as GamedayData;

test('seed はアカウント固有の experimentTemplateId を含まない (Name タグで指定し実行時解決)', () => {
  for (const inject of data.injects) {
    expect(inject.experimentTemplateId, `inject ${inject.id}`).toBeUndefined();
  }
});

test('seed の FIS 対象インジェクトは experimentTemplateName (gameday-* の Name タグ) を持つ', () => {
  const withName = data.injects.filter((i) => i.experimentTemplateName);
  expect(withName.length).toBeGreaterThan(0);
  for (const inject of withName) {
    expect(inject.experimentTemplateName, `inject ${inject.id}`).toMatch(/^gameday-/);
  }
});

test('seed は初期状態 (実績・イベント・派生フィールドが空)', () => {
  expect(data.feedback).toEqual([]);
  expect(data.hintReveals).toEqual([]);
  expect(data.events).toEqual([]);
  for (const inject of data.injects) {
    expect(inject.status, `inject ${inject.id}`).toBe('pending');
    expect(inject.experimentId, `inject ${inject.id}`).toBeUndefined();
    expect(inject.impactStartAt, `inject ${inject.id}`).toBeUndefined();
    expect(inject.score, `inject ${inject.id}`).toBeUndefined();
    expect(inject.scoreOverride, `inject ${inject.id}`).toBeUndefined();
  }
});

test('seed の id は一意 (inject / hint)', () => {
  const injectIds = data.injects.map((i) => i.id);
  expect(new Set(injectIds).size).toBe(injectIds.length);
  const hintIds = data.injects.flatMap((i) => (i.hints ?? []).map((h) => h.id));
  expect(new Set(hintIds).size).toBe(hintIds.length);
});
