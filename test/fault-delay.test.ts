import { test, expect } from 'vitest';
import { resolveFaultDelayMinutes } from '../lib/constructs/fault-injection';

/**
 * faultDelayMinutes のパース/乱数解決 (純関数) のバリデーションテスト。
 * synth 不要なので高速。乱数は注入して決定的に検証する。
 */

test('範囲 "5-15": 乱数 0 で下端、乱数 ~1 で上端 (両端を含む一様乱数)', () => {
  expect(resolveFaultDelayMinutes('5-15', () => 0)).toBe(5);
  expect(resolveFaultDelayMinutes('5-15', () => 0.9999)).toBe(15);
  expect(resolveFaultDelayMinutes('5-15', () => 0.5)).toBe(10);
});

test('単一値: 数値・文字列・両端同値の範囲はそのまま返す', () => {
  expect(resolveFaultDelayMinutes(7)).toBe(7);
  expect(resolveFaultDelayMinutes('7')).toBe(7);
  expect(resolveFaultDelayMinutes('7-7', () => 0.5)).toBe(7);
});

test('0 は「遅延なし」(既存挙動の維持)', () => {
  expect(resolveFaultDelayMinutes(0)).toBe(0);
  expect(resolveFaultDelayMinutes('0')).toBe(0);
});

test('不正値は synth 時に弾く (メッセージに faultDelayMinutes を含む)', () => {
  const bad: (number | string)[] = ['15-5', '0-10', '5-721', 'abc', '1-2-3', '1.5-3', 721, 1.5, -3];
  for (const spec of bad) {
    expect(() => resolveFaultDelayMinutes(spec, () => 0)).toThrow(/faultDelayMinutes/);
  }
});
