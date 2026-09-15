/**
 * The refresh time budget — every number derives from ONE constant.
 *
 * Vercel runs /api/refresh for at most REFRESH_MAX_S seconds (Fluid compute:
 * 300 s on Hobby and Pro; api/refresh.js `maxDuration` and vercel.json both
 * say so). Everything below is carved out of that:
 *
 *   REFRESH_BUDGET_MS   what one build may spend (the max minus headroom for
 *                       reading prefs / writing the snapshot to KV)
 *   planBudget(ms)      proportional reservations inside one build —
 *                       core (attribution) ≤ 45 %, CRM ≤ 30 %, features get
 *                       the rest and at least FEATURES_MIN_MS when the
 *                       budget allows, so a slow attribution pull can never
 *                       starve the CRM or the feature steps
 *   stepShareMs(...)    a feature step's slice of the features slot
 *   cronAccountBudgetMs the daily cron's per-account share
 *   TIMEOUTS            per-call timeout hints handed to features as
 *                       ctx.timeouts (default 15 s, slow 45 s)
 *
 * Hobby projects WITHOUT Fluid compute are capped at 60 s: lower
 * `maxDuration` in vercel.json (and REFRESH_MAX_S here) to 60 — every
 * share below scales with it.
 */

/** Seconds Vercel lets /api/refresh run. Mirrors vercel.json functions["api/refresh.js"].maxDuration. */
export const REFRESH_MAX_S = 300;
export const REFRESH_MAX_MS = REFRESH_MAX_S * 1000;

/** Kept back for the KV reads/writes around the build (prefs, previous snapshot, persist, status). */
const HEADROOM_MS = 10000;

/** What one snapshot build may spend (manual refresh and the cron alike). */
export const REFRESH_BUDGET_MS = REFRESH_MAX_MS - HEADROOM_MS;

/** Cron: the whole run has the build budget; each account gets at most this, and never starts with less than the minimum. */
export const CRON_BUDGET_MS = REFRESH_BUDGET_MS;
export const CRON_ACCOUNT_MAX_MS = 120000;
export const CRON_MIN_ACCOUNT_MS = 20000;

/** The stalest account gets min(what is left of the run, the per-account cap). */
export function cronAccountBudgetMs(leftMs) {
  return Math.max(0, Math.min(CRON_ACCOUNT_MAX_MS, Math.floor(leftMs)));
}

/* ---------------- one build: core / CRM / features ---------------- */

/** Proportional reservations of one build's budget (FEATURES.md "time budget"). */
export const CORE_SHARE = 0.45;
export const CRM_SHARE = 0.30;
/** Feature steps get at least this when the budget allows (never more than half of a small budget). */
export const FEATURES_MIN_MS = 60000;
/** A feature step gets at least min(this, what is left of the features slot). */
export const STEP_FLOOR_MS = 60000;
/** The CRM pull is skipped (previous CRM reused, marked stale) when less than min(this, its slot) remains. */
export const CRM_MIN_MS = 10000;

/**
 * Split a build budget into the three reservations. The features slot is
 * "the rest" (25 %) but never below FEATURES_MIN_MS while the budget can
 * afford it (capped at half the budget so tiny test budgets still reach the
 * core); core and CRM keep their 3 : 2 ratio inside what remains.
 * Returns { budgetMs, coreMs, crmMs, featuresMs } with coreMs + crmMs +
 * featuresMs === budgetMs.
 */
export function planBudget(budgetMs) {
  const total = Math.max(0, Math.floor(Number(budgetMs) || 0));
  const proportionalRest = total - Math.floor(total * CORE_SHARE) - Math.floor(total * CRM_SHARE);
  const featuresMs = Math.max(proportionalRest, Math.min(FEATURES_MIN_MS, Math.floor(total / 2)));
  const pool = total - featuresMs;
  const coreMs = Math.floor(pool * (CORE_SHARE / (CORE_SHARE + CRM_SHARE)));
  const crmMs = pool - coreMs;
  return { budgetMs: total, coreMs, crmMs, featuresMs };
}

/**
 * A feature step's share of the features slot: its fair share of what is
 * left (left / steps still to run, this one included) raised to the floor
 * (STEP_FLOOR_MS) when the floor fits; the last step gets everything left.
 */
export function stepShareMs(leftMs, remainingSteps) {
  const left = Math.max(0, Math.floor(leftMs));
  const n = Math.max(1, Math.floor(remainingSteps) || 1);
  if (n === 1) return left;
  return Math.min(left, Math.max(Math.floor(left / n), STEP_FLOOR_MS));
}

/** Per-call timeout hints (ms). `slow` is for tools known to take long (the tracking-script check). */
export const TIMEOUTS = Object.freeze({ default: 15000, slow: 45000 });

/** A call is never started with less than this on the clock. */
export const MIN_CALL_MS = 1000;

/** A per-call timeout clamped to what is left before `deadline` (never below MIN_CALL_MS). */
export function clampTimeout(timeoutMs, deadline, fallback = TIMEOUTS.default) {
  const want = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : fallback;
  if (!deadline) return want;
  return Math.min(want, Math.max(MIN_CALL_MS, deadline - Date.now()));
}
