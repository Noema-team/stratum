// Attention-first dashboard — self-contained HTML/CSS/JS SPA.
// Served by ControlPlaneServer at GET / and GET /dashboard.
// Communicates with the control-plane API using a Bearer token stored in localStorage.

export function dashboardHtml(baseApiPath = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stratum</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f1117;--surface:#1a1d27;--border:#2a2d3a;
  --text:#e2e4ed;--muted:#7b7f93;--accent:#6c7cff;
  --green:#34c77b;--yellow:#f5a623;--red:#e05c5c;--blue:#4ab0f5;
  --urgent:#f5a623;--blocking:#e05c5c;--normal:#7b7f93;
}
body{background:var(--bg);color:var(--text);font:14px/1.5 system-ui,sans-serif;min-height:100vh}
a{color:var(--accent);text-decoration:none}

/* Layout */
#app{display:flex;flex-direction:column;height:100vh}
#header{display:flex;align-items:center;gap:12px;padding:0 20px;height:52px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0}
#logo{font-weight:700;font-size:16px;letter-spacing:.04em}
#needs-badge{background:var(--red);color:#fff;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:700;display:none}
#nav{display:flex;gap:4px;margin-left:auto}
.nav-btn{background:none;border:none;color:var(--muted);padding:5px 12px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500}
.nav-btn.active,.nav-btn:hover{background:var(--border);color:var(--text)}
#content{flex:1;overflow-y:auto;padding:24px 20px}

