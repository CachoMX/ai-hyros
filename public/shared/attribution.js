const DAY_MS = 86400000;
export const ATTRIBUTION_MODELS = ['first', 'last', 'linear', 'position', 'decay'];

export function finiteAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z`
    : /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function uniqueConversions(conversions, kind = 'SALE') {
  const seen = new Set();
  return (Array.isArray(conversions) ? conversions : []).filter((conversion) => {
    if (!conversion || conversion.kind !== kind) return false;
    if (conversion.id == null || conversion.id === '') return true;
    const id = String(conversion.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function sourceOf(touch) {
  if (touch?.id != null && touch.id !== '') return String(touch.id);
  return touch?.name ? `name:${touch.platform || ''}:${touch.name}` : null;
}

function positionWeights(options) {
  const supplied = options.positionWeights || { first: 40, middle: 20, last: 40 };
  const values = ['first', 'middle', 'last'].map((key) => Math.max(0, finiteAmount(supplied[key]) ?? 0));
  return values;
}

/** Every original touch stays visible as evidence, including why it received no credit. */
export function getTouchCredits(conversion, options = {}) {
  const model = ATTRIBUTION_MODELS.includes(options.model) ? options.model : 'first';
  const windowDays = Math.max(0, finiteAmount(options.windowDays) ?? 0);
  const halfLife = Math.max(0.01, finiteAmount(options.halfLifeDays) ?? 7);
  const convertedAt = timestamp(conversion?.date);
  const entries = (Array.isArray(conversion?.path) ? conversion.path : []).map((touch, index) => {
    const at = timestamp(touch?.date);
    const reason = !touch || !sourceOf(touch) ? 'Missing source'
      : touch.disregarded === true ? 'Disregarded'
        : options.includeOrganic === false && touch.organic !== false ? (touch.organic === true ? 'Organic excluded' : 'Organic status unknown')
          : convertedAt === null || at === null ? 'Missing date'
            : at > convertedAt ? 'After conversion'
              : windowDays > 0 && at < convertedAt - windowDays * DAY_MS ? 'Outside window' : null;
    return { touch, index, at, reason, weight: 0 };
  });
  const eligible = entries.filter((entry) => !entry.reason).sort((a, b) => a.at - b.at || a.index - b.index);
  const count = eligible.length;
  if (!count) return entries;
  const [first, middle, last] = positionWeights(options);
  // Relative ages avoid underflow when every touch is very old.
  const mostRecent = eligible[count - 1].at;
  const raw = eligible.map((entry, index) => {
    if (count === 1) return 1;
    if (model === 'first') return index === 0 ? 1 : 0;
    if (model === 'last') return index === count - 1 ? 1 : 0;
    if (model === 'linear') return 1;
    if (model === 'decay') return 2 ** (-(mostRecent - entry.at) / DAY_MS / halfLife);
    return index === 0 ? first : index === count - 1 ? last : middle / (count - 2);
  });
  const scale = Math.max(...raw);
  const scaled = scale > 0 ? raw.map((value) => value / scale) : raw;
  const total = scaled.reduce((sum, value) => sum + value, 0);
  const weights = total > 0 ? scaled.map((value) => value / total) : raw.map(() => 1 / count);
  const lastPositive = weights.findLastIndex((value) => value > 0);
  let assigned = 0;
  eligible.forEach((entry, index) => {
    entry.weight = index === lastPositive ? Math.max(0, 1 - assigned) : weights[index];
    assigned += entry.weight;
  });
  return entries;
}

function compute(conversions, options, kind) {
  const sources = new Map();
  let totalRevenue = 0;
  let unattributedRevenue = 0;
  for (const conversion of uniqueConversions(conversions, kind)) {
    const amount = kind === 'SALE' ? finiteAmount(conversion.amount) ?? 0 : 0;
    totalRevenue += amount;
    const eligible = getTouchCredits(conversion, options).filter((entry) => !entry.reason);
    if (!eligible.length) { unattributedRevenue += amount; continue; }
    const positive = eligible.filter((entry) => entry.weight > 0);
    let allocated = 0;
    eligible.forEach((entry) => {
      const sourceId = sourceOf(entry.touch);
      if (!sources.has(sourceId)) sources.set(sourceId, { sourceId, name: entry.touch.name || sourceId, revenue: 0, conversions: 0, touches: 0 });
      const row = sources.get(sourceId);
      const revenue = entry === positive[positive.length - 1] ? amount - allocated : amount * entry.weight;
      allocated += revenue;
      row.revenue += revenue;
      row.conversions += entry.weight;
      row.touches += 1;
    });
  }
  const rows = [...sources.values()].sort((a, b) => b.revenue - a.revenue || b.conversions - a.conversions || a.sourceId.localeCompare(b.sourceId));
  const attributedRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  return { rows, unattributedRevenue, totalRevenue, attributedRevenue };
}

/** SALE amounts only. Missing amounts contribute conversion credit but no invented revenue. */
export function computeAttribution(conversions, options = {}) {
  return compute(conversions, options || {}, 'SALE');
}

/** CALL credit is always a count; native call prices never become sale revenue. */
export function computeCallAttribution(conversions, options = {}) {
  return compute(conversions, options || {}, 'CALL');
}
