import { storeConfigured, kvRaw } from './_store.js';
import {
  WebhookError, readWebhookConfig, readRawWebhookBody, parseWebhookBody,
  verifyWebhookSignature, validateWebhookEvent, acceptWebhookEvent,
} from './_webhook.js';

export const config = { api: { bodyParser: false } };

export function createWebhookHandler({
  configuration = () => process.env.HYROS_WEBHOOK_ACCOUNTS,
  storageConfigured = storeConfigured,
  kv = kvRaw,
  now = Date.now,
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }
    try {
      const subscriptions = readWebhookConfig(configuration());
      if (!storageConfigured()) {
        throw new WebhookError(503, 'webhook_storage_unconfigured', 'Configure writable KV storage before enabling webhooks.');
      }
      const contentType = req.headers?.['content-type'];
      const encoding = req.headers?.['content-encoding'];
      if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?\s*)?$/i.test(contentType)
        || (encoding !== undefined && encoding !== 'identity')) {
        throw new WebhookError(415, 'unsupported_media_type', 'Send uncompressed application/json encoded as UTF-8.');
      }
      const rawBody = await readRawWebhookBody(req);
      const payload = parseWebhookBody(rawBody);
      const subscription = subscriptions.get(payload.subscriptionId);
      if (!subscription || !verifyWebhookSignature(rawBody, req.headers['x-hyros-signature'], subscription.secretKey, now())) {
        throw new WebhookError(401, 'invalid_signature', 'Invalid or expired HYROS webhook signature.');
      }
      validateWebhookEvent(payload);
      const { duplicate } = await acceptWebhookEvent(subscription.accountId, payload, { kv });
      return res.status(200).json({ ok: true, duplicate });
    } catch (error) {
      const known = error instanceof WebhookError;
      const status = known ? error.status : 503;
      if (status === 503) res.setHeader('Retry-After', '60');
      if (status === 413 || status === 408) res.setHeader('Connection', 'close');
      return res.status(status).json({
        ok: false,
        error: known ? error.code : 'webhook_unavailable',
        message: known ? error.message : 'Webhook ingestion is temporarily unavailable; retry delivery.',
      });
    }
  };
}

export default createWebhookHandler();
