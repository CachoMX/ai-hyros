const list = (v) => Array.isArray(v) ? v : [];
const finite = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const stamp = (v) => v ? Date.parse(v) : NaN;
const text = (v) => String(v ?? '');
const source = (t) => ({
  key: t.id ? `source:${t.id}` : JSON.stringify([t.platform || '', t.name || 'Unknown source', t.organic ?? null]),
  name: text(t.name || t.adName || 'Unknown source'), platform: text(t.platform), organic: t.organic === true,
});
const cleanPrevious = (b) => Object.fromEntries(Object.entries(b || {}).filter(([k]) => !['stale', 'skipped', 'error'].includes(k)));

export function crmCounts(crm) {
  const present = crm && typeof crm === 'object';
  const count = (key) => Array.isArray(crm?.[key]) ? crm[key].length : null;
  return {
    window: { start: crm?.window?.from || null, end: crm?.window?.to || null },
    checkedAt: crm?.sync?.syncedAt || null,
    leads: count('leads'), calls: count('calls'), sales: count('sales'),
    qualifiedCalls: Array.isArray(crm?.calls) ? crm.calls.filter((r) => r?.qualified === true).length : null,
    stale: Boolean(crm?.sync?.stale || crm?.stale),
    partial: !present || ['leads', 'calls', 'sales'].some((key) => !Array.isArray(crm?.[key]) || crm?.sync?.truncated?.[key] !== false) || Boolean(crm?.error),
  };
}

export function analyzePaths(attribution) {
  const input = list(attribution?.conversions);
  const seen = new Set();
  const conversions = input.filter((c) => {
    if (!c || !['SALE', 'CALL'].includes(c.kind)) return false;
    const key = c.id == null ? null : `${c.kind}:${c.id}`;
    if (key && seen.has(key)) return false;
    if (key) seen.add(key);
    return true;
  }).slice(0, 2000);
  const sources = new Map();
  const flows = new Map();
  const journeys = [];
  const summary = { conversions: conversions.length, sales: 0, calls: 0, withPaths: 0, noTouch: 0, multiTouch: 0, late: 0, avgTouches: null, avgDays: null };
  let totalTouches = 0; let totalDays = 0; let dated = 0; let bytes = 0;
  for (const c of conversions) {
    summary[c.kind === 'SALE' ? 'sales' : 'calls'] += 1;
    const chain = list(c.path).filter((t) => t && typeof t === 'object');
    const exclusion = (t) => t.disregarded === true ? 'disregarded'
      : !Number.isFinite(stamp(t.date)) || !Number.isFinite(stamp(c.date)) ? 'date unknown'
        : stamp(t.date) > stamp(c.date) ? 'after conversion' : null;
    const touches = chain.filter((t) => !exclusion(t)).sort((a, b) => stamp(a.date) - stamp(b.date));
    const days = touches.length && Number.isFinite(stamp(touches[0].date)) && stamp(c.date) >= stamp(touches[0].date)
      ? (stamp(c.date) - stamp(touches[0].date)) / 86400000 : null;
    if (touches.length) summary.withPaths += 1;
    else summary.noTouch += 1;
    if (touches.length > 1) summary.multiTouch += 1;
    if (days !== null) { totalDays += days; dated += 1; if (days >= 7) summary.late += 1; }
    totalTouches += touches.length;
    const roles = new Map();
    touches.forEach((t, i) => {
      const s = source(t);
      const role = roles.get(s.key) || { ...s, opening: false, closing: false, assist: false };
      if (i === 0) role.opening = true;
      if (i === touches.length - 1) role.closing = true;
      if (i > 0 && i < touches.length - 1) role.assist = true;
      roles.set(s.key, role);
    });
    for (const role of roles.values()) {
      const row = sources.get(role.key) || { key: role.key, name: role.name, platform: role.platform, organic: role.organic, opening: 0, closing: 0, assists: 0, sales: 0, calls: 0, touched: 0 };
      row.opening += Number(role.opening); row.closing += Number(role.closing); row.assists += Number(role.assist); row.touched += 1;
      row[c.kind === 'SALE' ? 'sales' : 'calls'] += 1;
      sources.set(role.key, row);
    }
    const steps = touches.length ? touches.map(source) : [{ key: 'no-touch', name: 'No eligible touch', platform: '', organic: false }];
    steps.push({ key: `conversion:${c.kind}`, name: c.kind === 'SALE' ? 'Sale' : 'Call' });
    const flowKey = JSON.stringify(steps.map((s) => s.key));
    const flow = flows.get(flowKey) || { steps: steps.map((s) => s.name), kind: c.kind, count: 0 };
    flow.count += 1; flows.set(flowKey, flow);
    const journey = {
      id: text(c.id), leadId: c.leadId == null ? null : text(c.leadId), kind: c.kind, date: c.date || null,
      amount: finite(c.amount), currency: c.currency || null, firstSale: typeof c.firstSale === 'boolean' ? c.firstSale : null,
      days, eligibleTouches: touches.length,
      path: chain.map((t) => ({ id: text(t.id), name: text(t.name || t.adName || 'Unknown source'), date: t.date || null,
        platform: text(t.platform), organic: t.organic ?? null, disregarded: t.disregarded ?? null, exclusion: exclusion(t), adId: t.adId || null, adName: t.adName || null })),
    };
    // Keep complete chains; omit entire samples when the evidence budget is full.
    const size = JSON.stringify(journey).length * 3;
    if (journeys.length < 60 && bytes + size <= 90000) { journeys.push(journey); bytes += size; }
  }
  summary.avgTouches = summary.withPaths ? totalTouches / summary.withPaths : null;
  summary.avgDays = dated ? totalDays / dated : null;
  const rankedSources = [...sources.values()].sort((a, b) => b.touched - a.touched || a.name.localeCompare(b.name));
  const rankedFlows = [...flows.values()].sort((a, b) => b.count - a.count).filter((r) => JSON.stringify(r).length < 5000);
  const errors = list(attribution?.errors).map((e) => text(e).slice(0, 600)).slice(0, 15);
  if (input.length > 2000) errors.push('Analysis limited to the first 2,000 conversion records.');
  if (sources.size > 80) errors.push('Showing the 80 most observed sources.');
  if (flows.size > Math.min(rankedFlows.length, 20)) errors.push(`Showing ${Math.min(rankedFlows.length, 20)} of ${flows.size} path flows within the snapshot size limit.`);
  if (journeys.length < conversions.length) errors.push(`Evidence explorer contains ${journeys.length} of ${conversions.length} complete conversion chains.`);
  return {
    summary, sources: rankedSources.slice(0, 80), flows: rankedFlows.slice(0, 20), journeys,
    coverage: { sampled: attribution?.coverage?.sampled ?? null, complete: attribution?.coverage?.complete === true && input.length <= 2000,
      truncated: Boolean(attribution?.coverage?.truncated) || input.length > 2000, analyzed: conversions.length, evidence: journeys.length }, errors,
  };
}