/* Auth overlay */
#auth-overlay{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:100}
#auth-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;width:360px}
#auth-card h2{font-size:20px;margin-bottom:8px}
#auth-card p{color:var(--muted);margin-bottom:20px;font-size:13px}
#auth-card input{width:100%;background:#0f1117;border:1px solid var(--border);color:var(--text);padding:9px 12px;border-radius:7px;font:14px/1 system-ui;margin-bottom:12px}
#auth-card input:focus{outline:none;border-color:var(--accent)}
#auth-err{color:var(--red);font-size:12px;margin-bottom:10px;display:none}
.btn{background:var(--accent);color:#fff;border:none;padding:9px 18px;border-radius:7px;cursor:pointer;font:13px/1 system-ui;font-weight:600}
.btn:hover{opacity:.88}
.btn-sm{padding:5px 12px;font-size:12px;border-radius:5px}
.btn-ghost{background:var(--border);color:var(--text)}
.btn-danger{background:var(--red)}
.btn-success{background:var(--green)}

/* Cards */
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:12px}
.card-title{font-weight:600;font-size:15px;margin-bottom:4px}
.card-sub{color:var(--muted);font-size:12px;margin-bottom:10px}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.tag-blocking{background:#3a1a1a;color:var(--red)}
.tag-urgent{background:#3a2a0a;color:var(--yellow)}
.tag-normal{background:#1e2030;color:var(--muted)}
.tag-state{background:#1e2030;color:var(--muted)}
.tag-ready{background:#0a2a1a;color:var(--green)}
.tag-running{background:#0a1e3a;color:var(--blue)}
.tag-failed{background:#3a1a1a;color:var(--red)}
.tag-blocked{background:#3a2a0a;color:var(--yellow)}
.tag-completed{background:#0a2a1a;color:var(--green)}
.tag-cancelled{background:#1e2030;color:var(--muted)}

.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.flex1{flex:1}
.actions{display:flex;gap:6px;margin-top:10px}

/* List */
.section-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:12px}
.empty{color:var(--muted);font-size:13px;padding:24px 0;text-align:center}

/* Evidence */
.evidence-item{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px}
.evidence-item:last-child{border-bottom:none}
.ev-pass{color:var(--green)}
.ev-fail{color:var(--red)}
.ev-pending{color:var(--muted)}

/* Event log */
.event-row{display:flex;gap:12px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;align-items:baseline}
.event-row:last-child{border-bottom:none}
.event-time{color:var(--muted);white-space:nowrap;flex-shrink:0}
.event-type{color:var(--accent);flex-shrink:0}

/* Project stats */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:12px}
.stat{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center}
.stat-n{font-size:28px;font-weight:700;line-height:1}
.stat-l{font-size:11px;color:var(--muted);margin-top:4px}

/* Spinner */
.spin{display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* Toast */
#toast{position:fixed;bottom:20px;right:20px;background:#23253a;border:1px solid var(--border);border-radius:8px;padding:10px 16px;font-size:13px;display:none;z-index:200}
#toast.err{border-color:var(--red);color:var(--red)}
#toast.ok{border-color:var(--green);color:var(--green)}

/* Work detail drawer */
#drawer{position:fixed;right:0;top:0;bottom:0;width:420px;background:var(--surface);border-left:1px solid var(--border);transform:translateX(100%);transition:transform .2s;z-index:50;overflow-y:auto;padding:20px}
#drawer.open{transform:translateX(0)}
#drawer-close{float:right;background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;padding:0 4px}

@media(max-width:600px){
  #drawer{width:100%;border-left:none;border-top:1px solid var(--border);top:auto;height:60vh;transform:translateY(100%)}
  #drawer.open{transform:translateY(0)}
  #content{padding:16px 12px}
}
</style>
</head>
<body>
<div id="app">
  <header id="header">
    <span id="logo">STRATUM</span>
    <span id="needs-badge">0</span>
    <nav id="nav">
      <button class="nav-btn active" data-tab="attention">Needs You</button>
      <button class="nav-btn" data-tab="work">Work</button>
      <button class="nav-btn" data-tab="projects">Projects</button>
      <button class="nav-btn" data-tab="activity">Activity</button>
    </nav>
    <button class="btn btn-sm btn-ghost" id="logout-btn" style="margin-left:8px;display:none">Sign out</button>
  </header>
  <main id="content"></main>
</div>

<div id="auth-overlay">
  <div id="auth-card">
    <h2>Stratum</h2>
    <p>Enter your API token to continue. Tokens are created via the API or CLI.</p>
    <div id="auth-err"></div>
    <input id="token-input" type="password" placeholder="strat_..." autocomplete="off">
    <button class="btn" id="login-btn" style="width:100%">Connect</button>
  </div>
</div>

<div id="drawer">
  <button id="drawer-close" title="Close">✕</button>
  <div id="drawer-content"></div>
</div>

<div id="toast"></div>

<script>
const API = '${baseApiPath}';

// ── State ─────────────────────────────────────────────────────────────────
let token = '';
let currentTab = 'attention';
let refreshTimer = null;

// ── Token auth ────────────────────────────────────────────────────────────
async function tryRestoreToken() {
  try { token = localStorage.getItem('stratum_token') || ''; } catch {}
  if (token) await checkToken();
}

async function checkToken() {
  try {
    const r = await api('GET', '/attention');
    if (r.ok) showApp();
    else { token = ''; clearSavedToken(); }
  } catch { token = ''; clearSavedToken(); }
}

function clearSavedToken() {
  try { localStorage.removeItem('stratum_token'); } catch {}
}

function showApp() {
  try { localStorage.setItem('stratum_token', token); } catch {}
  document.getElementById('auth-overlay').style.display = 'none';
  document.getElementById('logout-btn').style.display = '';
  switchTab('attention');
  startAutoRefresh();
}

document.getElementById('login-btn').addEventListener('click', async () => {
  const inp = document.getElementById('token-input');
  const errEl = document.getElementById('auth-err');
  token = inp.value.trim();
  if (!token) return;
  errEl.style.display = 'none';
  document.getElementById('login-btn').disabled = true;
  try {
    const r = await api('GET', '/attention');
    if (r.ok) { showApp(); }
    else {
      token = '';
      errEl.textContent = r.error?.message || 'Invalid token';
      errEl.style.display = '';
    }
  } catch (e) {
    token = '';
    errEl.textContent = 'Could not reach server';
    errEl.style.display = '';
  }
  document.getElementById('login-btn').disabled = false;
});

document.getElementById('token-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('login-btn').click();
});

document.getElementById('logout-btn').addEventListener('click', () => {
  token = '';
  clearSavedToken();
  clearInterval(refreshTimer);
  location.reload();
});

// ── API ───────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ── Navigation ────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  render();
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (!drawerOpen()) render(); }, 15000);
}

// ── Toast ─────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = type;
  el.style.display = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.style.display = 'none', 3000);
}

// ── Drawer ────────────────────────────────────────────────────────────────
document.getElementById('drawer-close').addEventListener('click', closeDrawer);

function drawerOpen() { return document.getElementById('drawer').classList.contains('open'); }

function openDrawer(html) {
  document.getElementById('drawer-content').innerHTML = html;
  document.getElementById('drawer').classList.add('open');
}

function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
}

// ── Render ────────────────────────────────────────────────────────────────
async function render() {
  const content = document.getElementById('content');
  content.innerHTML = '<div style="padding:40px;text-align:center"><span class="spin"></span></div>';
  if (currentTab === 'attention') await renderAttention(content);
  else if (currentTab === 'work') await renderWork(content);
  else if (currentTab === 'projects') await renderProjects(content);
  else if (currentTab === 'activity') await renderActivity(content);
}

// ── Utilities ─────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function relTime(iso) {
  if (!iso) return '—';
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d/60000) + 'm ago';
  if (d < 86400000) return Math.floor(d/3600000) + 'h ago';
  return Math.floor(d/86400000) + 'd ago';
}

