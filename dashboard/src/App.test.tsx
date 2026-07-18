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

// App はポーリングで res.text() → JSON.parse する。reveal/ack 時は POST /api/*。
// stub は GET に fixture を返し、POST は ok を返す。呼び出しは spy で検証できる。
const respond = (payload: GamedayData) => async () => ({
  ok: true,
  text: async () => JSON.stringify(payload),
});
const fetchMock = vi.fn(respond(data));
vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockClear();
  fetchMock.mockImplementation(respond(data)); // テスト個別のデータ差し替えを毎回リセット
});
afterEach(cleanup);

async function renderApp() {
  const utils = render(<App />);
  await waitFor(() => {
    expect(utils.container.querySelectorAll('.tile').length).toBeGreaterThan(0);
  });
  return utils;
}

test('サマリータイルが 4 枚描画される (手動 150 + 自動採点 95 − ヒント消費 20 = 225)', async () => {
  const { container } = await renderApp();
  expect(container.querySelectorAll('.tile')).toHaveLength(4);
  // 手動 (90+60) + inject-4 の自動採点 (検知40+復旧40+伝達15=95) − サーバ記録の h1-2 (20pt)
  expect(container.querySelector('.tile.hero .tile-value')?.textContent).toContain('225');
});

test('LIVE インジケータが出る (リアルタイム反映中)', async () => {
  const { container } = await renderApp();
  expect(container.querySelector('.live-badge')?.textContent).toContain('LIVE');
});

test('スコア表にインジェクト分の行 + ラウンド見出し行が出る', async () => {
  const { container } = await renderApp();
  const roundCount = new Set(data.injects.map((i) => i.round)).size;
  // inject 行 + ラウンドごとの見出し行
  expect(container.querySelectorAll('tbody tr')).toHaveLength(data.injects.length + roundCount);
  expect(container.querySelectorAll('tbody tr.round-header')).toHaveLength(roundCount);
});

test('チャートに 2 系列 × 時間記録のあるインジェクト分のバーと凡例が描かれる', async () => {
  const { container } = await renderApp();
  // 時間の記録が無い armed の inject-3 はチャートに出ない
  const chartRows = data.injects.filter(
    (i) => typeof i.detectionMinutes === 'number' || typeof i.recoveryMinutes === 'number',
  );
  expect(container.querySelectorAll('.chart-wrap path.bar')).toHaveLength(chartRows.length * 2);
  expect(container.querySelectorAll('.legend .legend-item')).toHaveLength(2);
});

test('システム構成カードにタブ・構成図・補足が描画される', async () => {
  const { container } = await renderApp();
  // システムの数だけタブが出て、最初のシステムがアクティブ
  expect(container.querySelectorAll('.arch-tab')).toHaveLength(data.systems!.length);
  expect(container.querySelector('.arch-tab.active')?.textContent).toBe('本体 (3 層 Web)');
  // 最初のシステム (3 層) の図: 層 3 つ・ノード 3 つ・層間の矢印 2 つ
  expect(container.querySelectorAll('.arch-tier')).toHaveLength(3);
  expect(container.querySelectorAll('.arch-node')).toHaveLength(3);
  expect(container.querySelectorAll('.arch-arrow')).toHaveLength(2);
  // AWS アイコン: ノード 3 つ全部 + 層アイコン 2 つ (public-subnet / private-subnet)
  expect(container.querySelectorAll('.arch-node-icon')).toHaveLength(3);
  expect(container.querySelectorAll('.arch-tier-icon')).toHaveLength(2);
  // 補足 (notes) も出る
  expect(container.querySelectorAll('.arch-notes li')).toHaveLength(1);
});

test('システム構成タブは手動クリックで切り替えられる', async () => {
  const { container } = await renderApp();

  fireEvent.click(container.querySelectorAll('.arch-tab')[1]);
  expect(container.querySelector('.arch-tab.active')?.textContent).toBe('サブ環境 (検証用)');
  expect(container.querySelectorAll('.arch-node')).toHaveLength(2);
  // 不明なアイコンキー (unknown-icon-key) はアイコン無しで描画され、壊れない
  expect(container.querySelectorAll('.arch-node-icon')).toHaveLength(1);

  fireEvent.click(container.querySelectorAll('.arch-tab')[0]);
  expect(container.querySelector('.arch-tab.active')?.textContent).toBe('本体 (3 層 Web)');
});

test('KPT フィードバックが全件表示される', async () => {
  const { container } = await renderApp();
  expect(container.querySelectorAll('.kpt-card')).toHaveLength(data.feedback.length);
});

test('絞り込み UI は無い (2026-07-18 リハーサルで撤去) — 常に全インジェクトが表示される', async () => {
  const { container } = await renderApp();
  expect(container.querySelector('.filter-row select')).toBeNull();
  const roundCount = new Set(data.injects.map((i) => i.round)).size;
  expect(container.querySelectorAll('tbody tr')).toHaveLength(data.injects.length + roundCount);
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

  // 初期: 225 (245 − サーバ記録 20)。ロックは h1-1 (方針, cost 5) の 1 つ
  expect(container.querySelector('.tile.hero .tile-value')?.textContent).toContain('225');
  const locked = container.querySelectorAll<HTMLButtonElement>('.hint-reveal');
  expect(locked.length).toBe(1);

  fireEvent.click(locked[0]);

  // サーバに記録するため /api/reveal-hint へ POST する
  expect(fetchMock).toHaveBeenCalledWith(
    'api/reveal-hint',
    expect.objectContaining({ method: 'POST' }),
  );
  // 楽観更新で即座に 220 (225 − 5) に下がり、該当セルに消費が出る
  expect(container.querySelector('.tile.hero .tile-value')?.textContent).toContain('220');
  expect(container.querySelector('.score-penalty')?.textContent).toContain('5pt');
});

