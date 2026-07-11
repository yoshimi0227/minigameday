// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from './App';
import fixture from './testdata/gameday-fixture.json';
import type { GamedayData } from './types';

/**
 * レンダリングスモークテスト。「データ → DOM」の描画が壊れていないことを守る。
 * 本番データ (public/data/gameday.json) は GameDay 中に書き換わるため、
 * テストは固定フィクスチャを使う。見た目の確認は npm run dashboard で目視する。
 */

const data = fixture as GamedayData;

// App はポーリングで res.text() → JSON.parse する。reveal 時は POST /api/reveal-hint。
// stub は GET に fixture を返し、POST は ok を返す。呼び出しは spy で検証できる。
const fetchMock = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(data) }));
vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockClear();
});
afterEach(cleanup);

async function renderApp() {
  const utils = render(<App />);
  await waitFor(() => {
    expect(utils.container.querySelectorAll('.tile').length).toBeGreaterThan(0);
  });
  return utils;
}

test('サマリータイルが 4 枚描画される (サーバ記録のヒント消費 20pt を反映して 130)', async () => {
  const { container } = await renderApp();
  expect(container.querySelectorAll('.tile')).toHaveLength(4);
  // 素点 150 − サーバ記録の h1-2 (20pt) = 130
  expect(container.querySelector('.tile.hero .tile-value')?.textContent).toContain('130');
});

test('LIVE インジケータが出る (リアルタイム反映中)', async () => {
  const { container } = await renderApp();
  expect(container.querySelector('.live-badge')?.textContent).toContain('LIVE');
});

test('スコア表にインジェクト分の行が出る', async () => {
  const { container } = await renderApp();
  expect(container.querySelectorAll('tbody tr')).toHaveLength(data.injects.length);
});

test('チャートに 2 系列 × インジェクト分のバーと凡例が描かれる', async () => {
  const { container } = await renderApp();
  expect(container.querySelectorAll('.chart-wrap path.bar')).toHaveLength(data.injects.length * 2);
  expect(container.querySelectorAll('.legend .legend-item')).toHaveLength(2);
});

test('KPT フィードバックが全件表示される', async () => {
  const { container } = await renderApp();
  expect(container.querySelectorAll('.kpt-card')).toHaveLength(data.feedback.length);
});

test('シナリオフィルタが表・チャート・フィードバックを一括でスコープする', async () => {
  const { container, getByLabelText } = await renderApp();

  fireEvent.change(getByLabelText('シナリオ'), { target: { value: 'scenario-01' } });
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  expect(container.querySelectorAll('.chart-wrap path.bar')).toHaveLength(2);
  // scenario-01 固有 + 全体 (scenarioId: null) のフィードバックだけが残る
  const visible = data.feedback.filter((f) => f.scenarioId === 'scenario-01' || f.scenarioId == null);
  expect(container.querySelectorAll('.kpt-card')).toHaveLength(visible.length);

  fireEvent.change(getByLabelText('シナリオ'), { target: { value: '' } });
  expect(container.querySelectorAll('tbody tr')).toHaveLength(data.injects.length);
});

test('サーバ記録済みのヒント (h1-2) は開示状態で表示され、消費サマリに出る', async () => {
  const { container } = await renderApp();
  // h1-2 はサーバ (hintReveals) 記録済みなのでロックされていない → 本文が 1 つ出ている
  expect(container.querySelectorAll('.hint-text')).toHaveLength(1);
  // 消費サマリに合計 −20pt が出る
  const summary = container.querySelector('.hint-total');
  expect(summary?.textContent).toContain('20');
});

test('ロックされたヒントを開示すると POST し、ポイント消費でスコアが減る', async () => {
  const { container } = await renderApp();

  // 初期: 130 (150 − サーバ記録 20)。ロックは h1-1 (方針, cost 5) の 1 つ
  expect(container.querySelector('.tile.hero .tile-value')?.textContent).toContain('130');
  const locked = container.querySelectorAll<HTMLButtonElement>('.hint-reveal');
  expect(locked.length).toBe(1);

  fireEvent.click(locked[0]);

  // サーバに記録するため /api/reveal-hint へ POST する
  expect(fetchMock).toHaveBeenCalledWith(
    'api/reveal-hint',
    expect.objectContaining({ method: 'POST' }),
  );
  // 楽観更新で即座に 125 (130 − 5) に下がり、該当セルに消費が出る
  expect(container.querySelector('.tile.hero .tile-value')?.textContent).toContain('125');
  expect(container.querySelector('.score-penalty')?.textContent).toContain('5pt');
});
