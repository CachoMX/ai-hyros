const LIMIT = 400;
const validId = (value) => typeof value === 'string' && /^alert-[0-9a-f]{8}$/.test(value);
const validToken = (value) => typeof value === 'string' && /^read-[0-9a-f]{8}$/.test(value);
const keyFor = (account, demo) => demo ? 'hyros:brief:read:demo' : typeof account === 'string' && account ? 'hyros:brief:read:account-' + encodeURIComponent(account) : null;
const defaultStorage = () => { try { return globalThis.window?.localStorage || null; } catch { return null; } };

export function loadReadState(account, demo = false, storage = defaultStorage()) {
  const key = keyFor(account, demo);
  if (!key || !storage?.getItem) return {};
  try {
    const value = JSON.parse(storage.getItem(key) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, token]) => validId(id) && validToken(token)).slice(-LIMIT));
  } catch { return {}; }
}

export const isRead = (alert, state) => Boolean(alert?.readToken) && state?.[alert.id] === alert.readToken;

export function setReadState(account, demo, alert, read, storage = defaultStorage()) {
  const key = keyFor(account, demo);
  if (!key || !validId(alert?.id) || !validToken(alert?.readToken) || !storage?.setItem) return false;
  try {
    const state = loadReadState(account, demo, storage);
    delete state[alert.id];
    if (read) state[alert.id] = alert.readToken;
    storage.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(state).slice(-LIMIT))));
    return true;
  } catch { return false; }
}

export function filterAlerts(alerts, readState, { severity = 'all', status = 'all' } = {}) {
  return (Array.isArray(alerts) ? alerts : []).filter((alert) => alert &&
    (severity === 'all' || alert.severity === severity) &&
    (status === 'all' || (status === 'read' ? isRead(alert, readState) : !isRead(alert, readState))));
}
