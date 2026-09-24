import { finite, revenueOf, sumKnown, windowDays } from '../../shared/profit.js';

export const SLOTS = ['concept', 'angle', 'hook', 'format', 'variation'];
export const MAX_SEPARATORS = 3;
const memory = new Map();
const storageKey = (account) => `aihyros:creative:v1:${encodeURIComponent(String(account ?? 'default'))}`;

function cleanSeparators(input) {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? [input] : null;
  if (!list) return null;
  const out = [];
  for (const value of list) {
    if (typeof value !== 'string' || value === '') continue;
    const trimmed = value.slice(0, 12);
    if (!out.includes(trimmed)) out.push(trimmed);
    if (out.length === MAX_SEPARATORS) break;
  }
  return out;
}

export function normalizeCreativeSettings(input = {}) {
  const s = input && typeof input === 'object' ? input : {};
  const validSlots = Array.isArray(s.slots) && s.slots.length === 5 && s.slots.every((slot) => SLOTS.includes(slot) || slot === 'ignore')
    && new Set(s.slots.filter((slot) => slot !== 'ignore')).size === s.slots.filter((slot) => slot !== 'ignore').length;
  const bounded = (value, fallback, min, max) => value !== '' && value != null && Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
  // `separators` is authoritative; the legacy single `separator` is still accepted and mirrored.
  const separators = cleanSeparators(s.separators) ?? (typeof s.separator === 'string' ? cleanSeparators(s.separator) : ['_']);
  return { version: 1, configured: s.configured === true, detect: s.detect !== false,
    separators, separator: separators[0] ?? '', slots: validSlots ? [...s.slots] : [...SLOTS],
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

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Split on any of the separators (longest first); each part keeps its offset so overflow can be re-joined verbatim. */
export function splitAdName(text, separators) {
  const list = cleanSeparators(separators) ?? [];
  if (!list.length) return [{ text, start: 0 }];
  const pattern = new RegExp([...list].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'), 'g');
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push({ text: text.slice(last, match.index), start: last });
    last = match.index + match[0].length;
  }
  parts.push({ text: text.slice(last), start: last });
  return parts;
}

/** Adapted from Mosaide: preserve empty slots and join overflow into the final slot. */
export function parseAdName(name, slots = SLOTS, separators = '_') {
  const result = Object.fromEntries(SLOTS.map((slot) => [slot, null]));
  const trimmed = String(name ?? '').trim();
  if (!trimmed || !slots.length) return result;
  const parts = splitAdName(trimmed, separators);
  const lastActive = slots.reduce((last, slot, index) => (SLOTS.includes(slot) ? index : last), -1);
  slots.forEach((slot, index) => {
    if (!SLOTS.includes(slot)) return;
      // Overflow segments are joined verbatim into the last active slot.
    const text = index === lastActive ? (parts[index] ? trimmed.slice(parts[index].start) : undefined) : parts[index]?.text;
    result[slot] = text?.trim() || null;
  });
  return result;
}

/* ------------------------------------------------------------------ *
 *  Naming detection: which delimiters the account's ad names actually use
 * ------------------------------------------------------------------ */

// Spaced forms first so " - " wins over the bare "-" inside "Before-After".
const CANDIDATE_SEPARATORS = [' | ', ' - ', ' – ', ' — ', ' / ', ' :: ', ' : ', '_', '|', '/', '#'];
const UNNAMED = /^(?:ad|adset|ad set|campaign|creative)?\s*[#_-]?\s*\d{5,}$/i;
const ORDINAL = /^(?:ad|v|var|ver|version|variant|variation|creative|cr|test|t)?\s*[#_-]?\s*\d+[a-z]?$/i;
const MIN_NAMED = 3, MIN_COVERAGE = 0.6, MIN_ORDINAL_SHARE = 0.7, MIN_SEGMENT_SHARE = 0.3;

/**
 * Inspect ad names and propose delimiters plus a slot mapping. The proposal is
 * observation, not a label: it says how many names it explains (coverage) and
 * leaves unnamed ads (platform ids only) out of that share.
 */
export function detectNaming(rows) {
  const names = [...new Set((Array.isArray(rows) ? rows : []).map((row) => String(row?.name ?? '').trim()).filter(Boolean))];
  const unnamed = names.filter((name) => UNNAMED.test(name));
  const named = names.filter((name) => !UNNAMED.test(name));
  const base = { total: names.length, named: named.length, unnamed: unnamed.length, separators: [], slots: [], segments: 1, coverage: 0, confident: false };
  if (named.length < MIN_NAMED) return base;
  const separators = [];
  for (const candidate of CANDIDATE_SEPARATORS) {
    if (separators.length === MAX_SEPARATORS || separators.includes(candidate)) continue;
    // A bare form is redundant once its spaced form (or any chosen separator containing it) is in.
    if (separators.some((chosen) => chosen !== candidate && chosen.includes(candidate.trim()) && candidate.trim() !== '')) continue;
    const hits = named.filter((name) => name.includes(candidate)).length;
    if (hits / named.length >= MIN_COVERAGE / 2) separators.push(candidate);
  }
  if (!separators.length) return base;
  const counts = named.map((name) => splitAdName(name, separators).length);
  const structured = counts.filter((count) => count >= 2).length;
  const coverage = structured / named.length;
  const histogram = new Map();
  for (const count of counts) if (count >= 2) histogram.set(count, (histogram.get(count) || 0) + 1);
  // Use the deepest segment count that a meaningful share of names reaches, so
  // "Ad 2 - Zoe 2 | Hook" keeps its hook even when half the names stop earlier.
  const deep = [...histogram.entries()].filter(([, count]) => count / named.length >= MIN_SEGMENT_SHARE).map(([count]) => count);
  const segments = Math.min(5, deep.length ? Math.max(...deep) : 1);
  const slots = [];
  const remaining = ['concept', 'angle', 'hook', 'format'];
  let variationTaken = false;
  for (let index = 0; index < 5; index += 1) {
    if (index >= segments) { slots.push('ignore'); continue; }
    const values = named.map((name) => splitAdName(name, separators)[index]?.text.trim()).filter(Boolean);
    const ordinal = values.length ? values.filter((value) => ORDINAL.test(value)).length / values.length >= MIN_ORDINAL_SHARE : false;
    if (ordinal && !variationTaken) { slots.push('variation'); variationTaken = true; continue; }
    slots.push(ordinal ? 'ignore' : (remaining.shift() ?? (variationTaken ? 'ignore' : 'variation')));
  }
  if (!variationTaken && segments === 5 && slots[4] !== 'variation') slots[4] = 'variation';
  return { ...base, separators, slots, segments, coverage, confident: coverage >= MIN_COVERAGE && segments >= 2 };
}

/**
 * Effective naming for a view: saved settings win; otherwise a confident
 * detection is applied and labelled as such (the operator can keep or turn it
 * off); otherwise names stay unparsed and groups use the ad set fallback.
 */
export function resolveNaming(saved, rows) {
  const settings = normalizeCreativeSettings(saved);
  if (settings.configured) return { settings, source: 'saved', detection: null };
  const detection = settings.detect ? detectNaming(rows) : null;
  if (detection?.confident) {
    return { settings: normalizeCreativeSettings({ ...settings, configured: true, separators: detection.separators, slots: detection.slots }), source: 'detected', detection };
  }
  return { settings, source: 'none', detection };
}

export const activeSlots = (settings) => SLOTS.filter((slot) => settings.slots.includes(slot));

export function groupCreatives(rows, input = {}, dimension = 'concept') {
  const settings = normalizeCreativeSettings(input), buckets = new Map();
  const by = SLOTS.includes(dimension) ? dimension : 'concept';
  rows.forEach((row, index) => {
    const slots = settings.configured ? parseAdName(row.name, settings.slots, settings.separators) : parseAdName('');
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
