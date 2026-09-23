import { timestamp } from '../../shared/attribution.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 2;
const KIND_BYTES = 88000;
const MIN_BUDGET_MS = 1000;
const MARKERS = new Set(['stale', 'skipped', 'error']);
const byteSize = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const redact = (value) => String(value ?? '').replace(/[^\s<>"']+@[^\s<>"']+/g, '[redacted]');
const text = (value, limit = 180) => (typeof value === 'string' || typeof value === 'number')
  ? redact(value).slice(0, limit) || null : null;
const flag = (value) => typeof value === 'boolean' ? value : null;
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const date = (value) => timestamp(value) === null ? null : value;
const currencyOf = (value) => typeof value === 'string' && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null;

function previousOrSkipped(previous) {
  const data = Object.fromEntries(Object.entries(previous || {}).filter(([key]) => !MARKERS.has(key)));
  return Object.keys(data).length ? { ...data, stale: true, skipped: 'time budget' } : { skipped: 'time budget' };
}

export function normalizeConversion(raw, kind, accountCurrency) {
  if (!raw || typeof raw !== 'object' || raw.id == null || raw.id === '') return null;
  const nativeCurrency = currencyOf(raw.price?.currency);
  const usdCurrency = currencyOf(raw.usdPrice?.currency);
  const price = accountCurrency && nativeCurrency === accountCurrency ? raw.price
    : accountCurrency === 'USD' && usdCurrency === 'USD' ? raw.usdPrice : null;
  return {
    id: text(raw.id, 256), leadId: text(raw.leadId, 256), kind,
    date: date(raw.creationDate), amount: number(price?.price), currency: accountCurrency,
    firstSale: flag(raw.firstSale),
    path: (Array.isArray(raw.path) ? raw.path : []).filter((touch) => touch && typeof touch === 'object').map((touch) => ({
      id: text(touch.sourceLinkId, 256), name: text(touch.name), date: date(touch.clickDate),
      platform: text(touch.adSource?.platform || touch.trafficSource?.name, 80),
      organic: flag(touch.organic), disregarded: flag(touch.disregarded),
      adId: text(touch.sourceLinkAd?.adSourceId || touch.adSource?.adSourceId, 256),
      adName: text(touch.sourceLinkAd?.name),
    })),
  };
}

export async function build(ctx) {
  const remaining = () => Math.min(ctx.timeLeft(), Number.isFinite(ctx.deadline) ? ctx.deadline - Date.now() : Infinity);
  if (remaining() < MIN_BUDGET_MS) return previousOrSkipped(ctx.previous);
  const range = ctx.snapshot?.ranges?.['30d'];
  if (!range?.start || !range?.end) return { error: 'Conversion window unavailable.' };
  const accountCurrency = currencyOf(ctx.snapshot?.account?.currency);
  const block = {
    checkedAt: (ctx.now instanceof Date ? ctx.now : new Date()).toISOString(),
    window: { start: range.start, end: range.end }, conversions: [],
    coverage: { sampled: 0, withPaths: 0, complete: false, truncated: false }, errors: [],
  };
  const warn = (message) => { if (!block.errors.includes(message) && block.errors.length < 20) block.errors.push(message); };
  if (!accountCurrency) warn('Account currency unavailable; amounts remain unknown.');
  const states = ['SALE', 'CALL'].map((kind) => ({ kind, pageId: null, cursors: new Set(), complete: false, stopped: false, bytes: 0 }));
  const seen = new Set();
  let halt = false;
  let missingAmounts = 0;
  // Alternate types so another SALE page cannot consume the CALL budget.
  for (let page = 0; page < MAX_PAGES && !halt; page += 1) {
    for (const state of states) {
      if (state.complete || state.stopped || halt) continue;
      const timeLeft = remaining();
      if (timeLeft < MIN_BUDGET_MS) { warn(`${state.kind}: time budget; cohort incomplete.`); halt = true; break; }
      let body;
      try {
        body = await ctx.callTool('hyros_get_conversion_paths', {
          request: { conversionType: state.kind, fromDate: range.start, toDate: range.end,
            windowAttributionDaysRange: 0, pageSize: PAGE_SIZE, ...(state.pageId ? { pageId: state.pageId } : {}) },
        }, { timeoutMs: Math.min(15000, Math.floor(timeLeft - 250)) });
      } catch (error) {
        warn(`${state.kind}: ${text(error?.message || 'Conversion paths unavailable.', 300)}${error?.code === 'rate_limited' ? ' Try next refresh.' : ''}`);
        state.stopped = true;
        if (['auth', 'forbidden', 'NOT_CONFIGURED', 'rate_limited'].includes(error?.code)) halt = true;
        continue;
      }
      const rows = Array.isArray(body) ? body : body?.result;
      if (!Array.isArray(rows)) { warn(`${state.kind}: invalid conversion-path response.`); state.stopped = true; continue; }
      if (rows.length > PAGE_SIZE) { warn(`${state.kind}: response exceeded page size; extra rows omitted.`); state.stopped = true; }
      for (const raw of rows.slice(0, PAGE_SIZE)) {
        const conversion = normalizeConversion(raw, state.kind, accountCurrency);
        if (!conversion?.id) { warn(`${state.kind}: record missing conversion ID omitted.`); state.stopped = true; continue; }
        const key = `${state.kind}:${conversion.id}`;
        if (seen.has(key)) continue;
        const size = byteSize(conversion) + 1;
        if (state.bytes + size > KIND_BYTES) {
          warn(`${state.kind}: storage limit; conversions omitted to retain whole paths.`);
          state.stopped = true;
          break;
        }
        state.bytes += size;
        seen.add(key);
        block.conversions.push(conversion);
        if (state.kind === 'SALE' && conversion.amount === null) missingAmounts += 1;
      }
      const next = !Array.isArray(body) && body?.nextPageId;
      if (!next && !state.stopped) state.complete = true;
      else if (next) {
        if (state.cursors.has(String(next))) { warn(`${state.kind}: repeated cursor; pagination stopped.`); state.stopped = true; }
        state.cursors.add(String(next));
        state.pageId = String(next);
      }
    }
  }
  for (const state of states) {
    if (!state.complete && !state.stopped && state.pageId) warn(`${state.kind}: page limit; showing a sampled cohort.`);
    if (!state.complete && !state.pageId && !state.stopped) warn(`${state.kind}: not fetched; cohort incomplete.`);
  }
  if (missingAmounts) warn(`${missingAmounts} SALE amounts unavailable in account currency; excluded from revenue totals.`);
  block.coverage = {
    sampled: block.conversions.length,
    withPaths: block.conversions.filter((conversion) => conversion.path.length > 0).length,
    complete: states.every((state) => state.complete),
    truncated: states.some((state) => !state.complete),
  };
  return block;
}
