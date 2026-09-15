/**
 * Date helpers for the HYROS pipeline (server side, no dependencies).
 *
 * `userProfile.timezone` is typed as a free string by the API, so an account
 * may say "-05:00", "UTC", "GMT-5", "-5" or "America/New_York". Everything
 * here takes any of those; an unparseable value is reported as null so the
 * caller can fall back to UTC loudly (a warning) instead of silently.
 */

/* ---------------- timezone ---------------- */

const OFFSET_RE = /^(?:UTC|GMT)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i;
const ZERO_RE = /^(?:UTC|GMT|Z|UCT|Etc\/UTC|Etc\/GMT)$/i;

const pad2 = (n) => String(Math.abs(n)).padStart(2, '0');

/** Minutes -> "+HH:MM". */
export function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  return `${sign}${pad2(Math.floor(Math.abs(minutes) / 60))}:${pad2(Math.abs(minutes) % 60)}`;
}

/**
 * Parse an account timezone string.
 *   { kind: 'offset', minutes, offset: '±HH:MM' }   numeric forms
 *   { kind: 'iana', name }                          names Intl knows
 *   null                                            not understood
 */
export function parseTimezone(tz) {
  const raw = String(tz || '').trim();
  if (!raw) return null;
  if (ZERO_RE.test(raw)) return { kind: 'offset', minutes: 0, offset: '+00:00' };
  const m = OFFSET_RE.exec(raw);
  if (m) {
    const hours = Number(m[2]);
    const mins = Number(m[3] || 0);
    if (hours > 14 || mins > 59) return null;
    const minutes = (m[1] === '-' ? -1 : 1) * (hours * 60 + mins);
    return { kind: 'offset', minutes, offset: formatOffset(minutes) };
  }
  try {
    // Intl validates the name (RangeError otherwise) and canonicalises case.
    const name = new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
    return { kind: 'iana', name };
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw err;
  }
}

/** Offset like "-06:00" -> minutes; 0 for IANA names and anything unparseable. */
export function offsetMinutes(tz) {
  const parsed = parseTimezone(tz);
  return parsed?.kind === 'offset' ? parsed.minutes : 0;
}

/** Offset string for a request date param: numeric forms only, '' for IANA/unknown (the API assumes the account zone). */
export function offsetSuffix(tz) {
  const parsed = parseTimezone(tz);
  return parsed?.kind === 'offset' ? parsed.offset : '';
}

const ymdFormatters = new Map();
function ymdFormatter(name) {
  if (!ymdFormatters.has(name)) {
    ymdFormatters.set(name, new Intl.DateTimeFormat('en-CA', { timeZone: name, year: 'numeric', month: '2-digit', day: '2-digit' }));
  }
  return ymdFormatters.get(name);
}

/** The calendar date (YYYY-MM-DD) of `date` in the account timezone; UTC when the zone is not understood. */
export function ymdInTz(date, tz) {
  const parsed = parseTimezone(tz);
  if (parsed?.kind === 'iana') return ymdFormatter(parsed.name).format(date);
  const shifted = new Date(date.getTime() + (parsed?.minutes || 0) * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Request date params. Every documented example carries a time and offset
 * ('2021-04-16T20:35:00-05:00') and list filters are worded as strict
 * bounds, so a bare YYYY-MM-DD may exclude the day itself. Numeric zones
 * get their offset; IANA names get none (the API then assumes the account
 * timezone, which is that zone).
 */
export function dayStart(ymd, tz) {
  return `${ymd}T00:00:00${offsetSuffix(tz)}`;
}

export function dayEnd(ymd, tz) {
  return `${ymd}T23:59:59${offsetSuffix(tz)}`;
}

export function addDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
