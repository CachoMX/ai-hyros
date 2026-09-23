import { checkAccess, deny } from './_auth.js';
import { listAccounts } from './_accounts.js';
import { readSnapshot, storeConfigured } from './_store.js';
import { RANGES, STALE_AFTER_HOURS, connectionGate, summarizeAccount, currencyTotals } from '../public/features/portfolio/model.js';

const REGISTERED_ID = /^(acc_[0-9a-f]{12}|cli_[0-9a-f]{12})$/;

export function createPortfolioHandler(deps = {}) {
  const accessCheck = deps.checkAccess || checkAccess;
  const list = deps.listAccounts || listAccounts;
  const read = deps.readSnapshot || readSnapshot;
  const configured = deps.storeConfigured || storeConfigured;
  const clock = deps.now || (() => new Date());
  return async function handler(req, res) {
    res.setHeader?.('Cache-Control', 'private, no-store');
    res.setHeader?.('Vary', 'Authorization, x-report-key');
    try {
      const access = await accessCheck(req);
      if (!access.ok) return deny(res, access);
      if (req.method !== 'GET') {
        res.setHeader?.('Allow', 'GET');
        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
      }
      const url = new URL(req.url, 'http://local');
      const range = url.searchParams.get('range') || '30d';
      if (!RANGES.includes(range)) return res.status(400).json({ ok: false, error: 'invalid_range' });
      if (!configured()) return res.status(503).json({ ok: false, error: 'needs_storage' });
      const now = new Date(clock());
      const registry = await list({ withStatus: false });
      if (!Array.isArray(registry)) throw new Error('registry_unavailable');
      const byId = new Map(registry.filter((a) => a && REGISTERED_ID.test(a.id)).map((a) => [a.id, a]));
      const registered = [...byId.values()];
      const accounts = [];
      // Bound concurrent KV reads; only registered and permitted IDs reach the store.
      for (let offset = 0; offset < registered.length; offset += 6) {
        const rows = await Promise.all(registered.slice(offset, offset + 6).map(async (account) => {
          const gate = connectionGate(account, byId);
          if (gate) return summarizeAccount(account, null, { range, now, gate });
          try {
            return summarizeAccount(account, await read(account.id), { range, now });
          } catch {
            return summarizeAccount(account, null, { range, now, gate: { status: 'error', reason: 'snapshot_failed' } });
          }
        }));
        accounts.push(...rows);
      }
      return res.status(200).json({ ok: true, checkedAt: now.toISOString(), range, staleAfterHours: STALE_AFTER_HOURS, accounts, totals: currencyTotals(accounts) });
    } catch {
      return res.status(503).json({ ok: false, error: 'portfolio_unavailable' });
    }
  };
}

export default createPortfolioHandler();
