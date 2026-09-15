/**
 * Feature conformance check (part of `npm run check`).
 *
 * For every id in public/features/registry.js:
 *   - feature.json exists and validates (validateManifest)
 *   - required files exist for what the manifest declares; SPEC.md present
 *   - view.js exports render(); demo.js exports demo(); server.js exports build()
 *   - no feature file imports app.js or api/ (features use ctx only)
 *   - render() runs against the demo snapshot, a missing block, and every
 *     runner state ({ skipped }, { error }, stale reuse, {}) without throwing;
 *     a stale block must say "previous"
 *   - demo() is deterministic (two runs, same JSON) and the block stays small
 *   - server.js build() runs against a fake callTool without throwing, calls
 *     only manifest tools (stub run + callTool('…') literals), keeps per-call
 *     timeouts <= 15 s, and makes zero calls when the budget is spent
 * Folders starting with "_" (the template) are skipped.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { FEATURES } from '../public/features/registry.js';
import { loadFeatures, validateManifest, applyDemoFeatures } from '../public/shared/features.js';
import { buildDemoSnapshot } from '../public/demo.js';
import { fmt, formatCell } from '../public/shared/metrics.js';

const MAX_BLOCK_BYTES = 200 * 1024;   // FEATURES.md block size guideline
const MAX_CALL_TIMEOUT_MS = 15000;    // FEATURES.md per-call timeout rule

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`); if (!ok) failures += 1; };
const dir = (id) => new URL(`../public/features/${id}/`, import.meta.url);
const exists = async (url) => stat(url).then(() => true).catch(() => false);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stubRoot = () => ({ innerHTML: '', querySelectorAll: () => [], querySelector: () => null, dataset: {}, hidden: false });

console.log('\nFeature registry');
const folders = (await readdir(new URL('../public/features/', import.meta.url), { withFileTypes: true }))
  .filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name);
check('every feature folder is registered (or prefixed _ to stay off)', folders.every((f) => FEATURES.includes(f)), folders.filter((f) => !FEATURES.includes(f)).join(','));
check('every registered id has a folder', FEATURES.every((id) => folders.includes(id)), FEATURES.filter((id) => !folders.includes(id)).join(','));
check('no duplicate ids', new Set(FEATURES).size === FEATURES.length);

const features = await loadFeatures();
const demoSnap = applyDemoFeatures(buildDemoSnapshot(), features);
fmt.cents = false;

for (const id of FEATURES) {
  console.log(`\n${id}`);
  const f = features.find((x) => x.id === id);
  check('loads (manifest valid, modules import)', Boolean(f?.view), f?.error);
  if (!f?.view) continue;
  const m = f.manifest;
  check('manifest passes validateManifest', validateManifest(m, id).length === 0, validateManifest(m, id).join('; '));
  check('SPEC.md present', await exists(new URL('SPEC.md', dir(id))));
  if (m.style) check('style.css present (manifest says style: true)', await exists(new URL('style.css', dir(id))));
  if (m.server) check('server.js present (manifest says server: true)', await exists(new URL('server.js', dir(id))));

  // Isolation: features must not reach into the app or the API.
  const files = (await readdir(dir(id))).filter((n) => n.endsWith('.js'));
  let leaks = [];
  for (const n of files) {
    const src = (await readFile(new URL(n, dir(id)), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/from\s+['"][^'"]*(app\.js|\/api\/|_mcp|_store|_accounts|_setup)['"]/.test(src)) leaks.push(n);
    if (/\bfetch\s*\(\s*['"`]https?:/.test(src)) leaks.push(`${n} (direct external fetch)`);
    if (n === 'demo.js' && /Math\.random/.test(src)) leaks.push(`${n} (Math.random — use the seeded rng)`);
  }
  check('no imports of app.js / api internals, no external fetch, no Math.random in demo', leaks.length === 0, leaks.join(', '));

  if (m.demo) {
    const a = JSON.stringify(f.demo.demo(demoSnap));
    const b = JSON.stringify(f.demo.demo(demoSnap));
    check('demo() is deterministic', a === b);
    check('demo() returns an object', a.startsWith('{'));
  }

  // Render against the demo snapshot with a stub DOM.
  const ctx = {
    id, manifest: m, root: stubRoot(), snapshot: demoSnap, block: demoSnap[id] ?? null,
    demo: true, account: null, range: '30d', level: 'campaign',
    fmt, esc, kpis: (list) => list.map((k) => `<div class="kpi"><div class="kpi-label">${k.label}</div><div class="kpi-value ${k.cls || ''}">${k.value}</div><div class="kpi-sub">${k.sub || ''}</div></div>`).join(''),
    formatCell, note: () => {}, openJourney: () => {}, api: async () => ({ status: 200, body: {} }), selectView: () => {},
  };
  let renderErr = null;
  try { f.view.render(ctx); } catch (err) { renderErr = err; }
  check('render(ctx) runs against the demo snapshot', !renderErr, renderErr?.message);
  check('render(ctx) wrote HTML into ctx.root', ctx.root.innerHTML.length > 50);
  const emptyCtx = { ...ctx, root: stubRoot(), block: null };
  let emptyErr = null;
  try { f.view.render(emptyCtx); } catch (err) { emptyErr = err; }
  check('render(ctx) tolerates a missing block', !emptyErr && emptyCtx.root.innerHTML.length > 0, emptyErr?.message);

  // Every state the runner can hand a view (FEATURES.md "The block"): bare
  // skipped, error, stale reuse of the previous data, and an empty object.
  const demoBlock = demoSnap[id] && typeof demoSnap[id] === 'object' ? demoSnap[id] : {};
  const states = [
    ['{ skipped }', { skipped: 'time budget' }],
    ['{ error }', { error: 'boom' }],
    ['stale', { ...demoBlock, stale: true, skipped: 'time budget' }],
    ['{}', {}],
  ];
  for (const [label, blk] of states) {
    const c = { ...ctx, root: stubRoot(), block: blk };
    let e = null;
    try { f.view.render(c); } catch (err) { e = err; }
    check(`render(ctx) tolerates a ${label} block`, !e && c.root.innerHTML.length > 0, e?.message || 'empty HTML');
    if (blk.stale) check('stale block says it is from a previous refresh', /previous/i.test(c.root.innerHTML));
  }
  if (m.demo) {
    const size = JSON.stringify(demoSnap[id] ?? null).length;
    check('demo block stays under the 200 KB size guideline (FEATURES.md)', size <= MAX_BLOCK_BYTES, `${Math.round(size / 1024)} KB`);
  }

  if (m.server) {
    const mod = await import(new URL('server.js', dir(id)).href);
    check('server.js exports build(ctx)', typeof mod.build === 'function');
    // Tool names written as string literals must be in the manifest even when
    // the stub run never reaches that call (a branch the demo snapshot skips).
    const serverSrc = (await readFile(new URL('server.js', dir(id)), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const literals = [...serverSrc.matchAll(/callTool(?:Paged)?\(\s*['"]([^'"]+)['"]/g)].map((x) => x[1]);
    check('every callTool(\'…\') literal in server.js is in the manifest tools', literals.every((t) => (m.tools || []).includes(t)), [...new Set(literals)].filter((t) => !(m.tools || []).includes(t)).join(','));
    if (typeof mod.build === 'function') {
      const calls = [];
      const sctx = {
        id, manifest: m,
        callTool: async (name, args, opts) => { calls.push({ name, opts }); return {}; },
        callToolPaged: async (name, args, opts) => { calls.push({ name, opts }); return []; },
        snapshot: demoSnap, previous: null, deadline: Date.now() + 20000, timeLeft: () => 20000,
        log: () => {}, env: {}, now: new Date(),
      };
      let out = null; let err = null;
      try { out = await mod.build(sctx); } catch (e) { err = e; }
      check('build(ctx) runs against a stub MCP', !err && out && typeof out === 'object', err?.message);
      const names = calls.map((c) => c.name);
      check('build(ctx) only calls tools the manifest lists', names.every((c) => (m.tools || []).includes(c)), [...new Set(names)].filter((c) => !(m.tools || []).includes(c)).join(','));
      check('build(ctx) keeps every per-call timeout <= 15 s', calls.every((c) => !c.opts?.timeoutMs || c.opts.timeoutMs <= MAX_CALL_TIMEOUT_MS), JSON.stringify(calls.filter((c) => c.opts?.timeoutMs > MAX_CALL_TIMEOUT_MS)));
      const tightCalls = [];
      const tight = { ...sctx, callTool: async (name) => { tightCalls.push(name); return {}; }, callToolPaged: async (name) => { tightCalls.push(name); return []; }, deadline: Date.now(), timeLeft: () => 0 };
      let tErr = null; let tOut = null;
      try { tOut = await mod.build(tight); } catch (e) { tErr = e; }
      check('build(ctx) honours a spent time budget without throwing', !tErr && tOut && typeof tOut === 'object', tErr?.message);
      check('build(ctx) makes ZERO MCP calls when timeLeft() is 0', tightCalls.length === 0, tightCalls.join(','));
    }
  }
}

console.log(failures ? `\n${failures} feature check(s) FAILED` : '\nAll feature checks passed.');
process.exit(failures ? 1 : 0);