function stateTag(state) {
  const map = {ready:'tag-ready',running:'tag-running',failed:'tag-failed',blocked:'tag-blocked',completed:'tag-completed',cancelled:'tag-cancelled'};
  return '<span class="tag ' + (map[state]||'tag-state') + '">' + esc(state) + '</span>';
}

function urgencyTag(u) {
  const map = {blocking:'tag-blocking',urgent:'tag-urgent',normal:'tag-normal'};
  return '<span class="tag ' + (map[u]||'tag-normal') + '">' + esc(u) + '</span>';
}

// ── Needs You ─────────────────────────────────────────────────────────────
async function renderAttention(el) {
  const r = await api('GET', '/attention');
  if (!r.ok) { el.innerHTML = '<p class="empty">Failed to load attention items.</p>'; return; }
  const items = r.data;

  // Update badge
  const badge = document.getElementById('needs-badge');
  badge.textContent = items.length;
  badge.style.display = items.length ? '' : 'none';

  if (!items.length) {
    el.innerHTML = '<p class="empty" style="padding-top:60px">✓ Nothing needs your attention right now.</p>';
    return;
  }

  let html = '<div class="section-title">Needs You · ' + items.length + '</div>';
  for (const item of items) {
    const id = item.decisionId || item.workItemId || '';
    html += '<div class="card">';
    html += '<div class="row">' + urgencyTag(item.urgency) + '<span class="tag tag-state">' + esc(item.category.replace('_',' ')) + '</span></div>';
    html += '<div class="card-title" style="margin-top:8px">' + esc(item.title) + '</div>';
    if (item.summary) html += '<div class="card-sub">' + esc(item.summary) + '</div>';
    html += '<div class="actions">';
    if (item.category === 'decision_required' && item.decisionId) {
      html += '<button class="btn btn-sm btn-success" onclick="openDecision(' + JSON.stringify(esc(item.decisionId)) + ')">Resolve</button>';
      html += '<button class="btn btn-sm btn-ghost" onclick="viewDecision(' + JSON.stringify(esc(item.decisionId)) + ')">Inspect</button>';
    } else if (item.workItemId) {
      html += '<button class="btn btn-sm btn-ghost" onclick="viewWork(' + JSON.stringify(esc(item.workItemId)) + ')">Inspect</button>';
    }
    html += '</div></div>';
  }
  el.innerHTML = html;
}

// ── Work ──────────────────────────────────────────────────────────────────
let selectedProjectId = null;
let workStateFilter = '';