export async function build(ctx) {
  if (ctx.timeLeft?.() <= 0) {
    const previous = cleanPrevious(ctx.previous);
    return Object.keys(previous).length ? { ...previous, stale: true, skipped: 'time budget' } : { skipped: 'time budget' };
  }
  try {
    const a = ctx.snapshot?.attribution;
    const available = Array.isArray(a?.conversions);
    const block = {
      mode: 'paths', checkedAt: a?.checkedAt || ctx.now?.toISOString() || null,
      window: { start: a?.window?.start || null, end: a?.window?.end || null },
      pathStatus: available ? 'ready' : a?.error ? 'error' : a?.skipped ? 'skipped' : 'unavailable',
      pathReason: a?.error || a?.skipped ? text(a.error || a.skipped).slice(0, 600) : (!available ? 'No conversion-path sample in this snapshot. Refresh to check again.' : null),
      ...analyzePaths(a), crm: crmCounts(ctx.snapshot?.crm),
    };
    if (a?.stale) { block.stale = true; block.skipped = a.skipped || 'attribution data from previous refresh'; }
    const size = () => new TextEncoder().encode(JSON.stringify(block)).length;
    if (size() > 180000) {
      block.errors.push('Additional complete evidence chains or detail rows omitted to keep the snapshot below 180 KB.');
      const groups = [block.journeys, block.flows, block.sources];
      while (size() > 180000 && groups.some((rows) => rows.length)) groups.find((rows) => rows.length).pop();
      block.coverage.evidence = block.journeys.length;
    }
    return block;
  } catch (err) { return { error: err.message }; }
}