test('実験進行中 (armed): バナーは出るが検知宣言ボタンはまだ出ない (満点抜け道の防止)', async () => {
  const { container } = await renderApp();
  const banner = container.querySelector('.ack-banner.armed');
  expect(banner).not.toBeNull();
  expect(banner?.textContent).toContain('実験進行中');
  expect(banner?.querySelector('.ack-button')).toBeNull();
  // ステータスチップにも armed が出る
  expect(container.textContent).toContain('実験進行中');
});

test('影響発生中: 検知宣言ボタンを押すと POST /api/ack + 楽観更新で宣言済みになる', async () => {
  // inject-3 が impacted になった状態をサーバ応答として差し替える
  const impacted: GamedayData = {
    ...data,
    injects: data.injects.map((i) =>
      i.id === 'inject-3'
        ? { ...i, status: 'impacted' as const, impactStartAt: '2026-07-15T04:10:00Z' }
        : i,
    ),
  };
  fetchMock.mockImplementation(respond(impacted));
  const { container } = await renderApp();

  const button = container.querySelector<HTMLButtonElement>('.ack-banner .ack-button');
  expect(button).not.toBeNull();
  fireEvent.click(button!);

  expect(fetchMock).toHaveBeenCalledWith('api/ack', expect.objectContaining({ method: 'POST' }));
  // 楽観更新でバナーが「宣言済み」表示に変わる
  expect(container.querySelector('.ack-banner .ack-done')?.textContent).toContain('検知宣言');
});

test('自動採点されたインジェクトはスコアセルに内訳 (検知/復旧/伝達) が出る', async () => {
  const { container } = await renderApp();
  // inject-4: 検知 2 分 = 40、復旧 5 分 = 40、伝達 15 (手動)
  const breakdown = container.querySelector('.score-breakdown');
  expect(breakdown?.textContent).toContain('検知 40/40');
  expect(breakdown?.textContent).toContain('復旧 40/40');
  expect(breakdown?.textContent).toContain('伝達 15/20');
});

test('AI 講評ボタンは KPT カード内にあり、生成すると POST /api/review する', async () => {
  const { container } = await renderApp();
  // fixture に AI 講評 (author='AI 講評') は無いので初回生成のラベル
  const btn = container.querySelector<HTMLButtonElement>('.review-generate');
  expect(btn?.textContent).toBe('AI 講評を KPT で生成');
  fireEvent.click(btn!);
  expect(fetchMock).toHaveBeenCalledWith('api/review', expect.objectContaining({ method: 'POST' }));
});

test('AI 講評 (author 付き feedback) は KPT ボードに author 表示付きで並び、ボタンは再生成表示になる', async () => {
  const withAi: GamedayData = {
    ...data,
    feedback: [
      ...data.feedback,
      { type: 'try', comment: '検知宣言を 2 分以内に出す', author: 'AI 講評' },
    ],
  };
  fetchMock.mockImplementation(respond(withAi));
  const { container } = await renderApp();
  expect(container.querySelectorAll('.kpt-card')).toHaveLength(withAi.feedback.length);
  expect(container.textContent).toContain('AI 講評');
  expect(container.querySelector('.review-generate')?.textContent).toBe('AI 講評 (KPT) を再生成');
});

test('ゲーム進行: プレイ済み + 振り返りありの fixture ではリトライだけが出る (開始は出ない)', async () => {
  const { container } = await renderApp();
  expect(container.querySelector('.game-start')).toBeNull();
  expect(container.querySelector('.game-retry')).not.toBeNull();
});

test('ゲーム進行: 全 pending の初期データでは開始ボタンだけが出て、押すと POST /api/start する', async () => {
  const fresh: GamedayData = {
    ...data,
    feedback: [],
    hintReveals: [],
    events: [],
    injects: data.injects.map(({ id, title, scenarioId, round, experimentTemplateId }) => ({
      id,
      title,
      scenarioId,
      round,
      experimentTemplateId,
      status: 'pending' as const,
    })),
  };
  fetchMock.mockImplementation(respond(fresh));
  const { container } = await renderApp();

  expect(container.querySelector('.game-retry')).toBeNull();
  const startBtn = container.querySelector<HTMLButtonElement>('.game-start');
  expect(startBtn).not.toBeNull();
  // ボタンは動詞だけ (「停止」等を含むインジェクト名を混ぜない)。対象名は隣の注記に出る
  expect(startBtn?.textContent).toBe('▶ GameDay を開始する');
  const candidate = fresh.injects.find((i) => i.experimentTemplateId)!;
  expect(container.querySelector('.game-note')?.textContent).toContain(candidate.title);

  fireEvent.click(startBtn!);
  expect(fetchMock).toHaveBeenCalledWith('api/start', expect.objectContaining({ method: 'POST' }));
  // 開始対象の injectId をボディで渡している (fetchMock は引数無し宣言のため型を付け直す)
  const calls = fetchMock.mock.calls as unknown as [string, { body?: string }?][];
  const call = calls.find((c) => c[0] === 'api/start');
  expect(call?.[1]?.body).toContain(candidate.id);
});

test('ゲーム進行: リトライは 2 段階クリックで初めて POST /api/reset を叩く (誤爆防止)', async () => {
  const { container } = await renderApp();
  const btn = container.querySelector<HTMLButtonElement>('.game-retry')!;

  fireEvent.click(btn);
  expect(btn.textContent).toContain('もう一度クリック');
  expect(fetchMock).not.toHaveBeenCalledWith('api/reset', expect.objectContaining({ method: 'POST' }));

  fireEvent.click(btn);
  expect(fetchMock).toHaveBeenCalledWith('api/reset', expect.objectContaining({ method: 'POST' }));
});
