import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { buildSnapshot, normalizeSettings } from '../api/_snapshot.js';
import { runWithKey, listTools } from '../api/_mcp.js';
import { TEMPLATE_VERSION } from '../api/_version.js';
import { summarizeAccount, currencyTotals } from '../public/features/portfolio/model.js';

// Local-only, memory-only preview. Never imports the production storage writer.
const ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const keyName = process.env.PREVIEW_HYROS_KEY || 'HYROS_API_KEY';
const key = process.env[keyName];
if (!key) throw new Error(`Missing ${keyName}`);
const password = process.env.PREVIEW_PASSWORD || randomBytes(18).toString('hex');
const accountLabel = process.env.PREVIEW_ACCOUNT_LABEL || 'Local account';
const account = { id: 'acc_000000000001', kind: 'key', label: accountLabel, company: accountLabel, status: 'APPROVED', keyStatus: 'ok', lastRefresh: null };
let snapshot = null;
let prefs = null;
let pending = null;
let steps = [];
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2', '.ico':'image/x-icon' };
const json = (res, status, body) => { res.writeHead(status, { 'content-type':'application/json', 'cache-control':'no-store' }); res.end(JSON.stringify(body)); };
async function refresh() {
  if (pending) return pending;
  steps = [];
  pending = runWithKey(key, () => buildSnapshot({ previous: snapshot, prefs, onProgress: step => { steps.push(step); console.log(step); } }))
    .then(value => { snapshot = value; account.lastRefresh = value.generatedAt; return value; })
    .finally(() => { pending = null; });
  return pending;
}
async function body(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 65536) throw new Error('Request too large'); }
  return JSON.parse(data || '{}');
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const signed = req.headers['x-report-key'] === password;
    if (url.pathname === '/api/setup' && req.method === 'GET') return json(res, 200, { ok:true, state:'ready', storage:true, pendingSecrets:false, ...(signed ? { templateVersion:TEMPLATE_VERSION, passwordSource:'env', keySecret:'env', cronSecret:'env', accounts:1, localPreview:true } : {}) });
    if (url.pathname.startsWith('/api/')) {
      if (!signed) return json(res,401,{ok:false,error:'unauthorized'});
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res,403,{ok:false,error:'origin_mismatch'});
      const requested = url.searchParams.get('account');
      if (requested && requested !== account.id) return json(res,404,{ok:false,error:'unknown_account'});
      if (url.pathname === '/api/accounts' && req.method === 'GET') return json(res,200,{ok:true,defaultId:account.id,canAdd:false,accounts:[account]});
      if (url.pathname === '/api/copilot' && req.method === 'GET') return json(res,200,{ok:true,configured:false,engine:'snapshot-rules'});
      if (url.pathname === '/api/data' && req.method === 'GET') return json(res,200,{ok:true,templateVersion:TEMPLATE_VERSION,origin:snapshot ? 'mcp' : 'none',account:account.id,prefs,capabilities:{mcpConfigured:true,storeConfigured:true,localPreview:true},snapshot});
      if (url.pathname === '/api/refresh' && ['GET','POST'].includes(req.method)) {
        const started = Date.now();
        await refresh();
        return json(res,200,{ok:true,account:account.id,persisted:false,localPreview:true,message:'Local snapshot in memory only.',ms:Date.now()-started,generatedAt:snapshot.generatedAt,steps,warnings:snapshot.warnings});
      }
      if (url.pathname === '/api/prefs' && req.method === 'POST') { const data = await body(req); prefs = { cols: data.cols || prefs?.cols, settings: normalizeSettings(data.settings || prefs?.settings) }; return json(res,200,{ok:true,persisted:false,message:'Local preview: preferences kept in memory.',prefs}); }
      if (url.pathname === '/api/portfolio' && req.method === 'GET') { const range = url.searchParams.get('range') || '30d'; const accounts = [summarizeAccount(account,snapshot,{range})]; return json(res,200,{ok:true,range,checkedAt:new Date().toISOString(),accounts,totals:currencyTotals(accounts)}); }
      if (url.pathname === '/api/health' && req.method === 'GET') { const names = await runWithKey(key, () => listTools()); return json(res,200,{ok:true,toolCount:names.length,missingTools:[],hasAttributionTool:names.includes('hyros_get_attribution_report')}); }
      if (url.pathname === '/api/drill') return json(res,200,{ok:false,error:'preview',message:'Record-level drill is disabled in the local read-only preview. Attribution evidence is available in Attribution Lab.'});
      return json(res,405,{ok:false,error:'read_only_preview'});
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res,405,{error:'method_not_allowed'});
    const path = resolve(ROOT, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!path.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return json(res,403,{error:'forbidden'});
    try { const data = await readFile(path); res.writeHead(200,{'content-type':TYPES[extname(path)] || 'application/octet-stream','cache-control':'no-store'}); res.end(req.method === 'HEAD' ? undefined : data); }
    catch { res.writeHead(404); res.end('Not found'); }
  } catch { json(res,503,{ok:false,error:'preview_unavailable',message:'The read-only preview could not complete this request. Check local server diagnostics.'}); }
});
const port = Number(process.env.PORT || 4322);
server.listen(port,'127.0.0.1', () => console.log(`Read-only preview: http://127.0.0.1:${port} (key variable: ${keyName}; access password ${process.env.PREVIEW_PASSWORD ? 'configured' : password})`));
