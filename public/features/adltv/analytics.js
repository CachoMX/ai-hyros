const list = (v) => Array.isArray(v) ? v : [];
export const finite = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const date = (v) => v ? Date.parse(v) : NaN;
const day = 86400000;
const currency = (v) => /^[A-Z]{3}$/.test(String(v || '').toUpperCase()) ? String(v).toUpperCase() : null;
const keyOf = (s) => s?.adId ? `ad:${s.adId}` : s?.id || s?.tag ? `source:${s.id || s.tag}` : JSON.stringify([s?.platform || '', s?.name || 'No eligible touch']);
const sourceOf = (s) => ({ key: keyOf(s), name: String(s?.adName || s?.ad || s?.name || 'No eligible touch'), adId: s?.adId == null ? null : String(s.adId), platform: s?.platform || null });
const uniqueSales = (rows) => {
  const seen = new Set();
  return list(rows).filter((r) => {
    if (!r || (r.kind && r.kind !== 'SALE')) return false;
    if (r.id == null) return true;
    const id = String(r.id);
    if (seen.has(id)) return false;
    seen.add(id); return true;
  });
};

export function nativeLtv(snapshot) {
  const range = snapshot?.ranges?.['30d'];
  return list(range?.levels?.ad).filter((r) => [r?.ltv30Days, r?.ltv60Days, r?.ltv90Days].some((v) => finite(v) !== null)).slice(0, 100).map((r) => ({
    id: String(r.id ?? ''), name: String(r.name || r.id || 'Unnamed ad'), currency: currency(snapshot?.account?.currency),
    ltv30: finite(r.ltv30Days), ltv60: finite(r.ltv60Days), ltv90: finite(r.ltv90Days),
    stale: Boolean(range?.stale || range?.skipped), window: { start: range?.start || null, end: range?.end || null },
  }));
}

export function observedRevenue(attribution, native = []) {
  const sales = uniqueSales(list(attribution?.conversions).filter((c) => c?.kind === 'SALE')).slice(0, 2000);
  const sources = new Map(); const leads = new Map(); const candidates = new Map(); const totals = new Map();
  let first = 0; let repeat = 0; let unclassified = 0; let unlinked = 0;
  const aggregate = (map, key, init, sale) => {
    const row = map.get(key) || { ...init, sales: 0, first: 0, repeat: 0, unknown: 0, revenue: 0, unknownAmounts: 0 };
    row.sales += 1;
    row[sale.firstSale === true ? 'first' : sale.firstSale === false ? 'repeat' : 'unknown'] += 1;
    if (finite(sale.amount) === null) row.unknownAmounts += 1;
    else row.revenue += sale.amount;
    map.set(key, row); return row;
  };
  for (const sale of sales) {
    if (sale.firstSale === true) first += 1;
    else if (sale.firstSale === false) repeat += 1;
    else unclassified += 1;
    if (sale.leadId == null || sale.leadId === '') unlinked += 1;
    const touches = list(sale.path).filter((t) => t && t.disregarded !== true && Number.isFinite(date(t.date)) && date(t.date) <= date(sale.date))
      .sort((a, b) => date(a.date) - date(b.date));
    const opening = sourceOf(touches[0]);
    const code = currency(sale.currency);
    const row = aggregate(sources, JSON.stringify([opening.key, code]), { ...opening, currency: code, leads: new Set() }, sale);
    if (sale.leadId != null && sale.leadId !== '') row.leads.add(String(sale.leadId));
    const leadKey = sale.leadId == null || sale.leadId === '' ? ['unlinked', sale.id ?? sales.indexOf(sale)] : ['lead', String(sale.leadId)];
    aggregate(leads, JSON.stringify([leadKey, opening.key, code]), { leadId: sale.leadId == null ? null : String(sale.leadId), source: opening.name, sourceKey: opening.key, currency: code }, sale);
    aggregate(totals, code || 'unknown', { currency: code }, sale);
    const delay = touches.length && date(sale.date) >= date(touches[0].date) ? (date(sale.date) - date(touches[0].date)) / day : null;
    const late = delay !== null && delay >= 7;
    const multi = touches.length > 1;
    if (!late && !multi) continue;
    const eligible = new Map((multi ? touches.slice(0, -1) : touches).map((t) => { const s = sourceOf(t); return [s.key, s]; }));
    for (const s of eligible.values()) {
      const c = candidates.get(s.key) || { ...s, conversions: 0, late: 0, multiTouch: 0, examples: [], native: null };
      c.conversions += 1; c.late += Number(late); c.multiTouch += Number(multi);
      if (c.examples.length < 5 && sale.id != null) c.examples.push(String(sale.id));
      const matches = native.filter((n) => n.id && n.id === s.adId && !n.stale);
      if (matches.length === 1) c.native = { currency: matches[0].currency, ltv30: matches[0].ltv30, ltv60: matches[0].ltv60, ltv90: matches[0].ltv90 };
      candidates.set(s.key, c);
    }
  }
  const rows = [...sources.values()].map(({ leads: ids, ...row }) => ({ ...row, leads: ids.size })).sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name));
  return {
    summary: { sales: sales.length, first, repeat, unclassified, unlinked },
    totals: [...totals.values()], rows: rows.slice(0, 120), leads: [...leads.values()].slice(0, 120),
    candidates: [...candidates.values()].sort((a, b) => b.conversions - a.conversions).slice(0, 40),
    truncated: rows.length > 120 || leads.size > 120 || candidates.size > 40 || list(attribution?.conversions).length > 2000,
  };
}

