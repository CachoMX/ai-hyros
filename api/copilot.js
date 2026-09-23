import { checkAccess, deny } from './_auth.js';
import { accountFromReq } from './_accounts.js';
import { readSnapshot, storeConfigured, kvRaw } from './_store.js';
import { COPILOT_LIMITS, COPILOT_RANGES, providerConfiguration, providerEvidence, rulesAnswer, reserveProviderCall, generateAnswer } from './_copilot.js';

const ACCOUNT_ID = /^(acc_[0-9a-f]{12}|cli_[0-9a-f]{12})$/;
export const config = { api: { bodyParser: { sizeLimit: '12kb' } } };

export function createCopilotHandler(deps = {}) {
  const accessCheck = deps.checkAccess || checkAccess;
  const accountFor = deps.accountFromReq || accountFromReq;
  const read = deps.readSnapshot || readSnapshot;
  const configuredStore = deps.storeConfigured || storeConfigured;
  const kv = deps.kvRaw || kvRaw;
  const clock = deps.now || Date.now;
  return async function handler(req, res) {
    res.setHeader?.('Cache-Control', 'private, no-store');
    res.setHeader?.('Vary', 'Authorization, x-report-key');
    try {
      const access = await accessCheck(req);
      if (!access?.ok) return deny(res, access || {});
      if (!['GET', 'POST'].includes(req.method)) {
        res.setHeader?.('Allow', 'GET, POST');
        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
      }
      const provider = providerConfiguration(deps.env || process.env);
      if (req.method === 'GET') return res.status(200).json({ ok: true, configured: provider.configured, provider: provider.provider });
      const declaredSize = Number(req.headers?.['content-length']);
      if (declaredSize > COPILOT_LIMITS.requestBytes) return res.status(413).json({ ok: false, error: 'body_too_large' });
      let body = req.body;
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        if (Buffer.byteLength(body) > COPILOT_LIMITS.requestBytes) return res.status(413).json({ ok: false, error: 'body_too_large' });
        try { body = JSON.parse(body.toString()); } catch { return res.status(400).json({ ok: false, error: 'invalid_body' }); }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some((key) => !['question', 'range', 'useProvider'].includes(key))) return res.status(400).json({ ok: false, error: 'invalid_body' });
      if (Buffer.byteLength(JSON.stringify(body)) > COPILOT_LIMITS.requestBytes) return res.status(413).json({ ok: false, error: 'body_too_large' });
      if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > COPILOT_LIMITS.question
        || (body.useProvider !== undefined && typeof body.useProvider !== 'boolean')) return res.status(400).json({ ok: false, error: 'invalid_question' });
      if (!COPILOT_RANGES.includes(body.range)) return res.status(400).json({ ok: false, error: 'invalid_range' });
      const requested = new URL(req.url, 'http://local').searchParams.get('account');
      if (requested && !ACCOUNT_ID.test(requested)) return res.status(400).json({ ok: false, error: 'invalid_account' });
      const account = await accountFor(req);
      if (!account || !ACCOUNT_ID.test(account)) return res.status(404).json({ ok: false, error: 'account_unavailable' });
      const snapshot = await read(account);
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return res.status(404).json({ ok: false, error: 'snapshot_unavailable' });
      const evidence = providerEvidence(snapshot, body.range);
      const question = body.question.trim();
      const reply = (result) => res.status(200).json({ ok: true, ...result, account, range: body.range, generatedAt: evidence.brief.generatedAt });
      if (body.useProvider !== true) return reply(rulesAnswer(question, evidence, 'not_opted_in'));
      if (!provider.configured) return reply(rulesAnswer(question, evidence, 'provider_disabled'));
      if (configuredStore()) {
        const reason = await reserveProviderCall(account, { kvRaw: kv, now: clock, timeoutMs: deps.guardTimeoutMs });
        if (reason) return reply(rulesAnswer(question, evidence, reason));
      }
      return reply(await generateAnswer(provider, question, evidence, { fetch: deps.fetch, timeoutMs: deps.timeoutMs }));
    } catch {
      return res.status(503).json({ ok: false, error: 'copilot_unavailable' });
    }
  };
}

export default createCopilotHandler();
