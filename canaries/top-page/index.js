// CloudWatch Synthetics canary (Playwright ランタイム / syn-nodejs-playwright-6.0)
// ユーザー目線でトップページを開き、HTTP ステータスとスクリーンショットを記録する。
// 障害注入の前後でこの canary の成功率を見るのが「振り返り」の主指標。
const { synthetics } = require('@aws/synthetics-playwright');
const { expect } = require('@playwright/test');

const TARGET_URL = process.env.URL;

exports.handler = async () => {
  const browser = await synthetics.launch();
  try {
    const page = await synthetics.newPage(browser);

    const response = await page.goto(TARGET_URL, {
      timeout: 30000,
      waitUntil: 'load',
    });

    // スクリーンショット (振り返りで障害前後を見比べる)
    await page.screenshot({ path: '/tmp/top-loaded.png' });

    expect(response, 'レスポンスがありません').not.toBeNull();
    const status = response.status();
    expect(status, `HTTP ステータス ${status} は 400 未満であるべき`).toBeLessThan(400);
  } finally {
    await synthetics.close();
  }
};