async function renderWork(el) {
  // Load projects first
  const pr = await api('GET', '/projects');
  if (!pr.ok) { el.innerHTML = '<p class="empty">Failed to load projects.</p>'; return; }
  const projects = pr.data;
  if (!projects.length) { el.innerHTML = '<p class="empty">No projects yet.</p>'; return; }

  if (!selectedProjectId || !projects.find(p => p.id === selectedProjectId)) {
    selectedProjectId = projects[0].id;
  }

  let html = '<div class="row" style="margin-bottom:16px;flex-wrap:wrap;gap:6px">';
  for (const p of projects) {
    const active = p.id === selectedProjectId;
    html += '<button class="btn btn-sm ' + (active ? '' : 'btn-ghost') + '" onclick="selectProject(' + JSON.stringify(esc(p.id)) + ')">' + esc(p.name) + '</button>';
  }
  html += '</div>';

  const stateOptions = ['','pending','ready','running','paused','blocked','completed','failed','cancelled'];
  html += '<div class="row" style="margin-bottom:16px;gap:6px"><span style="color:var(--muted);font-size:12px">State:</span>';
  for (const s of stateOptions) {
    const label = s || 'all';
    const active = workStateFilter === s;
    html += '<button class="btn btn-sm ' + (active ? '' : 'btn-ghost') + '" onclick="filterWork(' + JSON.stringify(s) + ')">' + label + '</button>';
  }
  html += '</div>';

  const path = '/projects/' + selectedProjectId + '/work' + (workStateFilter ? '?state=' + workStateFilter : '');
  const wr = await api('GET', path);
  if (!wr.ok) { el.innerHTML = html + '<p class="empty">Failed to load work items.</p>'; return; }
  const workItems = wr.data;

  if (!workItems.length) {
    html += '<p class="empty">No work items' + (workStateFilter ? ' in state "' + esc(workStateFilter) + '"' : '') + '.</p>';
  } else {
    html += '<div class="section-title">' + workItems.length + ' item' + (workItems.length !== 1 ? 's' : '') + '</div>';
    for (const w of workItems) {
      html += '<div class="card" style="cursor:pointer" onclick="viewWork(' + JSON.stringify(esc(w.id)) + ')">';
      html += '<div class="row">' + stateTag(w.state) + '<span class="flex1 card-title" style="margin:0">' + esc(w.title) + '</span><span style="color:var(--muted);font-size:11px">' + relTime(w.updatedAt) + '</span></div>';
      if (w.description) html += '<div class="card-sub" style="margin-top:6px">' + esc(w.description.slice(0,120)) + (w.description.length > 120 ? '…' : '') + '</div>';
      html += '</div>';
    }
  }
  el.innerHTML = html;
}

function selectProject(id) { selectedProjectId = id; render(); }
function filterWork(s) { workStateFilter = s; render(); }

// ── Projects ──────────────────────────────────────────────────────────────
async function renderProjects(el) {
  const r = await api('GET', '/projects');
  if (!r.ok) { el.innerHTML = '<p class="empty">Failed to load projects.</p>'; return; }
  const projects = r.data;
  if (!projects.length) { el.innerHTML = '<p class="empty">No projects yet.</p>'; return; }

  let html = '<div class="section-title">' + projects.length + ' project' + (projects.length !== 1 ? 's' : '') + '</div>';
  for (const p of projects) {
    // Load work summary
    const wr = await api('GET', '/projects/' + p.id + '/work');
    const work = wr.ok ? wr.data : [];
    const active = work.filter(w => ['ready','running','paused'].includes(w.state)).length;
    const failed = work.filter(w => w.state === 'failed').length;
    const blocked = work.filter(w => w.state === 'blocked').length;
    const healthy = !failed && !blocked;

    html += '<div class="card">';
    html += '<div class="row"><span class="flex1 card-title">' + esc(p.name) + '</span>';
    html += '<span class="tag ' + (healthy ? 'tag-ready' : 'tag-failed') + '">' + (healthy ? 'healthy' : 'needs attention') + '</span></div>';
    if (p.description) html += '<div class="card-sub" style="margin-top:4px">' + esc(p.description) + '</div>';
    html += '<div class="stat-grid" style="margin-top:12px">';
    html += '<div class="stat"><div class="stat-n">' + active + '</div><div class="stat-l">active</div></div>';
    html += '<div class="stat"><div class="stat-n" style="color:' + (failed ? 'var(--red)' : 'inherit') + '">' + failed + '</div><div class="stat-l">failed</div></div>';
    html += '<div class="stat"><div class="stat-n" style="color:' + (blocked ? 'var(--yellow)' : 'inherit') + '">' + blocked + '</div><div class="stat-l">blocked</div></div>';
    html += '<div class="stat"><div class="stat-n">' + work.length + '</div><div class="stat-l">total</div></div>';
    html += '</div></div>';
  }
  el.innerHTML = html;
}