/** Only a separately verified sales history can supply cohort denominators. */
export function salesHistory(snapshot) {
  const supplied = snapshot?.attribution?.history;
  if (supplied?.basis === 'lead-sales') return supplied;
  const crm = snapshot?.crm;
  if (!crm) return null;
  const byEmail = new Map(list(crm.leads).filter((l) => l?.email && l.id != null).map((l) => [String(l.email).toLowerCase(), l]));
  const byId = new Map(list(crm.leads).filter((l) => l?.id != null).map((l) => [String(l.id), l]));
  return {
    basis: 'lead-sales', complete: crm.sync?.truncated?.sales === false && !crm.error && !crm.sync?.stale && !crm.stale,
    truncated: crm.sync?.truncated?.sales !== false, stale: Boolean(crm.sync?.stale || crm.stale),
    checkedAt: crm.sync?.syncedAt || null, window: { start: crm.window?.from, end: crm.window?.to },
    sales: list(crm.sales).map((s) => {
      const lead = byId.get(String(s.leadId ?? '')) || byEmail.get(String(s.email || '').toLowerCase());
      return { id: s.id, leadId: s.leadId ?? lead?.id ?? null, date: s.date, amount: s.amount, currency: s.currency,
        firstSale: typeof s.firstSale === 'boolean' ? s.firstSale : null, source: lead?.firstSource || null };
    }),
  };
}

export function cohortLtv(history, now) {
  const horizons = [0, 30, 60, 90];
  const start = date(history?.window?.start);
  // A date-only coverage end certifies the full calendar day, capped at the observation time.
  const endRaw = date(history?.window?.end);
  const end = Math.min(date(now), endRaw + (/^\d{4}-\d{2}-\d{2}$/.test(history?.window?.end || '') ? day - 1 : 0));
  const complete = history?.basis === 'lead-sales' && history.complete === true && history.truncated !== true && !history.stale && Number.isFinite(start) && Number.isFinite(end);
  const sales = uniqueSales(history?.sales);
  const byLead = new Map();
  for (const sale of sales) {
    if (sale.leadId == null || sale.leadId === '') continue;
    const key = String(sale.leadId);
    if (!byLead.has(key)) byLead.set(key, []);
    byLead.get(key).push(sale);
  }
  const groups = new Map();
  for (const purchases of byLead.values()) {
    const firsts = purchases.filter((s) => s.firstSale === true);
    if (firsts.length !== 1) continue;
    const anchor = firsts[0];
    const acquiredAt = date(anchor.date);
    const code = currency(anchor.currency);
    const source = sourceOf(anchor.source);
    const key = JSON.stringify([source.key, code]);
    const group = groups.get(key) || { ...source, currency: code, customers: 0, horizons: horizons.map((days) => ({ days, mature: 0, immature: 0, unknown: 0, revenue: 0, value: null, status: 'unknown' })) };
    group.customers += 1;
    for (const h of group.horizons) {
      const target = acquiredAt + h.days * day;
      const elapsed = Number.isFinite(target) && date(now) >= target;
      if (Number.isFinite(target) && !elapsed) { h.immature += 1; continue; }
      const included = h.days === 0 ? [anchor] : purchases.filter((s) => date(s.date) >= acquiredAt && date(s.date) <= target);
      const valid = complete && Number.isFinite(acquiredAt) && start <= acquiredAt && end >= target && code &&
        !purchases.some((s) => !Number.isFinite(date(s.date)) || date(s.date) < acquiredAt) &&
        included.every((s) => finite(s.amount) !== null && currency(s.currency) === code);
      if (!valid) { h.unknown += 1; continue; }
      h.mature += 1; h.revenue += included.reduce((sum, s) => sum + s.amount, 0);
    }
    groups.set(key, group);
  }
  for (const group of groups.values()) for (const h of group.horizons) {
    h.value = h.mature ? h.revenue / h.mature : null;
    h.status = h.mature ? 'mature' : h.unknown ? 'unknown' : h.immature ? 'immature' : 'unknown';
  }
  return {
    basis: 'observed-first-purchase-cohorts', window: history?.window || null, checkedAt: history?.checkedAt || null,
    complete, rows: [...groups.values()].slice(0, 100),
    reason: !groups.size ? 'Unknown: no verified first-purchase cohorts in the available sales history.'
      : !complete ? 'Unknown where sales-history completeness or coverage is unverified.' : null,
  };
}
