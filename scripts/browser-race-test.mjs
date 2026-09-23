import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { buildDemoSnapshot } from '../public/demo.js';
import { loadFeatures, applyDemoFeatures } from '../public/shared/features.js';

const features = await loadFeatures();
const ids = ['acc_000000000001','acc_000000000002','acc_000000000003'];
const snapshots = Object.fromEntries(ids.map((id,i)=>{
  const snapshot = applyDemoFeatures(buildDemoSnapshot(),features);
  snapshot.origin='mcp'; snapshot.account.email=`Account ${i+1}`;
  for (const period of Object.values(snapshot.ranges)) for(const row of period.levels.campaign) row.name=`Account ${i+1} campaign`;
  return [id,snapshot];
}));
const browser = await chromium.launch();
let release;
let received;
const arrived = new Promise(resolve=>{received=resolve;});
const gate = new Promise(resolve=>{release=resolve;});
try {
  const context = await browser.newContext();
  await context.addInitScript(id=>{sessionStorage.setItem('aihyros_key','test');localStorage.setItem('aihyros_account',id);},ids[0]);
  await context.route('**/api/**',async route=>{
    const url=new URL(route.request().url());
    const account=url.searchParams.get('account')||ids[0];
    let body={ok:true};
    if(url.pathname==='/api/setup') body={ok:true,state:'ready',storage:true,pendingSecrets:false};
    if(url.pathname==='/api/accounts') body={ok:true,defaultId:ids[0],accounts:ids.map((id,i)=>({id,label:`Account ${i+1}`,kind:'key',status:'APPROVED',keyStatus:'ok',lastRefresh:new Date().toISOString()}))};
    if(url.pathname==='/api/data') {
      if(account===ids[1]) { received(); await gate; }
      body={ok:true,account,origin:'mcp',snapshot:snapshots[account],capabilities:{mcpConfigured:true,storeConfigured:true}};
    }
    if(url.pathname==='/api/copilot') body={ok:true,configured:false};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.PREVIEW_URL||'http://127.0.0.1:4322');
  await page.locator('#tab-warroom').waitFor({state:'visible'});
  await page.evaluate(id=>document.dispatchEvent(new CustomEvent('hyros:account',{detail:{accountId:id,view:'warroom'}})),ids[1]);
  await arrived;
  await page.evaluate(id=>document.dispatchEvent(new CustomEvent('hyros:account',{detail:{accountId:id,view:'warroom'}})),ids[2]);
  await page.waitForFunction(()=>document.querySelector('#acctLabel').textContent==='Account 3');
  const delayed=page.waitForResponse(r=>r.url().includes('/api/data')&&r.url().includes(ids[1]));
  release();await delayed;
  await page.locator('.tabs [data-view="report"]').click();
  assert.equal(await page.locator('#acctLabel').innerText(),'Account 3');
  assert((await page.locator('#view-report').innerText()).includes('Account 3 campaign'));
  assert(!(await page.locator('#view-report').innerText()).includes('Account 2 campaign'));
  assert.equal(await page.evaluate(()=>localStorage.getItem('aihyros_account')),ids[2]);
  assert.deepEqual(errors,[]);
  console.log('Out-of-order account response rejected; selector, snapshot and persisted account remain consistent.');
} finally { release?.(); await browser.close(); }
