/**
 * Server-side feature steps. After the core snapshot is built, every
 * feature whose manifest says `"server": true` gets its build(ctx) called
 * and the result stored under snapshot[<id>]. Steps are best-effort: an
 * error or a spent time budget lands INSIDE the block, never fails the
 * refresh. See FEATURES.md "server.js".
 */
import { readFile } from 'node:fs/promises';
import { FEATURES } from '../public/features/registry.js';
import { callTool, callToolPaged } from './_mcp.js';

const featureUrl = (id, file) => new URL(`../public/features/${id}/${file}`, import.meta.url);

export async function loadServerManifests(ids = FEATURES) {
  const out = [];
  for (const id of ids) {
    try { out.push(JSON.parse(await readFile(featureUrl(id, 'feature.json'), 'utf8'))); }
    catch (err) { out.push({ id, error: err.message }); }
  }
  return out;
}

/** A block that carries data, as opposed to a bare { skipped } / { error } marker. */
const hasData = (block) => Boolean(block) && typeof block === 'object'
  && Object.keys(block).some((k) => !['skipped', 'error', 'stale'].includes(k));

/**
 * When a step cannot run, the tab should not go blank: keep the block the
 * last refresh produced, marked `stale` with the skip reason, so the view
 * can say "showing the previous check" instead of inventing an empty state.
 */
const skippedBlock = (prev, reason) => (hasData(prev)
  ? { ...prev, stale: true, skipped: reason }
  : { skipped: reason });

const MIN_STEP_MS = 2000;

export async function runFeatureSteps({ snapshot, previous = null, deadline, onProgress = () => {} }) {
  const blocks = {};
  const manifests = await loadServerManifests();
  let pending = manifests.filter((m) => !m.error && m.server).length;
  for (const m of manifests) {
    if (m.error) { blocks[m.id] = { error: `manifest: ${m.error}` }; continue; }
    if (!m.server) continue;
    const prev = previous?.[m.id] ?? null;
    const left = deadline - Date.now();
    pending -= 1;
    if (left < MIN_STEP_MS) { blocks[m.id] = skippedBlock(prev, 'time budget'); continue; }
    // Fair share: a step may spend its share of what is left, so the steps
    // after it (registry order) still get to run instead of being starved
    // by an expensive one. The last step gets everything that remains.
    const stepDeadline = Date.now() + Math.floor(left / (pending + 1));
    onProgress(`feature ${m.id}`);
    try {
      const mod = await import(featureUrl(m.id, 'server.js').href);
      if (typeof mod.build !== 'function') throw new Error('server.js must export build(ctx)');
      const ctx = {
        id: m.id, manifest: m,
        callTool, callToolPaged,
        snapshot, previous: prev,
        deadline: stepDeadline, timeLeft: () => stepDeadline - Date.now(),
        log: (step) => onProgress(`${m.id}: ${step}`),
        env: { HYROS_CAC_CEILING: process.env.HYROS_CAC_CEILING },
        now: new Date(),
      };
      blocks[m.id] = await mod.build(ctx);
    } catch (err) {
      blocks[m.id] = { error: err.message };
    }
  }
  return blocks;
}
