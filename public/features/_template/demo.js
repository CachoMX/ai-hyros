/**
 * demo.js — the block this feature shows on the Demo account. Must be a
 * pure, deterministic function of the demo snapshot (use the seeded rng
 * from ../../demo.js — never Math.random) and must produce EXACTLY the
 * block shape server.js produces, so the view has one code path.
 *
 * Seed: derive it from the feature id so two features never share a
 * stream (same seed + same draws = the same "random" numbers on two tabs).
 * `seedFor('my-feature')` below sums the id's char codes; any stable
 * function of the id works — just never a literal shared with another
 * feature (scale uses 55, the core demo uses 1..20).
 */
import { rng, jitter, round2, ymd, daysAgo } from '../../demo.js';

const FEATURE_ID = 'my-feature';
const seedFor = (id) => [...id].reduce((s, ch) => s + ch.charCodeAt(0), 0);

export function demo(snapshot) {
  const r = rng(seedFor(FEATURE_ID));
  const rows = [...snapshot.ranges['30d'].levels.campaign]
    .slice(0, 5)
    .map((c) => ({ name: c.name, value: round2(jitter(r, c.revenue || 1000, 0.2)) }));
  return { window: { start: ymd(daysAgo(29)), end: ymd(new Date()) }, rows, errors: [] };
}
