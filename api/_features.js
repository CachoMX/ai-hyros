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

export async function runFeatureSteps({ snapshot, previous = null, deadline, onProgress = () => {} }) {
  const blocks = {};
  for (const m of await loadServerManifests()) {
    if (m.error) { blocks[m.id] = { error: `manifest: ${m.error}` }; continue; }
    if (!m.server) continue;
    if (Date.now() > deadline - 2000) { blocks[m.id] = { skipped: 'time budget' }; continue; }
    onProgress(`feature ${m.id}`);
    try {
      const mod = await import(featureUrl(m.id, 'server.js').href);
      if (typeof mod.build !== 'function') throw new Error('server.js must export build(ctx)');
      const ctx = {
        id: m.id, manifest: m,
        callTool, callToolPaged,
        snapshot, previous: previous?.[m.id] ?? null,
        deadline, timeLeft: () => deadline - Date.now(),
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
