import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch();
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:4322';
try {
  for (const stage of ['setup-ready', 'setup-needed', 'data']) {
    let release;
    let received;
    const arrived = new Promise(resolve => { received = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const context = await browser.newContext();
    const errors = [];
    let dataRequests = 0;
    await context.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/setup') {
        if (stage.startsWith('setup')) { received(); await pending; }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, state: stage === 'setup-needed' ? 'needs_setup' : 'ready', storage: true }) });
      } else if (path === '/api/data') {
        dataRequests += 1;
        if (stage === 'data') { received(); await pending; }
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'unauthorized' }) });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, configured: false }) });
      }
    });
    try {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await arrived;
      await page.locator('#gateDemo').click();
      await page.locator('#tab-warroom').waitFor({ state: 'visible' });
      const response = page.waitForResponse(r => new URL(r.url()).pathname === (stage === 'data' ? '/api/data' : '/api/setup'));
      release();
      await (await response).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#gate').isVisible(), false, `${stage}: sign-in gate reappeared`);
      assert.equal(await page.locator('#setup').isVisible(), false, `${stage}: setup overlay replaced Demo`);
      assert.equal(await page.locator('#app').isVisible(), true);
      assert((await page.locator('#acctLabel').innerText()).includes('Demo'));
      if (stage.startsWith('setup')) assert.equal(dataRequests, 0, `${stage}: stale boot requested private data`);
      assert.deepEqual(errors, []);
    } finally {
      release();
      await context.close();
    }
  }
  console.log('Demo entry survives delayed setup and unauthorized data responses without reopening sign-in or setup.');
} finally { await browser.close(); }
