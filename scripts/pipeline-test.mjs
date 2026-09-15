/**
 * End-to-end test of the snapshot pipeline against the mock MCP:
 *   - ad rows keep parentId; ads link to ad sets by id even with duplicate names
 *   - saved settings reach the report request (model, window, leadStage, newestFirst)
 *   - a second build with a previous snapshot runs the INCREMENTAL lead sync
 *     (updatedFromDate) and merges correctly
 *   - Scale Advisor curves and Tracking Health land in the snapshot
 */
import { startMock, calls } from './mock-mcp.mjs';

const PORT = 4322;
process.env.HYROS_MCP_URL = `http://127.0.0.1:${PORT}/mcp`;
process.env.HYROS_API_KEY = 'mock';

const { buildSnapshot } = await import('../api/_snapshot.js');

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`);
  if (!ok) failures += 1;
};

const server = await startMock(PORT);
try {
  console.log('\nFull build with settings');
  const prefs = { settings: { model: 'LAST_CLICK', windowDays: 14, leadStage: ['Customer'] } };
  const snap = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs });

  const report = calls.find((c) => c.name === 'hyros_get_attribution_report')?.args.request;
  check('report request carries windowAttributionDaysRange=14', report?.windowAttributionDaysRange === 14);
  check('report request carries leadStage', JSON.stringify(report?.leadStage) === '["Customer"]');
  check('report request uses newestFirst', report?.newestFirst === true);
  check('snapshot records settings', snap.settings.windowDays === 14 && snap.settings.leadStage[0] === 'Customer');

  const ads = snap.ranges['30d'].levels.ad;
  check('ad rows keep parentId', ads.every((a) => a.parentId), JSON.stringify(ads.map((a) => a.parentId)));
  const dupParents = ads.filter((a) => a.parentName === 'Powerset').map((a) => a.parentId);
  check('duplicate "Powerset" ad sets resolve to distinct parentIds', new Set(dupParents).size === 2);

  const levelsFor = (id) => calls.filter((c) => c.name === 'hyros_get_attribution_report' && String(c.args.request.ids[0]) === id).map((c) => c.args.request.level);
  const uniq = (id) => [...new Set(levelsFor(id))].sort().join(',');
  check('classic Google reported at campaign + ad (no adgroup level exists)', uniq('9002') === 'GOOGLE_AD,GOOGLE_CAMPAIGN', uniq('9002'));
  check('Snapchat reported at adsquad + ad', uniq('9003') === 'SNAPCHAT_AD,SNAPCHAT_ADSQUAD', uniq('9003'));
  check('LinkedIn reported at campaign only', uniq('9004') === 'LINKEDIN_CAMPAIGN', uniq('9004'));
  check('Google V2 reported at adgroup only', uniq('9005') === 'GOOGLE_V2_ADGROUP', uniq('9005'));
  check('account type with no report level is skipped, not requested', levelsFor('9006').length === 0, uniq('9006'));
  check('broken account requested once per level, then skipped', levelsFor('9007').length === 2, String(levelsFor('9007').length));
  const warnIds = (snap.warnings || []).map((w) => w.adAccountId).sort().join(',');
  check('skipped + broken accounts land in snapshot.warnings', warnIds === '9006,9007,9007', warnIds);
  check('every other account still reaches the account level', ['9001', '9002', '9003', '9004', '9005'].every((id) => snap.ranges['30d'].levels.account.some((r) => r.id === id)), JSON.stringify(snap.ranges['30d'].levels.account.map((r) => r.id)));
  check('non-Meta ad rows keep parentId too', snap.ranges['30d'].levels.ad.some((a) => a.id === '9002-ad-1' && a.parentId === '9002-1'));

  check('CRM full sync (no previous)', snap.crm.sync.incremental === false && snap.crm.leads.length === 3);
  check('agency relationship captured', snap.account.managedBy[0]?.email === 'agency@example.test');
  check('attribution window default captured', snap.account.attributionWindowDefault === 7);

  const curves = snap.scale.curves;
  check('scale: accounts + top ad sets analyzed', curves.length === snap.adAccounts.length + Math.min(6, snap.ranges['30d'].levels.adset.length), String(curves.length));
  check('scale: curve points normalized', curves[0].points.length === 5 && curves[0].points[0].spend === 20);
  check('scale: saturation spend parsed', curves[0].saturationSpend === 70);
  check('scale: account call passed cacCeiling', calls.find((c) => c.name === 'hyros_get_marginal_cac_curve')?.args.request.cacCeiling > 0);

  check('health: domains listed', snap.health.domains.length === 2);
  check('health: script presence per URL', snap.health.scripts['https://mock.example.test/'] === 'SCRIPT_FOUND');
  check('health: Google tracking params checked', snap.health.trackingParams.length === 2 && snap.health.trackingParams[0].rows.length === 2);

  console.log('\nIncremental build (previous snapshot present)');
  calls.length = 0;
  const snap2 = await buildSnapshot({ now: new Date('2026-09-14T12:00:00Z'), prefs, previous: snap });
  const leadsReq = calls.find((c) => c.name === 'hyros_get_leads')?.args.request;
  check('leads pulled with updatedFromDate', Boolean(leadsReq?.updatedFromDate) && !leadsReq?.fromDate, JSON.stringify(leadsReq));
  check('sync flagged incremental', snap2.crm.sync.incremental === true && snap2.crm.sync.leadsFetched === 2);
  check('merged: previous leads kept', snap2.crm.leads.some((l) => l.id === 'lead-2') && snap2.crm.leads.some((l) => l.id === 'lead-3'));
  check('merged: changed lead updated in place', snap2.crm.leads.find((l) => l.id === 'lead-1')?.stage === 'Customer');
  check('merged: new lead added', snap2.crm.leads.some((l) => l.id === 'lead-9'));
  check('merged: income re-joined from fresh sales', snap2.crm.leads.find((l) => l.id === 'lead-1')?.income === 149);
  check('merged: no duplicates', new Set(snap2.crm.leads.map((l) => l.id)).size === snap2.crm.leads.length);

  console.log('\nMulti-account: per-key MCP context + encrypted registry');
  process.env.ACCOUNT_KEY_SECRET = 'test-secret';
  const acc = await import('../api/_accounts.js');
  const { runWithKey } = await import('../api/_mcp.js');
  const blob = acc.encryptKey('hyros-key-ABC');
  check('key encrypts to iv.tag.cipher and round-trips', blob.split('.').length === 3 && acc.decryptKey(blob) === 'hyros-key-ABC');
  check('encrypted blob never contains the key', !blob.includes('hyros-key-ABC'));
  check('account id is a stable hash of the key', acc.accountIdFor('hyros-key-ABC') === acc.accountIdFor('hyros-key-ABC') && /^acc_[0-9a-f]{12}$/.test(acc.accountIdFor('hyros-key-ABC')));
  calls.length = 0;
  const info = await acc.probeKey('client-key-XYZ');
  check('probeKey sends the CLIENT key, not the env key', calls[0]?.apiKey === 'client-key-XYZ', calls[0]?.apiKey);
  check('probeKey returns the account label', info.email === 'mock@hyros.test');
  calls.length = 0;
  await runWithKey('k-1', async () => { await import('../api/_mcp.js').then((m) => m.callTool('hyros_get_domains', {})); });
  await import('../api/_mcp.js').then((m) => m.callTool('hyros_get_domains', {}));
  check('runWithKey scopes the key; outside it the env key is used', calls[0]?.apiKey === 'k-1' && calls[1]?.apiKey === 'mock', JSON.stringify(calls.map((c) => c.apiKey)));

  console.log('\nAgency: discover clients, detect accessible_account_id mode, batch import, key health');
  // In-memory KV stand-in so the registry works without Upstash.
  const mem = new Map();
  globalThis.fetch = ((orig) => async (url, opts) => {
    if (String(url).startsWith('http://kv.local')) {
      const [cmd, k, v, ...rest] = JSON.parse(opts.body);
      if (cmd === 'GET') return new Response(JSON.stringify({ result: mem.get(k) ?? null }));
      if (cmd === 'SET') {
        if (rest.includes('NX') && mem.has(k)) return new Response(JSON.stringify({ result: null }));
        mem.set(k, v); return new Response(JSON.stringify({ result: 'OK' }));
      }
      if (cmd === 'DEL') { let n = 0; for (const key of [k, v, ...rest].filter(Boolean)) n += mem.delete(key) ? 1 : 0; return new Response(JSON.stringify({ result: n })); }
      if (cmd === 'SCAN') { const prefix = String(rest[0] || '').replace(/\*$/, ''); return new Response(JSON.stringify({ result: ['0', [...mem.keys()].filter((key) => key.startsWith(prefix))] })); }
    }
    return orig(url, opts);
  })(globalThis.fetch);
  process.env.KV_REST_API_URL = 'http://kv.local'; process.env.KV_REST_API_TOKEN = 't';
  process.env.REPORT_PASSWORD = 'pw';
  const store = await import('../api/_store.js');
  check('accounts enabled with KV + secret', acc.accountsEnabled() === true);

  const added = await acc.addAccount('agency-key', { agency: true });
  check('agency key added and clients discovered', added.account.agency === true && added.clientsFound === 7 && added.clientsApproved === 6, JSON.stringify(added));
  calls.length = 0;
  const b1 = await acc.importClients(added.account.id, { offset: 0 });
  check('first batch imports 5 of 6 approved clients', b1.added === 5 && b1.total === 6 && b1.remaining === 1 && b1.pending === 1, JSON.stringify(b1));
  check('client mode detected as ARG (verified against the client profile)', b1.clientMode === 'arg' && b1.clientModeStatus === 'verified', JSON.stringify(b1));
  const b2 = await acc.importClients(added.account.id, { offset: b1.offset });
  check('second batch imports the last client', b2.added === 1 && b2.remaining === 0);
  const list = await acc.listAccounts();
  const clients = list.filter((a) => a.kind === 'client');
  check('registry lists 6 clients under the agency', clients.length === 6 && clients.every((c) => c.parentId === added.account.id));

  calls.length = 0;
  const cli = clients[0];
  await acc.asAccount(cli.id, () => import('../api/_mcp.js').then((m) => m.callTool('hyros_get_ad_accounts', { request: {} })));
  check('client call uses the AGENCY key + accessible_account_id argument', calls[0]?.apiKey === 'agency-key' && calls[0]?.client && calls[0]?.headerClient === null, JSON.stringify(calls[0]));

  const sync = await acc.syncClients(added.account.id);
  check('client sync is idempotent', sync.added === 0 && sync.total === 7);

  // Key goes bad: mark invalid, clients inherit, resolve refuses with a clear code.
  await acc.markKeyStatus(cli.id, 'invalid', 'MCP rejected the API key (HTTP 401)');
  const after = await acc.listAccounts();
  check('agency + clients show key invalid', after.find((a) => a.id === added.account.id).keyStatus === 'invalid' && after.find((a) => a.id === cli.id).keyStatus === 'invalid');
  let refused = null;
  try { await acc.resolveAccount(cli.id); } catch (err) { refused = err; }
  check('client resolve refused with key_invalid', refused?.code === 'key_invalid');
  const dead = await acc.addAccount('dead-key').catch((e) => e);
  check('a rejected key cannot be added (auth error surfaced)', dead?.code === 'auth' || /rejected/.test(dead?.message || ''), dead?.message);
  const rep = await acc.replaceKey(added.account.id, 'agency-key');
  check('replace key restores the agency', rep.keyStatus === 'ok');
  check('removing the agency removes its clients', await acc.removeAccount(added.account.id) && (await acc.listAccounts()).filter((a) => a.kind === 'client').length === 0);

  console.log('\nSelf-serve setup: first run wipes + sets the KV password, generated secrets, hardening, factory reset');
  delete process.env.ACCOUNT_KEY_SECRET;
  delete process.env.CRON_SECRET;
  const setup = await import('../api/_setup.js');
  const auth = await import('../api/_auth.js');
  const reqWith = (key, headers = {}) => ({ url: `/api/data${key ? `?key=${encodeURIComponent(key)}` : ''}`, headers: { host: 'x', ...headers } });
  // Leftovers from an earlier install (the registry above was emptied, but plant a stale snapshot):
  mem.set('aihyros:snapshot:latest', JSON.stringify({ generatedAt: '2026-01-01T00:00:00Z', stale: true }));
  let st = await setup.setupState();
  check('storage present but no KV password → needs_setup (env vars do not count)', st.state === 'needs_setup' && st.storage === true && st.passwordSource === null, st.state);
  check('the env REPORT_PASSWORD is reported only as a master password', st.masterPassword === true);
  check('no KV password → data routes refuse with the setup flag (even with the env password)', (await auth.checkAccess(reqWith('pw'))).setup === true);
  check('no env HYROS_API_KEY account: nothing is listed', (await acc.listAccounts()).length === 0);
  check('accounts disabled until a secret exists', acc.accountsEnabled() === false);
  const weak = await setup.setPassword('short').catch((e) => e);
  check('short password refused', weak?.code === 'weak');
  st = await setup.setPassword('correct-horse-battery');
  check('first run → ready, secrets generated in KV', st.state === 'ready' && st.keySecret === 'kv' && st.cronSecret === 'kv' && st.pendingSecrets === true, JSON.stringify(st));
  check('first run wiped the earlier install\u2019s data', !mem.has('aihyros:snapshot:latest'));
  const dup = await setup.setPassword('another-one-1234').catch((e) => e);
  check('second first-run refused (first-come lock)', dup?.code === 'exists');
  check('checkAccess verifies the KV password (scrypt)', (await auth.checkAccess(reqWith('correct-horse-battery'))).ok === true && (await auth.checkAccess(reqWith('wrong-password-1'))).ok === false);
  check('the env REPORT_PASSWORD still works as a master password', (await auth.checkAccess(reqWith('pw'))).ok === true && (await auth.checkAccess(reqWith('pw'))).source === 'env');
  check('checkAccess accepts the Bearer form too', (await auth.checkAccess(reqWith(null, { authorization: 'Bearer correct-horse-battery' }))).ok === true);
  check('default account is null with nothing connected', (await acc.defaultAccountId()) === null);
  check('accounts enabled under the generated secret', acc.accountsEnabled() === true);
  const first = await acc.addAccount('client-key-XYZ');
  check('key encrypted under the generated secret round-trips', (await acc.resolveAccount(first.account.id)).apiKey === 'client-key-XYZ');
  check('default account becomes the first registry account', (await acc.defaultAccountId()) === first.account.id);
  check('accountFromReq: the legacy env id falls to the default', (await acc.accountFromReq({ url: '/api/data?account=env', headers: { host: 'x' } })) === first.account.id);
  const secrets = await setup.pendingSecrets();
  check('pending secrets readable for the hardening screen', /^[0-9a-f]{64}$/.test(secrets.ACCOUNT_KEY_SECRET) && /^[0-9a-f]{64}$/.test(secrets.CRON_SECRET));
  let h = await setup.harden();
  check('harden is a no-op until the env matches', h.done.ACCOUNT_KEY_SECRET === false && h.remaining.ACCOUNT_KEY_SECRET === true);
  process.env.ACCOUNT_KEY_SECRET = 'a-typo-not-the-generated-value';
  h = await setup.harden();
  check('a wrong env value never drops the KV copy', h.done.ACCOUNT_KEY_SECRET === false && h.remaining.ACCOUNT_KEY_SECRET === true);
  check('…and stored keys still decrypt via the KV fallback secret', (await acc.resolveAccount(first.account.id)).apiKey === 'client-key-XYZ');
  process.env.ACCOUNT_KEY_SECRET = secrets.ACCOUNT_KEY_SECRET;
  process.env.CRON_SECRET = secrets.CRON_SECRET;
  h = await setup.harden();
  check('matching env values drop both KV copies', h.done.ACCOUNT_KEY_SECRET && h.done.CRON_SECRET && !h.remaining.ACCOUNT_KEY_SECRET && !h.remaining.CRON_SECRET);
  check('keys decrypt under the env secret after hardening', (await acc.resolveAccount(first.account.id)).apiKey === 'client-key-XYZ');
  check('hardened state reports env sources', (await setup.setupState()).pendingSecrets === false && (await setup.setupState()).keySecret === 'env');
  check('signed cron accepted, unsigned refused when CRON_SECRET is set', auth.isCron({ headers: { authorization: `Bearer ${secrets.CRON_SECRET}` } }) === true && auth.isCron({ headers: { 'user-agent': 'vercel-cron/1.0' } }) === false);
  delete process.env.CRON_SECRET;
  check('without CRON_SECRET the Vercel cron UA is recognised', auth.isCron({ headers: { 'user-agent': 'vercel-cron/1.0' } }) === true && auth.isCron({ headers: { 'user-agent': 'curl/8' } }) === false);
  check('cron lock: first SET NX wins, second is refused', (await store.kvRaw(['SET', 'aihyros:cron:lock', '1', 'NX', 'EX', '3000'])) === 'OK' && (await store.kvRaw(['SET', 'aihyros:cron:lock', '1', 'NX', 'EX', '3000'])) === null);
  await setup.changePassword('new-password-12345');
  check('change password takes effect', (await auth.checkAccess(reqWith('new-password-12345'))).ok === true && (await auth.checkAccess(reqWith('correct-horse-battery'))).ok === false);
  const before = [...mem.keys()].filter((k) => k.startsWith('aihyros:')).length;
  const reset = await setup.factoryReset();
  check('factory reset wipes every app key and returns to needs_setup', before >= 3 && reset.deleted === before && reset.state === 'needs_setup' && [...mem.keys()].every((k) => !k.startsWith('aihyros:')), JSON.stringify({ before, deleted: reset.deleted, state: reset.state }));
  check('after reset the registry is empty', (await acc.listAccounts()).length === 0);
} finally {
  server.close();
}

console.log(failures ? `\n${failures} pipeline check(s) FAILED` : '\nAll pipeline checks passed.');
process.exit(failures ? 1 : 0);
