// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import App from './App';
import type { GamedayData } from './types';

/**
 * レンダリングスモークテスト。「データ → DOM」の描画が壊れていないことを守る。
 * 見た目 (レイアウト・配色) は対象外 — それは npm run dashboard で目視する。
 */

const data: GamedayData = JSON.parse(
  readFileSync(join(process.cwd(), 'dashboard', 'public', 'data', 'gameday.json'), 'utf8'),
);

vi.stubGlobal('fetch', (async () => ({ ok: true, json: async () => data })) as unknown as typeof fetch);

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