// ── Activity ──────────────────────────────────────────────────────────────
async function renderActivity(el) {
  const r = await api('GET', '/events');
  if (!r.ok) { el.innerHTML = '<p class="empty">Failed to load events.</p>'; return; }
  const events = r.data;
  if (!events.length) { el.innerHTML = '<p class="empty">No events yet.</p>'; return; }

  let html = '<div class="section-title">Recent Activity · ' + events.length + '</div><div class="card" style="padding:8px 16px">';
  for (const ev of events) {
    html += '<div class="event-row">';
    html += '<span class="event-time">' + relTime(ev.occurredAt) + '</span>';
    html += '<span class="event-type">' + esc(ev.type) + '</span>';
    if (ev.data?.title) html += '<span class="flex1" style="color:var(--muted)">' + esc(String(ev.data.title).slice(0,60)) + '</span>';
    html += '</div>';
  }
  html += '</div>';
  el.innerHTML = html;
}

// ── Work detail ───────────────────────────────────────────────────────────
async function viewWork(id) {
  openDrawer('<div style="text-align:center;padding:40px"><span class="spin"></span></div>');
  const [wr, er] = await Promise.all([api('GET', '/work/' + id), api('GET', '/work/' + id + '/evidence')]);
  if (!wr.ok) { document.getElementById('drawer-content').innerHTML = '<p class="empty">Work item not found.</p>'; return; }
  const w = wr.data;
  const evidence = er.ok ? er.data : [];

  let html = '<h2 style="font-size:16px;margin-bottom:6px">' + esc(w.title) + '</h2>';
  html += '<div class="row" style="margin-bottom:12px">' + stateTag(w.state) + '<span style="color:var(--muted);font-size:12px">' + relTime(w.updatedAt) + '</span></div>';
  if (w.description) html += '<p style="color:var(--muted);font-size:13px;margin-bottom:16px">' + esc(w.description) + '</p>';

  // Actions
  html += '<div class="actions" style="margin-bottom:16px">';
  const transitions = {
    pending: [{a:'ready',l:'Mark Ready',cls:''}],
    ready: [{a:'pause',l:'Pause',cls:'btn-ghost'}],
    running: [{a:'pause',l:'Pause',cls:'btn-ghost'},{a:'fail',l:'Fail',cls:'btn-danger'}],
    paused: [{a:'resume',l:'Resume',cls:''}],
    blocked: [{a:'ready',l:'Unblock',cls:''}],
  };
  const actions = transitions[w.state] || [];
  for (const t of actions) {
    html += '<button class="btn btn-sm ' + (t.cls||'') + '" onclick="doWorkAction(' + JSON.stringify(esc(id)) + ',' + JSON.stringify(t.a) + ')">' + t.l + '</button>';
  }
  html += '</div>';

  // Evidence
  html += '<div class="section-title" style="margin-bottom:8px">Evidence (' + evidence.length + ')</div>';
  if (evidence.length) {
    html += '<div class="card" style="padding:8px 12px">';
    for (const ev of evidence) {
      const icon = ev.verdict === 'pass' ? '✓' : ev.verdict === 'fail' ? '✗' : '○';
      const cls = ev.verdict === 'pass' ? 'ev-pass' : ev.verdict === 'fail' ? 'ev-fail' : 'ev-pending';
      html += '<div class="evidence-item"><span class="' + cls + '">' + icon + '</span><span class="flex1">' + esc(ev.kind || ev.type || '—') + '</span><span style="color:var(--muted)">' + relTime(ev.recordedAt) + '</span></div>';
    }
    html += '</div>';
  } else {
    html += '<p style="color:var(--muted);font-size:12px">No evidence recorded.</p>';
  }

  // Events
  const evr = await api('GET', '/work/' + id + '/events');
  if (evr.ok && evr.data.length) {
    html += '<div class="section-title" style="margin:16px 0 8px">Events</div><div class="card" style="padding:8px 12px">';
    for (const ev of evr.data.slice(0, 20)) {
      html += '<div class="event-row"><span class="event-time">' + relTime(ev.occurredAt) + '</span><span class="event-type">' + esc(ev.type) + '</span></div>';
    }
    html += '</div>';
  }

  document.getElementById('drawer-content').innerHTML = html;
}

