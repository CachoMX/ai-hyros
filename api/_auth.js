import { timingSafeEqual, createHash } from 'node:crypto';
import { getConfig, cachedConfig, verifyPassword } from './_setup.js';

/** Constant-time compare that tolerates length mismatch. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still burn a comparison so timing does not leak length.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Has the dashboard been set up (password created on first load, stored in KV)? */
export function passwordConfigured(cfg = cachedConfig()) {
  return Boolean(cfg?.passwordHash);
}

/* scrypt costs ~50ms; remember candidates that verified against the current hash. */
const verified = new Map(); // sha256(candidate) -> passwordHash it matched
function remembered(candidate, hash) { return verified.get(createHash('sha256').update(candidate).digest('hex')) === hash; }
function remember(candidate, hash) { if (verified.size > 50) verified.clear(); verified.set(createHash('sha256').update(candidate).digest('hex'), hash); }

/**
 * Accept ?key=, x-report-key header, or Bearer token, against the KV-stored
 * hash — or REPORT_PASSWORD from the env, which acts as an optional MASTER
 * password (recovery if someone else grabbed the first-run screen). Until a
 * password is set the app is in setup mode: every data route is refused
 * (`setup: true`).
 */
export async function checkAccess(req) {
  const cfg = await getConfig();
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
  const auth = req.headers.authorization || '';
  const candidates = [
    url.searchParams.get('key'),
    req.headers['x-report-key'],
    auth.startsWith('Bearer ') ? auth.slice(7) : null,
  ].filter(Boolean);

  if (!passwordConfigured(cfg)) return { ok: false, setup: true };
  for (const c of candidates) {
    if (process.env.REPORT_PASSWORD && safeEqual(c, process.env.REPORT_PASSWORD)) return { ok: true, source: 'env' };
    if (cfg?.passwordHash) {
      if (remembered(c, cfg.passwordHash)) return { ok: true, source: 'kv' };
      if (verifyPassword(c, cfg.passwordHash)) { remember(c, cfg.passwordHash); return { ok: true, source: 'kv' }; }
    }
  }
  return { ok: false };
}

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when that env var
 * exists. Until the user pastes the generated secret into Vercel there is no
 * header at all, so the scheduler is recognised by its user agent instead —
 * a spoofable signal whose only power is "run the daily refresh", which
 * /api/refresh additionally rate-limits with a KV lock in that mode.
 */
export function isCron(req) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (secret) return auth.startsWith('Bearer ') && safeEqual(auth.slice(7), secret);
  return String(req.headers['user-agent'] || '').startsWith('vercel-cron/');
}

export function deny(res, access = {}) {
  res.status(401).json({ ok: false, error: access.setup ? 'setup_required' : 'unauthorized' });
}
