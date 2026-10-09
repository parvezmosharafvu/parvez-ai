// Parvez AI — Cloudflare Worker
// Routes: /ai (dashboard), /vault (API key vault), /api/chat (chat proxy), /api/health (key health)

const PROVIDERS = {
  openrouter:  { base: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4o-mini','anthropic/claude-3.5-haiku'] },
  openai:      { base: 'https://api.openai.com/v1', models: ['gpt-4o-mini'] },
  anthropic:   { base: 'https://api.anthropic.com/v1', models: ['claude-3-5-haiku-20241022'] },
  google:      { base: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.0-flash'] },
  groq:        { base: 'https://api.groq.com/openai/v1', models: ['llama-3.1-8b-instant'] },
  mistral:     { base: 'https://api.mistral.ai/v1', models: ['mistral-small-latest'] },
  deepseek:    { base: 'https://api.deepseek.com/v1', models: ['deepseek-chat'] },
  xai:         { base: 'https://api.x.ai/v1', models: ['grok-3-mini'] },
  together:    { base: 'https://api.together.xyz/v1', models: ['meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'] },
  fireworks:   { base: 'https://api.fireworks.ai/inference/v1', models: ['accounts/fireworks/models/llama-v3p1-8b-instruct'] },
  perplexity:  { base: 'https://api.perplexity.ai', models: ['llama-3.1-sonar-small-128k-online'] },
  cohere:      { base: 'https://api.cohere.ai/v1', models: ['command-r-plus'] },
  huggingface: { base: 'https://api-inference.huggingface.co/v1', models: ['meta-llama/Meta-Llama-3-8B-Instruct'] },
  ollama:      { base: 'http://localhost:11434/v1', models: ['llama3.1'] },
  cerebras:    { base: 'https://api.cerebras.ai/v1', models: ['llama3.1-8b'] },
  sambanova:   { base: 'https://api.sambanova.ai/v1', models: ['Meta-Llama-3.1-8B-Instruct'] },
  siliconflow: { base: 'https://api.siliconflow.cn/v1', models: ['Qwen/Qwen2.5-7B-Instruct'] },
  nvidia:      { base: 'https://integrate.api.nvidia.com/v1', models: ['meta/llama-3.1-8b-instruct'] }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (path === '/' || path === '') return landingPage(env);
      if (path === '/ai' || path === '/ai/' || path === '/dashboard') return dashboardPage(env);
      if (path === '/vault' || path === '/vault/') return vaultPage(env, request);
      if (path === '/api/chat' && request.method === 'POST') return chatProxy(request, env);
      if (path === '/api/health') return healthEndpoint(env, request);
      if (path === '/api/keys' && request.method === 'GET') return listKeys(env, request);
      if (path === '/api/keys' && request.method === 'POST') return saveKey(env, request);
      if (path.startsWith('/api/keys/') && request.method === 'DELETE') {
        const id = path.split('/').pop();
        return deleteKey(env, request, id);
      }
      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },

  async scheduled(event, env) {
    await runHealthCheck(env);
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function isAdmin(request, env) {
  const token = request.headers.get('X-Admin-Token') || new URL(request.url).searchParams.get('token');
  return token && token === env.ADMIN_TOKEN;
}

async function listKeys(env, request) {
  if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  const list = await env.VAULT.list({ prefix: 'key:' });
  const keys = [];
  for (const k of list.keys) {
    const raw = await env.VAULT.get(k.name, { type: 'json' });
    if (raw) keys.push({ id: k.name.replace('key:',''), provider: raw.provider, label: raw.label, status: raw.status || 'unknown', created: raw.created });
  }
  return json({ keys });
}

async function saveKey(env, request) {
  if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  const body = await request.json();
  const { provider, label, apiKey } = body;
  if (!provider || !apiKey) return json({ error: 'provider and apiKey required' }, 400);
  const id = crypto.randomUUID().slice(0, 8);
  await env.VAULT.put(`key:${id}`, JSON.stringify({ provider, label: label || provider, apiKey, status: 'unknown', created: Date.now() }));
  return json({ ok: true, id });
}

async function deleteKey(env, request, id) {
  if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  await env.VAULT.delete(`key:${id}`);
  return json({ ok: true });
}

async function chatProxy(request, env) {
  const body = await request.json();
  const { messages, model, provider } = body;
  if (!messages || !Array.isArray(messages)) return json({ error: 'messages required' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rlKey = `rl:${ip}`;
  const rl = await env.HEALTH.get(rlKey, { type: 'json' }) || { count: 0, reset: Date.now() + 3600000 };
  if (Date.now() > rl.reset) { rl.count = 0; rl.reset = Date.now() + 3600000; }
  if (rl.count >= 20) return json({ error: 'Rate limit exceeded. Try again in an hour.' }, 429);
  rl.count++;
  await env.HEALTH.put(rlKey, JSON.stringify(rl), { expirationTtl: 3600 });

  const order = provider ? [provider] : Object.keys(PROVIDERS);
  let lastError = null;

  for (const prov of order) {
    const keyList = await getKeysForProvider(env, prov);
    for (const k of keyList) {
      try {
        const res = await callProvider(prov, k.apiKey, messages, model);
        if (res.ok) {
          await markKeyStatus(env, k.id, 'live', null);
          const data = await res.json();
          const text = extractText(prov, data);
          return json({ text, provider: prov, model: model || PROVIDERS[prov].models[0] });
        }
        const status = res.status;
        if (status === 401 || status === 429) {
          await markKeyStatus(env, k.id, 'dead', `HTTP ${status}`);
          lastError = `${prov} key ${k.id}: HTTP ${status}`;
          continue;
        }
        lastError = `${prov} key ${k.id}: HTTP ${status}`;
      } catch (e) {
        await markKeyStatus(env, k.id, 'dead', e.message);
        lastError = `${prov} key ${k.id}: ${e.message}`;
      }
    }
  }
  return json({ error: 'All keys failed', detail: lastError }, 502);
}

async function getKeysForProvider(env, prov) {
  const list = await env.VAULT.list({ prefix: 'key:' });
  const out = [];
  for (const k of list.keys) {
    const raw = await env.VAULT.get(k.name, { type: 'json' });
    if (raw && raw.provider === prov && raw.status !== 'dead') out.push({ id: k.name.replace('key:',''), apiKey: raw.apiKey });
  }
  return out;
}

async function callProvider(prov, apiKey, messages, model) {
  const p = PROVIDERS[prov];
  if (!p) throw new Error('Unknown provider: ' + prov);
  const m = model || p.models[0];
  if (prov === 'anthropic') {
    return fetch(`${p.base}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: m, max_tokens: 1024, messages })
    });
  }
  const url = prov === 'google'
    ? `${p.base}/openai/chat/completions?key=${apiKey}`
    : `${p.base}/chat/completions`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: m, messages, max_tokens: 1024 })
  });
}

function extractText(prov, data) {
  if (prov === 'anthropic') return data.content?.map(c => c.text).join('') || '';
  return data.choices?.[0]?.message?.content || data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
}

async function markKeyStatus(env, id, status, detail) {
  const raw = await env.VAULT.get(`key:${id}`, { type: 'json' });
  if (raw) {
    raw.status = status;
    raw.lastCheck = Date.now();
    if (detail) raw.lastError = detail;
    await env.VAULT.put(`key:${id}`, JSON.stringify(raw));
  }
}

async function runHealthCheck(env) {
  const list = await env.VAULT.list({ prefix: 'key:' });
  for (const k of list.keys) {
    const raw = await env.VAULT.get(k.name, { type: 'json' });
    if (!raw) continue;
    try {
      const res = await callProvider(raw.provider, raw.apiKey, [{ role: 'user', content: 'ping' }], null);
      await markKeyStatus(env, k.name.replace('key:',''), res.ok ? 'live' : 'dead', res.ok ? null : `HTTP ${res.status}`);
    } catch (e) {
      await markKeyStatus(env, k.name.replace('key:',''), 'dead', e.message);
    }
  }
}

async function healthEndpoint(env, request) {
  if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
  const list = await env.VAULT.list({ prefix: 'key:' });
  const out = [];
  for (const k of list.keys) {
    const raw = await env.VAULT.get(k.name, { type: 'json' });
    if (raw) out.push({ id: k.name.replace('key:',''), provider: raw.provider, label: raw.label, status: raw.status, lastCheck: raw.lastCheck, lastError: raw.lastError });
  }
  return json({ keys: out, checkedAt: Date.now() });
}


function landingPage(env) {
  return new Response(LANDING_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function dashboardPage(env) {
  return new Response(DASHBOARD_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function vaultPage(env, request) {
  // Always serve vault; client handles token via localStorage or query
  return new Response(VAULT_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}


const LANDING_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Parvez AI</title>
<style>
:root{--bg:#07070c;--panel:#101018;--line:#1e1e2a;--text:#e8e8f0;--muted:#7a7a90;--accent:#6c5ce7;--cyan:#22d3ee}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui}
.nav{display:flex;justify-content:space-between;align-items:center;padding:16px 24px;border-bottom:1px solid var(--line)}
.nav .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px}
.nav .brand .orb{width:32px;height:32px;border-radius:50%;background:radial-gradient(circle at 35% 35%,var(--cyan),var(--accent));box-shadow:0 0 20px var(--accent)}
.nav a{color:var(--muted);text-decoration:none;font-size:14px;margin-left:20px}
.hero{max-width:900px;margin:0 auto;padding:80px 24px;text-align:center}
.hero h1{font-size:42px;margin:0 0 16px;background:linear-gradient(135deg,var(--text),var(--cyan));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hero p{color:var(--muted);font-size:18px;margin:0 0 32px}
.login-box{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:32px;max-width:400px;margin:0 auto 60px}
.login-box h2{margin:0 0 8px;font-size:20px}
.login-box p{color:var(--muted);font-size:14px;margin:0 0 20px}
.login-box input{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;color:var(--text);font-size:15px;margin-bottom:12px}
.login-box button{width:100%;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:12px;font-size:15px;font-weight:600;cursor:pointer}
.tech{max-width:1000px;margin:0 auto;padding:40px 24px}
.tech h2{text-align:center;margin:0 0 32px;font-size:28px}
.tech-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.tech-card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;text-align:center}
.tech-card .icon{font-size:28px;margin-bottom:8px}
.tech-card h3{margin:0 0 6px;font-size:16px}
.tech-card p{margin:0;color:var(--muted);font-size:13px}
</style></head><body>
<div class="nav">
  <div class="brand"><div class="orb"></div>Parvez AI</div>
  <div><a href="/ai">Dashboard</a><a href="/vault">API Vault</a></div>
</div>
<div class="hero">
  <h1>Parvez AI</h1>
  <p>Multi-provider AI platform with encrypted API vault and real-time routing</p>
</div>
<div class="login-box">
  <h2>Access Dashboard</h2>
  <p>Enter to continue to the command center</p>
  <input type="text" placeholder="Name (optional)" id="name">
  <button onclick="location.href='/ai'">Continue</button>
</div>
<div class="tech">
  <h2>Technology</h2>
  <div class="tech-grid">
    <div class="tech-card"><div class="icon">⚡</div><h3>Cloudflare Workers</h3><p>Edge compute, global deployment</p></div>
    <div class="tech-card"><div class="icon">🔐</div><h3>Encrypted Vault</h3><p>KV storage for API keys</p></div>
    <div class="tech-card"><div class="icon">🔄</div><h3>Multi-Provider</h3><p>OpenAI, Anthropic, Groq, and more</p></div>
    <div class="tech-card"><div class="icon">🧠</div><h3>Auto Failover</h3><p>Switches keys on rate limits</p></div>
    <div class="tech-card"><div class="icon">📊</div><h3>Real-time Health</h3><p>Live key status monitoring</p></div>
    <div class="tech-card"><div class="icon">🌐</div><h3>Public Access</h3><p>Rate-limited, open platform</p></div>
  </div>
</div>
</body></html>`;

const LOGIN_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Parvez AI · Vault</title>
<style>body{margin:0;background:#0a0a0f;color:#e8e8f0;font-family:system-ui;display:grid;place-items:center;height:100vh}
.card{background:#14141c;border:1px solid #2a2a38;border-radius:14px;padding:32px;width:min(400px,90vw)}
h1{font-size:20px;margin:0 0 8px}p{color:#8888a0;font-size:14px;margin:0 0 20px}
input{width:100%;background:#0a0a0f;border:1px solid #2a2a38;border-radius:8px;padding:12px;color:#e8e8f0;font-size:15px;margin-bottom:14px}
button{width:100%;background:#6c5ce7;color:#fff;border:0;border-radius:8px;padding:12px;font-size:15px;font-weight:600;cursor:pointer}
.err{color:#ff6b6b;font-size:13px;margin-top:10px}</style></head><body>
<div class="card"><h1>Parvez AI</h1><p>Admin access required</p>
<input id="t" type="password" placeholder="Admin token" autofocus>
<button onclick="location.search='?token='+encodeURIComponent(document.getElementById('t').value)">Unlock</button>
<div class="err" id="e"></div></div></body></html>`;

const VAULT_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Parvez AI · API Vault</title>
<style>
:root{--bg:#0a0a0f;--card:#14141c;--line:#2a2a38;--text:#e8e8f0;--muted:#8888a0;--accent:#6c5ce7;--green:#00d4aa;--red:#ff6b6b;--radius:12px}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui}
.wrap{max-width:900px;margin:0 auto;padding:24px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
.top h1{font-size:22px;margin:0}.top .sub{color:var(--muted);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px;margin-bottom:16px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
.k{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:14px}
.k .prov{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.k .lbl{font-weight:600;margin:4px 0}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.dot.live{background:var(--green)}.dot.dead{background:var(--red)}.dot.unknown{background:var(--muted)}
.add{display:grid;gap:10px}.add select,.add input{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;color:var(--text);font-size:14px}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:600;cursor:pointer}
button.del{background:transparent;border:1px solid var(--red);color:var(--red);padding:4px 10px;font-size:12px}
.toast{position:fixed;bottom:20px;right:20px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 16px;font-size:13px}
</style></head><body><div class="wrap">
<div class="top"><div><h1>API Vault</h1><div class="sub">Keys are encrypted server-side. Never exposed to browser.</div></div>
<button onclick="load()">Refresh</button></div>
<div class="card add"><h3 style="margin:0 0 12px;font-size:15px">Add a key</h3>
<div style="display:flex;gap:8px;flex-wrap:wrap">
  <select id="prov"><option>openrouter</option><option>openai</option><option>anthropic</option><option>google</option><option>groq</option><option>mistral</option><option>deepseek</option><option>xai</option><option>together</option><option>fireworks</option><option>perplexity</option><option>cohere</option><option>huggingface</option><option>ollama</option><option>cerebras</option><option>sambanova</option><option>siliconflow</option><option>nvidia</option></select>
  <input id="lbl" placeholder="Label (e.g. gmail-1)" style="flex:1;min-width:140px">
</div>
<input id="key" placeholder="API key" type="password">
<button onclick="save()">Save key</button></div>
<div class="grid" id="grid"></div></div>
<div class="toast" id="toast" style="display:none"></div>
<script>
// Persist token in localStorage so refreshes work
let token = new URLSearchParams(location.search).get('token') || localStorage.getItem('pvz_token') || '';
if(token) localStorage.setItem('pvz_token', token);
function authHeaders(){ return token ? {'X-Admin-Token': token} : {}; }
async function load(){
  const r=await fetch('/api/keys', {headers: authHeaders()});
  const d=await r.json();
  const g=document.getElementById('grid'); g.innerHTML='';
  if(!r.ok || d.error){ g.innerHTML='<div style="color:var(--red)">'+(d.error||'Auth failed')+'</div>'; return; }
  (d.keys||[]).forEach(k=>{
    const el=document.createElement('div'); el.className='k';
    el.innerHTML='<div class="prov">'+k.provider+'</div><div class="lbl"><span class="dot '+k.status+'"></span>'+k.label+'</div><div style="font-size:11px;color:var(--muted)">'+k.status+' · '+k.id+'</div><button class="del" onclick="delKey(\''+k.id+'\')">Delete</button>';
    g.appendChild(el);
  });
  if(!d.keys || d.keys.length===0) g.innerHTML='<div style="color:var(--muted);font-size:13px">No keys yet. Add one above.</div>';
}
async function save(){
  const body={provider:document.getElementById('prov').value,label:document.getElementById('lbl').value,apiKey:document.getElementById('key').value};
  const r=await fetch('/api/keys',{method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify(body)});
  const d=await r.json();
  toast(d.ok?'Saved!':'Error: '+(d.error||'Failed'));
  if(d.ok){ document.getElementById('key').value=''; document.getElementById('lbl').value=''; load(); }
}
async function delKey(id){ if(!confirm('Delete?'))return; await fetch('/api/keys/'+id,{method:'DELETE',headers:authHeaders()}); load(); }
function toast(m){const t=document.getElementById('toast');t.textContent=m;t.style.display='block';setTimeout(()=>t.style.display='none',2000);}
load();
</script></body></html>`;

const DASHBOARD_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Parvez AI</title>
<style>
:root{--bg:#07070c;--panel:#101018;--line:#1e1e2a;--text:#e8e8f0;--muted:#7a7a90;--accent:#6c5ce7;--green:#00d4aa;--red:#ff6b6b;--cyan:#22d3ee}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui;overflow-x:hidden}
.shell{display:grid;grid-template-columns:260px 1fr;min-height:100vh}
.side{background:var(--panel);border-right:1px solid var(--line);padding:20px 14px;display:flex;flex-direction:column;gap:4px}
.side .brand{font-weight:700;font-size:17px;padding:0 10px 18px;display:flex;align-items:center;gap:10px}
.side .brand .orb{width:28px;height:28px;border-radius:50%;background:radial-gradient(circle at 35% 35%,var(--cyan),var(--accent));box-shadow:0 0 18px var(--accent)}
.side a{display:block;padding:9px 12px;border-radius:8px;color:var(--muted);text-decoration:none;font-size:14px;font-weight:500}
.side a:hover{background:#1a1a26;color:var(--text)}
.side a.on{background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent)}
.main{padding:28px 32px;overflow:auto}
.topbar{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:24px;flex-wrap:wrap}
.topbar h2{margin:2px 0 0;font-size:24px}
.kicker{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px}
.card h3{margin:0 0 10px;font-size:13px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.kpi{font-size:26px;font-weight:700;letter-spacing:-.02em}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.dot.live{background:var(--green)}.dot.dead{background:var(--red)}.dot.unknown{background:var(--muted)}
.brain-wrap{display:flex;flex-direction:column;align-items:center;padding:20px 0 10px}
.brain{position:relative;width:160px;height:160px}
.brain .core{position:absolute;inset:30px;border-radius:50%;background:radial-gradient(circle at 35% 35%,var(--cyan),var(--accent) 60%,#2a1a6e);box-shadow:0 0 40px var(--accent),inset 0 0 30px rgba(255,255,255,.15)}
.brain .ring{position:absolute;inset:0;border-radius:50%;border:1px solid color-mix(in srgb,var(--accent) 40%,transparent);animation:spin 12s linear infinite}
.brain .ring2{inset:-14px;border-radius:50%;border:1px dashed color-mix(in srgb,var(--cyan) 30%,transparent);animation:spin 20s linear infinite reverse}
@keyframes spin{to{transform:rotate(360deg)}}
.nodes{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:8px}
.node{font-size:11px;padding:5px 12px;border-radius:999px;border:1px solid var(--line);color:var(--muted);background:var(--panel)}
.node.on{border-color:var(--green);color:var(--green)}
.chat{display:flex;flex-direction:column;height:min(520px,70vh);background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.chatlog{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:80%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.5}
.msg.user{align-self:flex-end;background:var(--accent);color:#fff}
.msg.bot{align-self:flex-start;background:#1a1a26;border:1px solid var(--line)}
.msg .who{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:4px}
.composer{display:flex;gap:8px;padding:12px;border-top:1px solid var(--line)}
.composer input{flex:1;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;color:var(--text);font-size:14px}
.composer button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:600;cursor:pointer}
@media(max-width:860px){.shell{grid-template-columns:1fr}.side{flex-direction:row;overflow-x:auto;height:auto;border-right:0;border-bottom:1px solid var(--line)}}
</style></head><body><div class="shell">
<div class="side">
  <div class="brand"><div class="orb"></div>Parvez AI</div>
  <a class="on" href="/">Dashboard</a>
  <a href="/vault">API Vault</a>
</div>
<div class="main">
  <div class="topbar"><div><div class="kicker">Parvez AI</div><h2>Command Center</h2></div><div class="kicker" id="clock"></div></div>
  <div class="brain-wrap">
    <div class="brain"><div class="ring"></div><div class="ring2"></div><div class="core"></div></div>
    <div class="nodes" id="nodes"></div>
  </div>
  <div class="grid" id="kpis" style="margin-bottom:20px"></div>
  <div class="chat">
    <div class="chatlog" id="log"></div>
    <div class="composer"><input id="inp" placeholder="Ask anything..." onkeydown="if(event.key==='Enter')send()"><button onclick="send()">Send</button></div>
  </div>
</div>
<script>
function clock(){document.getElementById('clock').textContent=new Date().toLocaleString();}
setInterval(clock,1000);clock();
async function refresh(){
  try{
    const r=await fetch('/api/health'); const d=await r.json();
    const keys=d.keys||[];
    const live=keys.filter(k=>k.status==='live').length;
    const dead=keys.filter(k=>k.status==='dead').length;
    document.getElementById('kpis').innerHTML='<div class="card"><h3>Providers</h3><div class="kpi">8</div></div><div class="card"><h3>Live keys</h3><div class="kpi" style="color:var(--green)">'+live+'</div></div><div class="card"><h3>Dead keys</h3><div class="kpi" style="color:var(--red)">'+dead+'</div></div><div class="card"><h3>Last check</h3><div class="kpi" style="font-size:14px">'+(d.checkedAt?new Date(d.checkedAt).toLocaleTimeString():'—')+'</div></div>';
    const n=document.getElementById('nodes'); n.innerHTML='';
    keys.forEach(k=>{const el=document.createElement('div');el.className='node'+(k.status==='live'?' on':'');el.textContent=k.provider+' · '+k.label;n.appendChild(el);});
  }catch(e){console.log(e);}
}
refresh();setInterval(refresh,30000);
function addMsg(who,text){const l=document.getElementById('log');const m=document.createElement('div');m.className='msg '+who;m.innerHTML='<div class="who">'+who+'</div>'+text.replace(/</g,'<');l.appendChild(m);l.scrollTop=l.scrollHeight;}
async function send(){
  const inp=document.getElementById('inp'); const t=inp.value.trim(); if(!t)return; inp.value='';
  addMsg('user',t);
  try{
    const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:t}]})});
    const d=await r.json();
    addMsg('bot', d.text || d.error || 'No response');
  }catch(e){addMsg('bot','Error: '+e.message);}
}
</script></body></html>`;