// ── Decision detail ───────────────────────────────────────────────────────
async function viewDecision(id) {
  openDrawer('<div style="text-align:center;padding:40px"><span class="spin"></span></div>');
  const r = await api('GET', '/decisions/' + id);
  if (!r.ok) { document.getElementById('drawer-content').innerHTML = '<p class="empty">Decision not found.</p>'; return; }
  const d = r.data;

  let html = '<h2 style="font-size:16px;margin-bottom:6px">' + esc(d.title || 'Decision') + '</h2>';
  html += '<div class="row" style="margin-bottom:12px"><span class="tag tag-state">' + esc(d.status || 'pending') + '</span></div>';
  if (d.description) html += '<p style="color:var(--muted);font-size:13px;margin-bottom:16px">' + esc(d.description) + '</p>';

  if (d.options && d.options.length) {
    html += '<div class="section-title" style="margin-bottom:8px">Options</div>';
    for (const opt of d.options) {
      html += '<div class="card">';
      html += '<div class="card-title">' + esc(opt.label || opt.id) + '</div>';
      if (opt.description) html += '<div class="card-sub">' + esc(opt.description) + '</div>';
      if (d.status === 'pending') {
        html += '<div class="actions"><button class="btn btn-sm btn-success" onclick="resolveDecision(' + JSON.stringify(esc(id)) + ',' + JSON.stringify(esc(opt.id)) + ')">Choose this</button></div>';
      }
      html += '</div>';
    }
  } else if (d.status === 'pending') {
    html += '<div class="actions"><button class="btn btn-success" onclick="openDecision(' + JSON.stringify(esc(id)) + ')">Resolve</button></div>';
  }

  document.getElementById('drawer-content').innerHTML = html;
}

async function openDecision(id) {
  const r = await api('GET', '/decisions/' + id);
  if (!r.ok) { toast('Decision not found', 'err'); return; }
  const d = r.data;
  if (!d.options || !d.options.length) {
    viewDecision(id);
    return;
  }
  viewDecision(id);
}

async function resolveDecision(id, optionId) {
  const r = await api('POST', '/decisions/' + id + '/resolve', {
    resolution: { selectedOptionId: optionId, resolvedAt: new Date().toISOString() },
  });
  if (r.ok) {
    toast('Decision resolved');
    closeDrawer();
    render();
  } else {
    toast(r.error?.message || 'Failed to resolve', 'err');
  }
}

// ── Work actions ──────────────────────────────────────────────────────────
async function doWorkAction(id, action) {
  const body = {};
  const r = await api('POST', '/work/' + id + '/' + action, body);
  if (r.ok) {
    toast('Work ' + action + ' applied');
    viewWork(id);
    render();
  } else {
    toast(r.error?.message || 'Action failed', 'err');
  }
}


// ── Boot ──────────────────────────────────────────────────────────────────
tryRestoreToken();
</script>
</body>
</html>`;
}
