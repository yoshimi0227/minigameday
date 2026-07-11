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

// App はポーリングで res.text() → JSON.parse する。stub も text() を返す。
vi.stubGlobal(
  'fetch',
  (async () => ({ ok: true, text: async () => JSON.stringify(data) })) as unknown as typeof fetch,
);

beforeEach(() => localStorage.clear());
afterEach(cleanup);

async function renderApp() {
  const utils = render(<App />);
  await waitFor(() => {
    expect(utils.container.querySelectorAll('.tile').length).toBeGreaterThan(0);
  });
  return utils;
}

test('サマリータイルが 4 枚描画される', async () => {
  const { container } = await renderApp();
  expect(container.querySelectorAll('.tile')).toHaveLength(4);
  expect(container.querySelector('.tile.hero .tile-value')?.textContent).toContain('150');
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

test('ヒントはロック状態で表示され、開示するとポイント消費でスコアが減る', async () => {
  const { container } = await renderApp();

  // 初期: 総合スコア 150 (= 90 + 60、ヒント未消費)
  expect(container.querySelector('.tile.hero .tile-value')?.textContent).toContain('150');
  // ロックされたヒントボタンがある (fixture の inject-1 に 2 つ)、本文はまだ無い
  const locked = container.querySelectorAll<HTMLButtonElement>('.hint-reveal');
  expect(locked.length).toBe(2);
  expect(container.querySelectorAll('.hint-text')).toHaveLength(0);

  // 「方針」(cost 5) を開示 → 本文が 1 つ出て、総合スコアが 145 に下がる
  const houshin = [...locked].find((b) => b.textContent?.includes('方針'));
  expect(houshin).toBeTruthy();
  fireEvent.click(houshin!);

  expect(container.querySelectorAll('.hint-text')).toHaveLength(1);
  expect(container.querySelector('.tile.hero .tile-value')?.textContent).toContain('145');
  // 該当インジェクトのスコアセルにも消費が反映される (90 − 5 = 85)
  expect(container.querySelector('.score-penalty')?.textContent).toContain('5pt');
});
