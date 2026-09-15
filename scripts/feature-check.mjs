/**
 * Feature conformance check (part of `npm run check`).
 *
 * For every id in public/features/registry.js:
 *   - feature.json exists and validates (validateManifest)
 *   - required files exist for what the manifest declares; SPEC.md present
 *   - view.js exports render(); demo.js exports demo(); server.js exports build()
 *   - no feature file imports app.js or api/ (features use ctx only)
 *   - render() runs against the demo snapshot with a stub DOM without throwing
 *   - demo() is deterministic (two runs, same JSON)
 *   - server.js build() runs against a fake callTool without throwing
 * Folders starting with "_" (the template) are skipped.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { FEATURES } from '../public/features/registry.js';
import { loadFeatures, validateManifest, applyDemoFeatures } from '../public/shared/features.js';
import { buildDemoSnapshot } from '../public/demo.js';
import { fmt, formatCell } from '../public/shared/metrics.js';

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

  if (m.server) {
    const mod = await import(new URL('server.js', dir(id)).href);
    check('server.js exports build(ctx)', typeof mod.build === 'function');
    if (typeof mod.build === 'function') {
      const calls = [];
      const sctx = {
        id, manifest: m,
        callTool: async (name, args) => { calls.push(name); return {}; },
        callToolPaged: async (name) => { calls.push(name); return []; },
        snapshot: demoSnap, previous: null, deadline: Date.now() + 20000, timeLeft: () => 20000,
        log: () => {}, env: {}, now: new Date(),
      };
      let out = null; let err = null;
      try { out = await mod.build(sctx); } catch (e) { err = e; }
      check('build(ctx) runs against a stub MCP', !err && out && typeof out === 'object', err?.message);
      check('build(ctx) only calls tools the manifest lists', calls.every((c) => (m.tools || []).includes(c)), [...new Set(calls)].filter((c) => !(m.tools || []).includes(c)).join(','));
      const tight = { ...sctx, deadline: Date.now(), timeLeft: () => 0 };
      let tErr = null;
      try { await mod.build(tight); } catch (e) { tErr = e; }
      check('build(ctx) honours a spent time budget without throwing', !tErr, tErr?.message);
    }
  }
}

console.log(failures ? `\n${failures} feature check(s) FAILED` : '\nAll feature checks passed.');
process.exit(failures ? 1 : 0);
