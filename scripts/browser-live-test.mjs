import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:4322';
const password = process.env.PREVIEW_PASSWORD;
if (!password) throw new Error('Set PREVIEW_PASSWORD for the local preview.');
const browser = await chromium.launch();
const errors = [];
const views = [];
try {
  for (const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
    const context = await browser.newContext({viewport,reducedMotion:'reduce'});
    await context.addInitScript(value => sessionStorage.setItem('aihyros_key',value),password);
    const page = await context.newPage();
    page.on('pageerror',error => errors.push(error.message));
    await page.goto(base);
    await page.locator('#tab-warroom').waitFor({state:'visible',timeout:300000});
    assert(!(await page.locator('#acctLabel').innerText()).includes('Demo'));
    const tabs = await page.locator('.tabs .tab:visible').evaluateAll(els=>els.map(el=>el.dataset.view));
    for(const tab of tabs){
      await page.locator(`.tabs [data-view="${tab}"]`).click();
      const panel=page.locator(`#view-${tab}`);
      await panel.waitFor({state:'visible'});
      assert((await panel.innerText()).length>30,`${tab}: empty`);
      assert(!(await panel.innerText()).includes('could not render'),`${tab}: render failed`);
      assert(await page.locator(`.tabs [data-view="${tab}"]`).evaluate(el=>el.classList.contains('active')));
      const dims=await page.evaluate(()=>[document.documentElement.scrollWidth,document.documentElement.clientWidth]);
      assert(dims[0]<=dims[1]+2,`${tab}: overflow`);
      views.push(`${viewport.width}/${tab}`);
    }
    await page.locator('#tab-attribution').click();
    const summary=await page.locator('#view-attribution').innerText();
    assert(!summary.includes('Illustrative demo cohort'));
    assert(summary.includes('Conversion evidence'));
    await page.locator('#tab-portfolio').click();
    await page.locator('[data-portfolio-account]').first().waitFor({state:'visible'});
    assert(!(await page.locator('#view-portfolio').innerText()).includes('Request failed'));
    await page.locator('[data-portfolio-account]').first().click();
    await page.locator('#view-warroom').waitFor({state:'visible'});
    await context.close();
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:views.length,views,errors},null,2));
} finally { await browser.close(); }
