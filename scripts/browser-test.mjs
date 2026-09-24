import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const base = process.env.PREVIEW_URL || 'http://127.0.0.1:4322';
await mkdir(new URL('../shots/', import.meta.url), { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const results = [];
try {
  for (const size of [{ name:'desktop', width:1440, height:1000 }, { name:'mobile', width:390, height:844 }]) {
    const context = await browser.newContext({ viewport:{width:size.width,height:size.height}, reducedMotion:'reduce' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('#gateDemo').click();
    await page.locator('#tab-warroom').waitFor({ state:'visible' });
    assert.equal(await page.locator('#gate').isVisible(), false, 'Sign-in must stay hidden in Demo');
    assert.equal(await page.locator('#setup').isVisible(), false, 'Setup must not cover Demo');
    const tabs = await page.locator('.tabs .tab:visible').evaluateAll(els => els.map(el => el.dataset.view));
    for (const tab of tabs) {
      await page.locator(`.tabs [data-view="${tab}"]`).click();
      const panel = page.locator(`#view-${tab}`);
      await panel.waitFor({state:'visible'});
      assert((await panel.innerText()).trim().length > 30, `${tab} is empty`);
      assert(!(await panel.innerText()).includes('could not render'), `${tab} render failed`);
      const dimensions = await page.evaluate(() => ({ width:document.documentElement.clientWidth, scroll:document.documentElement.scrollWidth }));
      assert(dimensions.scroll <= dimensions.width + 2, `${size.name}/${tab}: page overflow ${dimensions.scroll}/${dimensions.width}`);
      await page.screenshot({path:`shots/${size.name}-${tab}.png`,fullPage:true});
      results.push(`${size.name}/${tab}`);
    }
    await page.locator('#tab-warroom').click();
    const status = page.locator('#view-warroom [data-status]').first();
    if (await status.count()) { await status.selectOption('monitoring'); assert.equal(await page.locator('#view-warroom [data-status]').first().inputValue(),'monitoring'); }
    const [evidence] = await Promise.all([page.waitForEvent('download'),page.locator('#view-warroom [data-export]').click()]);
    assert(evidence.suggestedFilename().endsWith('.json'));
    await page.locator('#view-warroom [data-range]').selectOption('30d');
    assert((await page.locator('.wr-head').innerText()).includes('30d'));
    await page.locator('.wr-journal summary').click();
    await page.locator('.wr-journal [name="owner"]').fill('Demo reviewer');
    await page.locator('.wr-journal [name="reviewDate"]').fill('2026-10-01');
    await page.locator('.wr-journal [name="hypothesis"]').fill('Verify delayed conversions before acting.');
    await page.locator('.wr-journal button[type="submit"]').click();
    assert((await page.locator('[data-journal-status]').innerText()).includes('Saved'));
    // Creative: demo names follow the convention, so naming is auto-detected, parsed into slot columns, and can be kept or turned off.
    await page.locator('#tab-creative').click();
    const creativeBanner = page.locator('#view-creative .creative-banner');
    assert((await creativeBanner.innerText()).includes('Naming auto-detected'), 'Creative must auto-detect the demo naming convention');
    assert((await page.locator('#view-creative .kpi').first().innerText()).includes('auto-detected'));
    await page.locator('#view-creative .creative-group summary').first().click();
    const creativeHeaders = await page.locator('#view-creative .creative-table th').evaluateAll(els => els.map(el => el.textContent.trim()));
    assert.deepEqual(creativeHeaders.slice(1, 6), ['concept', 'angle', 'hook', 'format', 'variation'], `slot columns: ${creativeHeaders.join(',')}`);
    const firstSlots = await page.locator('#view-creative .creative-table tbody tr').first().locator('td').evaluateAll(els => els.slice(1, 6).map(el => el.textContent.trim()));
    assert(firstSlots.every(text => text && text !== '—' && text !== 'blank'), `parsed slots must not be empty: ${firstSlots.join(',')}`);
    await page.locator('#view-creative [data-creative-dimension]').selectOption('hook');
    assert((await page.locator('#view-creative .kpi').first().innerText()).includes('hook'));
    await page.locator('#view-creative [data-creative-off]').click();
    assert((await page.locator('#view-creative .creative-banner').innerText()).includes('not configured'), 'Turn off must fall back to ad sets');
    assert.equal(await page.locator('#view-creative .creative-table th', { hasText: /^concept$/ }).count(), 0, 'no slot columns once naming is off');
    await page.locator('#view-creative [name="detect"]').check();
    await page.locator('#view-creative [name="configured"]').check();
    await page.locator('#view-creative [data-creative-settings] button[type="submit"]').click();
    assert((await page.locator('#view-creative .creative-banner').innerText()).includes('Naming saved'));
    await page.locator('#tab-copilot').click();
    await page.locator('#view-copilot [data-question="Revenue summary"]').click();
    assert((await page.locator('.cp-answer').innerText()).includes('revenue'));
    await page.locator('#cp-input').fill('unknown unsupported topic');
    await page.locator('.cp-form button').click();
    assert((await page.locator('.cp-answer').last().innerText()).includes('No verified answer'));
    assert.equal(await page.locator('#gate').isVisible(), false, 'A delayed response must not reopen sign-in');
    await context.close();
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:results.length,views:results,consoleErrors:errors},null,2));
} finally { await browser.close(); }
