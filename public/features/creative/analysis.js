import { finite, revenueOf, sumKnown, windowDays } from '../../shared/profit.js';

export const SLOTS = ['concept', 'angle', 'hook', 'format', 'variation'];
const memory = new Map();
const storageKey = (account) => `aihyros:creative:v1:${encodeURIComponent(String(account ?? 'default'))}`;

export function normalizeCreativeSettings(input = {}) {
  const s = input && typeof input === 'object' ? input : {};
  const validSlots = Array.isArray(s.slots) && s.slots.length === 5 && s.slots.every((slot) => SLOTS.includes(slot) || slot === 'ignore')
    && new Set(s.slots.filter((slot) => slot !== 'ignore')).size === s.slots.filter((slot) => slot !== 'ignore').length;
  const bounded = (value, fallback, min, max) => value !== '' && value != null && Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
  return { version: 1, configured: s.configured === true,
    separator: typeof s.separator === 'string' ? s.separator.slice(0, 12) : '_', slots: validSlots ? [...s.slots] : [...SLOTS],
    concentrationPct: bounded(s.concentrationPct, 70, 0, 100), minVariants: Math.round(bounded(s.minVariants, 3, 2, 100)),
    minSpend: bounded(s.minSpend, 0, 0, 1e12), minSales: bounded(s.minSales, 0, 0, 1e9) };
}

export function loadCreativeSettings(account) {
  const key = storageKey(account);
  if (memory.has(key)) return normalizeCreativeSettings(memory.get(key));
  try { return normalizeCreativeSettings(JSON.parse(globalThis.localStorage?.getItem(key) || 'null')); }
  catch { return normalizeCreativeSettings(); }
}

export function saveCreativeSettings(account, input) {
  const settings = normalizeCreativeSettings(input), key = storageKey(account);
  memory.set(key, settings);
  let persisted = false;
  try { if (globalThis.localStorage) { globalThis.localStorage.setItem(key, JSON.stringify(settings)); persisted = true; memory.delete(key); } }
  catch { /* Keep a session copy if local storage is blocked. */ }
  return { settings: normalizeCreativeSettings(settings), persisted };
}

/** Adapted from Mosaide: preserve empty slots and join overflow into the final slot. */
export function parseAdName(name, slots = SLOTS, separator = '_') {
  const result = Object.fromEntries(SLOTS.map((slot) => [slot, null]));
  const trimmed = String(name ?? '').trim();
  if (!trimmed || !slots.length) return result;
  const segments = separator === '' ? [trimmed] : trimmed.split(separator);
  slots.forEach((slot, index) => {
    if (!SLOTS.includes(slot)) return;
    const text = index === slots.length - 1 ? segments.slice(index).join(separator) : segments[index];
    result[slot] = text?.trim() || null;
  });
  return result;
}

export function groupCreatives(rows, input = {}, dimension = 'concept') {
  const settings = normalizeCreativeSettings(input), buckets = new Map();
  const by = SLOTS.includes(dimension) ? dimension : 'concept';
  rows.forEach((row, index) => {
    const slots = settings.configured ? parseAdName(row.name, settings.slots, settings.separator) : parseAdName('');
    const parsed = slots[by];
    const fallback = by === 'concept' && (row.parentName || row.parentId);
    const name = parsed || (fallback ? String(row.parentName || row.parentId) : 'Unclassified');
    const basis = parsed ? `Name slot: ${by}` : fallback ? 'Ad set fallback' : 'Unclassified';
    const groupKey = JSON.stringify([row._account ?? null, row._traffic ?? null, basis, parsed || row.parentId || name]);
    const revenue = revenueOf(row), spend = finite(row.cost);
    const item = { id: row.id == null ? `missing-${index}` : String(row.id), name: String(row.name || row.id || 'Unnamed ad'),
      row, slots, revenue: revenue.revenue, revenueBasis: revenue.basis, issues: revenue.issues,
      spend: spend !== null && spend >= 0 ? spend : null, sales: finite(row.sales), share: null,
      roas: revenue.revenue !== null && spend > 0 ? revenue.revenue / spend : null };
    if (!buckets.has(groupKey)) buckets.set(groupKey, { key: groupKey, name, basis,
      account: row._account ?? null, platform: row._traffic ?? null, variants: [] });
    buckets.get(groupKey).variants.push(item);
  });
  return [...buckets.values()].map((group) => {
    const { variants } = group;
    const revenue = sumKnown(variants.map((item) => item.revenue)), spend = sumKnown(variants.map((item) => item.spend));
    const sales = sumKnown(variants.map((item) => item.sales));
    const shareKnown = revenue > 0 && variants.every((item) => item.revenue >= 0 && item.revenue !== null);
    variants.forEach((item) => { item.share = shareKnown ? item.revenue / revenue : null; });
    variants.sort((a, b) => (b.revenue ?? -Infinity) - (a.revenue ?? -Infinity));
    const topShare = shareKnown ? variants[0].share : null;
    const evidenceMet = input.coverageComplete !== false && spend !== null && spend >= settings.minSpend && (settings.minSales === 0 || sales !== null && sales >= settings.minSales);
    const concentrated = evidenceMet && topShare !== null && variants.length >= settings.minVariants && topShare * 100 > settings.concentrationPct;
    const bases = [...new Set(variants.map((item) => item.revenueBasis))];
    return { ...group, revenue, spend, sales, topShare, evidenceMet, concentrated,
      revenueBasis: bases.length === 1 ? bases[0] : 'mixed', roas: revenue !== null && spend > 0 ? revenue / spend : null };
  }).sort((a, b) => (b.spend ?? -Infinity) - (a.spend ?? -Infinity));
}

export function comparablePeriods(current, previous, asOf) {
  if (!current?.complete || !previous?.complete) return false;
  const days = windowDays(current);
  if (!days || days !== windowDays(previous)) return false;
  if (!current.model || current.model !== previous.model || !current.currency || current.currency !== previous.currency) return false;
  if (!current.context || current.context !== previous.context) return false;
  const today = typeof asOf === 'string' ? asOf.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || current.end >= today || previous.end >= today) return false;
  return Date.parse(`${current.start}T00:00:00Z`) - Date.parse(`${previous.end}T00:00:00Z`) === 86400000;
}

export function compareGroup(current, previous) {
  if (!previous || current.revenueBasis !== previous.revenueBasis) return { delta: null, reason: 'Comparable revenue basis unavailable' };
  const identities = (group) => group.variants.map((item) => item.row.id == null ? null : item.id).sort();
  const currentIds = identities(current), previousIds = identities(previous);
  if (currentIds.includes(null) || previousIds.includes(null) || JSON.stringify(currentIds) !== JSON.stringify(previousIds)) return { delta: null, reason: 'Ad mix differs or IDs are missing' };
  if (current.roas === null || previous.roas === null || previous.roas <= 0) return { delta: null, reason: 'Positive comparison ROAS unavailable' };
  return { delta: (current.roas / previous.roas - 1) * 100, reason: 'Observed ROAS change; matching ad IDs' };
}
