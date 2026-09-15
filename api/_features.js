/**
 * Server-side feature steps. After the core snapshot is built, every
 * feature whose manifest says `"server": true` gets its build(ctx) called
 * and the result stored under snapshot[<id>]. Steps are best-effort: an
 * error or a spent time budget lands INSIDE the block, never fails the
 * refresh. See FEATURES.md "server.js".
 */
import { readFile } from 'node:fs/promises';
import { FEATURES } from '../public/features/registry.js';
import { callTool, callToolPaged, callToolPagedInfo } from './_mcp.js';
import { stepShareMs, TIMEOUTS, clampTimeout } from './_budget.js';

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

/**
 * The `ctx` a feature's build() receives (FEATURES.md "server.js"). Every
 * MCP call goes through here so a step can never run past its own
 * deadline: `timeoutMs` (default `timeouts.default`) is clamped to what is
 * left of the step, and the paged helpers stop at the step deadline unless
 * the feature passes an earlier one. `timeouts` are hints — pass
 * `timeouts.slow` to a tool known to be slow (the tracking-script check).
 */
export function featureCtx({ id, manifest, snapshot, previous = null, deadline, onProgress = () => {} }) {
  const clamp = (opts = {}) => ({ ...opts, timeoutMs: clampTimeout(opts.timeoutMs, deadline) });
  const paged = (opts = {}) => ({ deadline, ...clamp(opts) });
  return {
    id, manifest,
    callTool: (name, args, opts) => callTool(name, args, clamp(opts)),
    callToolPaged: (name, args, opts) => callToolPaged(name, args, paged(opts)),
    callToolPagedInfo: (name, args, opts) => callToolPagedInfo(name, args, paged(opts)),
    snapshot, previous,
    deadline, timeLeft: () => deadline - Date.now(),
    timeouts: TIMEOUTS,
    log: (step) => onProgress(`${id}: ${step}`),
    env: { HYROS_CAC_CEILING: process.env.HYROS_CAC_CEILING },
    now: new Date(),
  };
}

export async function runFeatureSteps({ snapshot, previous = null, deadline, onProgress = () => {} }) {
  const blocks = {};
  const manifests = await loadServerManifests();
  let remaining = manifests.filter((m) => !m.error && m.server).length;
  for (const m of manifests) {
    if (m.error) { blocks[m.id] = { error: `manifest: ${m.error}` }; continue; }
    if (!m.server) continue;
    const prev = previous?.[m.id] ?? null;
    const left = deadline - Date.now();
    // Fair share with a floor: a step may spend left / (steps still to run)
    // but at least min(60 s, left), so a step with one slow call is not
    // starved by an expensive predecessor; the last step gets everything
    // that remains (api/_budget.js stepShareMs).
    const share = stepShareMs(left, remaining);
    remaining -= 1;
    if (left < MIN_STEP_MS) { blocks[m.id] = skippedBlock(prev, 'time budget'); continue; }
    const stepDeadline = Date.now() + share;
    onProgress(`feature ${m.id} (${Math.round(share / 1000)}s)`);
    try {
      const mod = await import(featureUrl(m.id, 'server.js').href);
      if (typeof mod.build !== 'function') throw new Error('server.js must export build(ctx)');
      blocks[m.id] = await mod.build(featureCtx({ id: m.id, manifest: m, snapshot, previous: prev, deadline: stepDeadline, onProgress }));
    } catch (err) {
      blocks[m.id] = { error: err.message };
    }
  }
  return blocks;
}
