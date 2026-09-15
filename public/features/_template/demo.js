/**
 * demo.js — the block this feature shows on the Demo account. Must be a
 * pure, deterministic function of the demo snapshot (use the seeded rng
 * from ../../demo.js — never the unseeded random) and must produce EXACTLY the
 * block shape server.js produces, so the view has one code path.
 */
import { rng, jitter, round2, ymd, daysAgo } from '../../demo.js';

export function demo(snapshot) {
  const r = rng(101);
  const rows = [...snapshot.ranges['30d'].levels.campaign]
    .slice(0, 5)
    .map((c) => ({ name: c.name, value: round2(jitter(r, c.revenue || 1000, 0.2)) }));
  return { window: { start: ymd(daysAgo(29)), end: ymd(new Date()) }, rows };
}
