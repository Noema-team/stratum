// ─── State Store ───
const state = {
  activePage: 'overview',
  connected: false,
  systemState: 'idle',
  initialised: true,
  awaitingConfirmation: false,
  awaitingShardingApproval: false,
  project: { name: 'Stratum Project', type: 'api' },
  activities: [],
  jobs: [],
  tasks: [],
  documents: [],
  proposal: null,
  chatHistory: [
    { sender: 'assistant', text: 'Hello! I am the Facilitator agent. How can I help you coordinate this cycle?' }
  ]
};

// ─── Event Names Mapping (Dotted format) ───
const EVENT_LABELS = {
  'system.ready': 'Ready State Synced',
  'system.state_changed': 'System State Transitioned',
  'cycle.started': 'Cycle Started',
  'cycle.completed': 'Cycle Completed',
  'node.started': 'Execution Node Started',
  'node.completed': 'Execution Node Completed',
  'intake.document_promoted': 'Document Promoted to Graph',
  'intake.coherence_checked': 'Coherence Gate Checked',
  'intake.sharding_proposed': 'Task Sharding Proposal Generated',
  'intake.sharding_approved': 'Task Sharding Proposal Approved',
  'intake.sharding_rejected': 'Task Sharding Proposal Rejected',
  'categories.confirmed': 'Validation Categories Confirmed',
};

// ─── WebSocket Client ───
class SLEWebSocketClient {
  constructor() {
    this.ws = null;
    this.reconnectTimeout = null;
    this.backoff = 1000;
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:7700';
    this.ws = new WebSocket(`${protocol}//${host}/events`);

    this.ws.onopen = () => {
      console.log('[WS] Connected to Stratum event stream');
      state.connected = true;
      this.backoff = 1000;
      updateConnectionIndicator();
      fetchFreshStatus();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleIncomingEvent(data);
      } catch (err) {
        console.error('[WS] Error parsing message:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('[WS] Disconnected, scheduling reconnect...');
      state.connected = false;
      updateConnectionIndicator();
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[WS] Error in socket connection:', err);
      this.ws.close();
    };
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      console.log(`[WS] Attempting reconnect (backoff: ${this.backoff}ms)...`);
      this.backoff = Math.min(this.backoff * 2, 30000);
      this.connect();
    }, this.backoff);
  }

  send(command) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(command));
    } else {
      console.error('[WS] Cannot send message, socket closed');
    }
  }
}

const client = new SLEWebSocketClient();

// ─── Event Handling ───
function handleIncomingEvent(event) {
  const timestamp = new Date(event.timestamp || Date.now()).toLocaleTimeString();
  const label = EVENT_LABELS[event.type] || event.type;
  
  // Push to recent activity
  state.activities.unshift({
    time: timestamp,
    type: label,
    message: formatEventMessage(event)
  });

  // Keep logs to a maximum of 50 entries
  if (state.activities.length > 50) state.activities.pop();

  // Handle specific state modifications
  if (event.type === 'system.ready') {
    state.project.name = event.payload.name || state.project.name;
    document.getElementById('project-title').textContent = state.project.name;
  } else if (event.type === 'system.state_changed') {
    state.systemState = event.payload.current;
    updateSystemStatusBadge();
  } else if (event.type === 'node.started') {
    state.jobs.push({ node: event.payload.node, status: 'running', progress: 20 });
  } else if (event.type === 'node.completed') {
    state.jobs = state.jobs.filter(j => j.node !== event.payload.node);
  } else if (event.type === 'intake.sharding_proposed') {
    state.proposal = event.payload.proposal;
  } else if (event.type === 'chat.message') {
    state.chatHistory.push({
      sender: event.payload.sender,
      text: event.payload.text
    });
    if (state.chatHistory.length > 50) state.chatHistory.shift();
  }

  // Reactive redraw of the current view
  triggerViewRender();
}

function formatEventMessage(event) {
  if (event.type === 'system.state_changed') {
    return `Transitioned from <span class="badge default">${event.payload.previous}</span> to <span class="badge info">${event.payload.current}</span>`;
  }
  if (event.type === 'node.started') {
    return `Started running execution agent for <span class="badge info">${event.payload.node}</span>`;
  }
  if (event.type === 'node.completed') {
    return `Completed <span class="badge success">${event.payload.node}</span> node successfully`;
  }
  if (event.type === 'intake.document_promoted') {
    return `Document <span class="badge secondary">${event.payload.node_id}</span> promoted to graph`;
  }
  return JSON.stringify(event.payload || {});
}

// ─── SPA Hash Router ───
function initRouter() {
  const handleRouting = () => {
    const hash = window.location.hash || '#overview';
    const pages = ['overview', 'chat', 'graph', 'settings'];
    
    pages.forEach(p => {
      const tab = document.getElementById(`tab-${p}`);
      if (tab) {
        if (hash === `#${p}`) {
          tab.classList.add('active');
          state.activePage = p;
        } else {
          tab.classList.remove('active');
        }
      }
    });

    triggerViewRender();
  };

  window.addEventListener('hashchange', handleRouting);
  // Initial page load routing
  handleRouting();
}

// ─── View Controller & Rendering ───
function triggerViewRender() {
  const mount = document.getElementById('page-content');
  if (!mount) return;

  // Clear modal overlay container if not actively required
  const overlay = document.getElementById('overlay-container');
  if (overlay) {
    if (!state.awaitingConfirmation && !state.awaitingShardingApproval) {
      overlay.classList.add('hidden');
      overlay.innerHTML = '';
    } else {
      overlay.classList.remove('hidden');
      renderOverlayModal(overlay);
    }
  }

  if (state.activePage === 'overview') {
    renderOverview(mount);
  } else if (state.activePage === 'chat') {
    renderChat(mount);
  } else if (state.activePage === 'graph') {
    renderGraph(mount);
  } else if (state.activePage === 'settings') {
    renderSettings(mount);
  }
}

// ─── Overview View Render ───
function renderOverview(mount) {
  if (!state.initialised) {
    mount.innerHTML = `
      <div style="max-width: 600px; margin: 40px auto; background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 32px; box-shadow: var(--shadow-lg); text-align: center; border-left: 4px solid var(--accent-primary);">
        <div style="font-size: 40px; margin-bottom: 16px;">🚀</div>
        <h1 style="font-size: 24px; font-weight: 700; margin-bottom: 8px; background: linear-gradient(135deg, var(--text-primary) 30%, var(--accent-primary) 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Initialize Stratum Workspace</h1>
        <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 24px; line-height: 1.6;">
          Your current folder is not yet initialized as a Stratum sustained learning environment. Initialize it now to unlock automated code generation, lint passes, and graph indexing.
        </p>
        
        <div style="text-align: left; background-color: hsl(222, 12%, 9%); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 20px; margin-bottom: 24px;">
          <div style="margin-bottom: 16px;">
            <label style="display: block; font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--text-secondary); margin-bottom: 6px; letter-spacing: 0.5px;">Project Type</label>
            <select id="init-project-type" style="width: 100%; padding: 10px; background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 13px;">
              <option value="api">API Server (Recommended)</option>
              <option value="ui">UI Web Application</option>
              <option value="library">Software Library</option>
              <option value="research">Research Workspace</option>
            </select>
          </div>
          
          <div style="display: flex; align-items: center; gap: 8px;">
            <input type="checkbox" id="init-git-repo" checked style="width: 16px; height: 16px; accent-color: var(--accent-primary); cursor: pointer;" />
            <label for="init-git-repo" style="font-size: 13px; font-weight: 500; color: var(--text-primary); cursor: pointer;">Initialize Git repository if missing</label>
          </div>
        </div>

        <button id="btn-init-workspace" class="btn btn-primary" style="width: 100%; padding: 12px; font-size: 14px; border-radius: var(--radius-md);">
          Bootstrap Workspace Environment
        </button>
      </div>
    `;

    document.getElementById('btn-init-workspace').onclick = async () => {
      const type = document.getElementById('init-project-type').value;
      const gitInit = document.getElementById('init-git-repo').checked;
      const name = state.project.name || 'stratum-project';
      
      const btn = document.getElementById('btn-init-workspace');
      btn.textContent = 'Initializing Workspace...';
      btn.disabled = true;

      try {
        const host = window.location.host || 'localhost:7700';
        const res = await fetch(`http://${host}/api/v2/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_name: name,
            project_type: type,
            task_store: 'local',
            git_init: gitInit,
            non_interactive: true
          })
        });

        const data = await res.json();
        if (data.ok) {
          state.initialised = true;
          await fetchFreshStatus();
        } else {
          alert('Initialization failed: ' + (data.error?.message || 'Unknown error'));
          btn.textContent = 'Bootstrap Workspace Environment';
          btn.disabled = false;
        }
      } catch (err) {
        alert('Connection error during initialization: ' + err.message);
        btn.textContent = 'Bootstrap Workspace Environment';
        btn.disabled = false;
      }
    };
    return;
  }

  mount.innerHTML = `
    <div class="dashboard-grid">
      <!-- Panel 1: Actions Required -->
      <div class="panel col-6">
        <div class="panel-header">
          <h2>Actions Required</h2>
          <span class="badge warning">Needs Attention</span>
        </div>
        <div class="panel-body">
          ${renderActionsRequiredBody()}
        </div>
      </div>

      <!-- Panel 2: Active Docker Jobs -->
      <div class="panel col-6">
        <div class="panel-header">
          <h2>Active Execution Jobs</h2>
          <span class="badge info">Real-Time</span>
        </div>
        <div class="panel-body">
          ${renderActiveJobsBody()}
        </div>
      </div>

      <!-- Panel 3: Tasks Progress -->
      <div class="panel col-4">
        <div class="panel-header">
          <h2>Tasks Progress</h2>
          <span class="badge success">Local Task Store</span>
        </div>
        <div class="panel-body">
          ${renderTasksProgressBody()}
        </div>
      </div>

      <!-- Panel 4: Documents Index -->
      <div class="panel col-4">
        <div class="panel-header">
          <h2>Documents Intake</h2>
          <span class="badge secondary">Coherence Gate</span>
        </div>
        <div class="panel-body">
          ${renderDocumentsBody()}
        </div>
      </div>

      <!-- Panel 5: Sharding Review -->
      <div class="panel col-4">
        <div class="panel-header">
          <h2>Sharding Review</h2>
          <span class="badge secondary">Proposal</span>
        </div>
        <div class="panel-body">
          ${renderShardingReviewBody()}
        </div>
      </div>

      <!-- Panel 6: Recent Activity Event Logs -->
      <div class="panel col-12">
        <div class="panel-header">
          <h2>Recent System Activity</h2>
          <span class="badge default">Dotted Logs</span>
        </div>
        <div class="panel-body">
          <div class="activity-list" style="max-height: 250px;">
            ${state.activities.map(a => `
              <div class="activity-item">
                <span class="time">${a.time}</span>
                <div>
                  <span class="type">${a.type}</span>
                  <p class="message">${a.message}</p>
                </div>
              </div>
            `).join('') || '<p class="text-muted">No recent activity detected.</p>'}
          </div>
        </div>
      </div>
    </div>
  `;

  // Wire up actions clicks
  const confirmBtn = document.getElementById('btn-action-confirm');
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      state.awaitingConfirmation = true;
      triggerViewRender();
    };
  }

  const shardBtn = document.getElementById('btn-action-shard');
  if (shardBtn) {
    shardBtn.onclick = () => {
      state.awaitingShardingApproval = true;
      triggerViewRender();
    };
  }

  const shardInlineBtn = document.getElementById('btn-action-shard-inline');
  if (shardInlineBtn) {
    shardInlineBtn.onclick = () => {
      state.awaitingShardingApproval = true;
      triggerViewRender();
    };
  }
}

function renderShardingReviewBody() {
  if (!state.proposal) {
    return '<p class="text-muted">No pending task sharding proposals at this time.</p>';
  }

  return `
    <div class="proposal-card" style="padding: 12px; background-color: hsl(222, 12%, 9%); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
      <div style="margin-bottom: 12px;">
        <strong style="display: block; font-size: 13px; color: var(--text-primary);">${state.proposal.tasks ? state.proposal.tasks.length : 0} Tasks Generated</strong>
        <p class="text-muted" style="font-size: 11px; margin-top: 4px;">Tokens estimation: <strong>${state.proposal.total_estimated_tokens || '1,500'}</strong></p>
      </div>
      <button id="btn-action-shard-inline" class="btn btn-primary" style="width: 100%; padding: 6px 12px; font-size: 12px;">Review & Approve</button>
    </div>
  `;
}

function renderActionsRequiredBody() {
  let actionsHtml = '';

  if (state.systemState === 'cycling' && state.awaitingConfirmation) {
    actionsHtml += `
      <div class="action-item">
        <div class="action-info">
          <h3>Cycle Scoping / Confirm Gate</h3>
          <p>The planner has compiled the cycle plan. Architectural confirmation is required.</p>
        </div>
        <button id="btn-action-confirm" class="btn btn-primary">Review Gate</button>
      </div>
    `;
  }

  if (state.awaitingShardingApproval) {
    actionsHtml += `
      <div class="action-item">
        <div class="action-info">
          <h3>Task Sharding Proposal</h3>
          <p>Collaborative sharding generated a new decomposition task list. Review is required.</p>
        </div>
        <button id="btn-action-shard" class="btn btn-primary">Review Proposal</button>
      </div>
    `;
  }

  return actionsHtml || '<p class="text-muted">All clear! No pending actions require attention.</p>';
}

function renderActiveJobsBody() {
  if (state.jobs.length === 0) {
    return '<p class="text-muted">No active container validation jobs currently running.</p>';
  }

  return state.jobs.map(j => `
    <div class="job-item">
      <div class="job-header">
        <span>Docker Container validation: <strong>${j.node}</strong></span>
        <span class="badge info">${j.status}</span>
      </div>
      <div class="progress-bar-container">
        <div class="progress-bar-fill active" style="width: ${j.progress}%"></div>
      </div>
    </div>
  `).join('');
}

function renderTasksProgressBody() {
  if (state.tasks.length === 0) {
    return '<p class="text-muted">No sharded tasks are currently loaded in the store.</p>';
  }

  return `
    <div class="task-list">
      ${state.tasks.map(t => `
        <div class="task-card ${t.stale ? 'stale' : ''}">
          <div>
            <strong>${t.title}</strong>
            <div class="task-meta">
              <span>Priority: ${t.priority}</span>
              <span>Status: ${t.status}</span>
            </div>
          </div>
          <span class="badge ${t.status === 'open' ? 'info' : 'success'}">${t.status}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderDocumentsBody() {
  if (state.documents.length === 0) {
    return '<p class="text-muted">No documents parsed inside .sle/project-docs/.</p>';
  }

  return `
    <div class="task-list">
      ${state.documents.map(d => `
        <div class="task-card">
          <div>
            <strong>${d.title}</strong>
            <div class="task-meta">
              <span>Sections: ${d.sections.length}</span>
              <span>Status: ${d.status}</span>
            </div>
          </div>
          <span class="badge secondary">${d.status}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// ─── Modal Overlay Render ───
function renderOverlayModal(container) {
  if (state.awaitingConfirmation) {
    container.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>Architectural Confirm Checkpoint</h3>
          <span class="badge warning">CONFIRM</span>
        </div>
        <div class="modal-body">
          <p style="margin-bottom: 12px;">The Planner has compiled the design documents and evaluation criteria. Please review the proposed cycle before authorizing code generation.</p>
          <div style="background-color: hsl(222, 12%, 9%); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 12px; font-family: var(--font-mono); font-size: 13px;">
            Intent: Build a task manager API<br>
            Current State: cycling<br>
            Awaiting: User confirmation
          </div>
        </div>
        <div class="modal-footer">
          <button id="modal-confirm-revise" class="btn btn-secondary">Request Revision</button>
          <button id="modal-confirm-approve" class="btn btn-primary">Approve & Continue</button>
        </div>
      </div>
    `;

    document.getElementById('modal-confirm-approve').onclick = async () => {
      client.send({ type: 'approval.respond', gate: 'CONFIRM', decision: 'approve' });
      state.awaitingConfirmation = false;
      triggerViewRender();
    };

    document.getElementById('modal-confirm-revise').onclick = async () => {
      client.send({ type: 'approval.respond', gate: 'CONFIRM', decision: 'revise', message: 'Improve error handling' });
      state.awaitingConfirmation = false;
      triggerViewRender();
    };
  } else if (state.awaitingShardingApproval) {
    container.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>Task Sharding proposal</h3>
          <span class="badge secondary">SHARDING_APPROVAL</span>
        </div>
        <div class="modal-body">
          <p style="margin-bottom: 12px;">Task sharding decomposed requirements into discrete dependencies-wired units. Please review the proposal list below:</p>
          <div style="background-color: hsl(222, 12%, 9%); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 16px;">
            <strong style="display:block; margin-bottom: 8px;">Decomposed Tasks:</strong>
            <ul style="padding-left: 20px; font-size: 13px; line-height: 1.6;">
              <li><strong>Task P1:</strong> Implement database Schema slices (SQLite auth table)</li>
              <li><strong>Task P2:</strong> Set up API endpoints router (GET /health)</li>
            </ul>
          </div>
        </div>
        <div class="modal-footer">
          <button id="modal-shard-reject" class="btn btn-danger">Reject Proposal</button>
          <button id="modal-shard-approve" class="btn btn-primary">Approve & Generate</button>
        </div>
      </div>
    `;

    document.getElementById('modal-shard-approve').onclick = async () => {
      client.send({ type: 'approval.respond', gate: 'SHARDING_APPROVAL', decision: 'approve' });
      state.awaitingShardingApproval = false;
      triggerViewRender();
    };

    document.getElementById('modal-shard-reject').onclick = async () => {
      client.send({ type: 'approval.respond', gate: 'SHARDING_APPROVAL', decision: 'reject' });
      state.awaitingShardingApproval = false;
      triggerViewRender();
    };
  }
}

// ─── Chat View Render ───
function renderChat(mount) {
  mount.innerHTML = `
    <div class="chat-container">
      <div class="chat-messages" id="chat-messages-box">
        ${state.chatHistory.map(m => `
          <div class="chat-bubble ${m.sender}">
            ${m.text}
          </div>
        `).join('')}
      </div>
      <div class="chat-input-area">
        <input type="text" id="chat-user-input" placeholder="Type message to Facilitator..." />
        <button id="chat-send-btn" class="btn btn-primary">Send</button>
      </div>
    </div>
  `;

  // Auto-scroll chat messages
  const box = document.getElementById('chat-messages-box');
  if (box) box.scrollTop = box.scrollHeight;

  // Send trigger
  const sendBtn = document.getElementById('chat-send-btn');
  const input = document.getElementById('chat-user-input');

  const executeSend = async () => {
    const text = input.value.trim();
    if (!text) return;
    
    input.value = '';
    
    try {
      const host = window.location.host || 'localhost:7700';
      await fetch(`http://${host}/api/v2/chat/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
      });
    } catch (err) {
      console.error('[Chat] Error sending message:', err);
    }
  };

  if (sendBtn && input) {
    sendBtn.onclick = executeSend;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') executeSend();
    };
  }
}

// ─── Settings View Render ───
async function renderSettings(mount) {
  mount.innerHTML = `
    <div class="settings-container">
      <div class="settings-card">
        <h2>System Settings</h2>
        <div class="loader-container">
          <div class="loader"></div>
          <p style="margin-top: 12px; color: var(--text-secondary);">Loading settings...</p>
        </div>
      </div>
    </div>
  `;

  try {
    const host = window.location.host || 'localhost:7700';
    const res = await fetch(`http://${host}/api/v2/settings`);
    if (!res.ok) throw new Error('Failed to load settings');
    const responseData = await res.json();
    const settings = responseData.data;

    // Define provider model lists
    const PROVIDER_MODELS = {
      'openai_compatible': ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
      'anthropic': ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-20240229'],
      'glm': ['glm-5', 'glm-z1-rumination', 'glm-4', 'glm-4-flash', 'glm-4.1v-thinking', 'glm-4-long', 'glm-4-airx'],
      'openrouter': ['google/gemini-2.5-pro', 'anthropic/claude-3.5-sonnet', 'meta-llama/llama-3-70b-instruct']
    };

    // Default base URLs per provider
    const PROVIDER_DEFAULTS = {
      'openai_compatible': '',
      'anthropic': '',
      'glm': 'https://api.z.ai/api/paas/v4',
      'openrouter': 'https://openrouter.ai/api/v1'
    };

    // Hint text shown below the Base URL field for specific providers
    const PROVIDER_URL_HINTS = {
      'glm': 'International (Z.AI): <code>https://api.z.ai/api/paas/v4</code> &nbsp;|&nbsp; ' +
             'Coding Plan: <code>https://api.z.ai/api/coding/paas/v4</code> &nbsp;|&nbsp; ' +
             'Mainland CN: <code>https://open.bigmodel.cn/api/paas/v4</code>'
    };

    const providerNames = {
      'openai_compatible': 'OpenAI Compatible',
      'anthropic': 'Anthropic',
      'glm': 'Zhipu GLM AI',
      'openrouter': 'OpenRouter'
    };

    const currentProvider = settings.provider || 'openai_compatible';
    const currentModel = settings.model || '';
    const currentBaseUrl = settings.base_url || '';
    const currentApiKey = settings.api_key || '';

    // Check if current model is in standard list
    const standardModels = PROVIDER_MODELS[currentProvider] || [];
    const isCustomModel = currentModel && !standardModels.includes(currentModel);

    mount.innerHTML = `
      <div class="settings-container">
        <form class="settings-card" id="settings-form" onsubmit="return false;">
          <h2>System Settings</h2>
          
          <div class="form-group">
            <label for="settings-provider">LLM Provider</label>
            <select id="settings-provider">
              ${Object.entries(providerNames).map(([key, name]) => `
                <option value="${key}" ${key === currentProvider ? 'selected' : ''}>${name}</option>
              `).join('')}
            </select>
          </div>

          <div class="form-group">
            <label for="settings-model">Model</label>
            <select id="settings-model">
              ${standardModels.map(m => `
                <option value="${m}" ${m === currentModel ? 'selected' : ''}>${m}</option>
              `).join('')}
              <option value="custom" ${isCustomModel ? 'selected' : ''}>Custom...</option>
            </select>
          </div>

          <div class="form-group ${isCustomModel ? '' : 'hidden'}" id="custom-model-group">
            <label for="settings-custom-model">Custom Model Identifier</label>
            <input type="text" id="settings-custom-model" placeholder="e.g. meta-llama/llama-3-8b" value="${isCustomModel ? currentModel : ''}" />
          </div>

          <div class="form-group">
            <label for="settings-base-url">Base URL</label>
            <input type="text" id="settings-base-url" placeholder="Uses provider default if blank" value="${currentBaseUrl}" />
            <span id="settings-url-hint" class="settings-url-hint">${PROVIDER_URL_HINTS[currentProvider] || ''}</span>
          </div>

          <div class="form-group">
            <label for="settings-api-key">API Key</label>
            <input type="password" id="settings-api-key" placeholder="${currentApiKey ? '••••••••' : 'Enter API key'}" value="${currentApiKey}" />
          </div>

          <div class="settings-actions">
            <button type="submit" id="settings-save-btn" class="btn btn-primary">Save Settings</button>
            <span id="settings-status-message"></span>
          </div>
        </form>
      </div>
    `;

    const providerSelect = document.getElementById('settings-provider');
    const modelSelect = document.getElementById('settings-model');
    const customModelGroup = document.getElementById('custom-model-group');
    const customModelInput = document.getElementById('settings-custom-model');
    const baseUrlInput = document.getElementById('settings-base-url');
    const apiKeyInput = document.getElementById('settings-api-key');
    const saveBtn = document.getElementById('settings-save-btn');
    const statusMsg = document.getElementById('settings-status-message');

    // Handle provider change -> update models dropdown + auto-fill base URL
    providerSelect.onchange = () => {
      const selectedProv = providerSelect.value;
      const models = PROVIDER_MODELS[selectedProv] || [];
      
      modelSelect.innerHTML = `
        ${models.map(m => `<option value="${m}">${m}</option>`).join('')}
        <option value="custom">Custom...</option>
      `;

      // Auto-fill base URL with provider default
      const defaultUrl = PROVIDER_DEFAULTS[selectedProv] || '';
      baseUrlInput.value = defaultUrl;
      baseUrlInput.placeholder = defaultUrl ? defaultUrl : 'Uses provider default if blank';

      // Show provider-specific URL hint
      const urlHint = document.getElementById('settings-url-hint');
      if (urlHint) urlHint.innerHTML = PROVIDER_URL_HINTS[selectedProv] || '';

      // Trigger model change logic
      modelSelect.onchange();
    };

    // Handle model change -> toggle custom text input
    modelSelect.onchange = () => {
      if (modelSelect.value === 'custom') {
        customModelGroup.classList.remove('hidden');
      } else {
        customModelGroup.classList.add('hidden');
      }
    };

    // Save action
    saveBtn.onclick = async (e) => {
      e.preventDefault();
      
      const provider = providerSelect.value;
      let model = modelSelect.value;
      if (model === 'custom') {
        model = customModelInput.value.trim();
        if (!model) {
          statusMsg.className = 'settings-status error';
          statusMsg.innerHTML = '✗ Custom model identifier is required';
          return;
        }
      }

      const base_url = baseUrlInput.value.trim();
      const api_key = apiKeyInput.value;

      statusMsg.className = 'settings-status';
      statusMsg.innerHTML = '<span class="loader" style="display: inline-block; width: 14px; height: 14px; border-width: 2px; margin-right: 6px; vertical-align: middle;"></span> Saving...';
      saveBtn.disabled = true;

      try {
        const postRes = await fetch(`http://${host}/api/v2/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider,
            base_url: base_url || null,
            model,
            api_key: api_key || null
          })
        });

        const postData = await postRes.json();
        saveBtn.disabled = false;

        if (!postRes.ok) {
          throw new Error(postData.error?.message || 'Failed to save settings');
        }

        statusMsg.className = 'settings-status success';
        statusMsg.innerHTML = '✓ Settings saved and hot-reloaded successfully!';
        
        if (postData.data.api_key) {
          apiKeyInput.placeholder = '••••••••';
          apiKeyInput.value = '••••••••';
        }

        setTimeout(() => {
          if (statusMsg.innerHTML.includes('saved')) {
            statusMsg.innerHTML = '';
          }
        }, 4000);

      } catch (err) {
        saveBtn.disabled = false;
        statusMsg.className = 'settings-status error';
        statusMsg.innerHTML = `✗ Error: ${err.message}`;
      }
    };

  } catch (err) {
    mount.innerHTML = `
      <div class="settings-container">
        <div class="settings-card">
          <h2>System Settings</h2>
          <p style="color: var(--status-red); font-size: 14px; margin-top: 12px;">✗ Error loading settings: ${err.message}</p>
          <button class="btn btn-secondary" style="margin-top: 16px;" onclick="window.location.reload()">Retry</button>
        </div>
      </div>
    `;
  }
}

// ─── Graph View Canvas-based Physics Simulation ───
let physicsEngine = null;

function renderGraph(mount) {
  mount.innerHTML = `
    <div class="graph-container">
      <canvas id="graph-canvas"></canvas>
      <div class="graph-overlay-panel" id="graph-node-details">
        <h3 style="font-size: 14px; margin-bottom: 8px;">Artifact Graph</h3>
        <p style="font-size: 12px; color: var(--text-secondary);">Click on any document or file node to explore dependencies and links.</p>
      </div>
    </div>
  `;

  const canvas = document.getElementById('graph-canvas');
  if (!canvas) return;

  // Resize canvas
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = canvas.parentElement.clientHeight;

  // Compile mock nodes from our intake and sharding records
  const nodes = [
    { id: 'doc:brief', label: 'Brief Doc', x: canvas.width / 2 - 80, y: canvas.height / 2, size: 16, color: '#f59e0b', type: 'doc' },
    { id: 'task-p1', label: 'SQLite Auth Schema', x: canvas.width / 2 + 80, y: canvas.height / 2 - 60, size: 12, color: '#6366f1', type: 'task' },
    { id: 'task-p2', label: 'API Router Node', x: canvas.width / 2 + 80, y: canvas.height / 2 + 60, size: 12, color: '#0ea5e9', type: 'task' },
  ];

  const links = [
    { source: nodes[1], target: nodes[0] }, // task-p1 references doc:brief
    { source: nodes[2], target: nodes[0] }, // task-p2 references doc:brief
  ];

  if (physicsEngine) physicsEngine.stop();
  physicsEngine = startForceDirectedSimulation(canvas, nodes, links);
}

function startForceDirectedSimulation(canvas, nodes, links) {
  const ctx = canvas.getContext('2d');
  let animationId = null;
  let active = true;

  const k = 0.05; // spring constant
  const rep = 800; // electrostatic repulsion
  const damp = 0.85; // damping force

  function step() {
    if (!active) return;

    // 1. Calculate repulsion forces (electrostatic)
    for (let i = 0; i < nodes.length; i++) {
      const n1 = nodes[i];
      n1.fx = 0;
      n1.fy = 0;

      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        const n2 = nodes[j];
        const dx = n1.x - n2.x;
        const dy = n1.y - n2.y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 10);
        
        const force = rep / (d * d);
        n1.fx += (dx / d) * force;
        n1.fy += (dy / d) * force;
      }
    }

    // 2. Calculate spring attraction forces
    links.forEach(l => {
      const dx = l.target.x - l.source.x;
      const dy = l.target.y - l.source.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      
      const force = k * (d - 120); // 120 is target spring rest length
      
      l.source.fx += (dx / d) * force;
      l.source.fy += (dy / d) * force;
      l.target.fx -= (dx / d) * force;
      l.target.fy -= (dy / d) * force;
    });

    // 3. Apply dynamics & update node positions
    nodes.forEach(n => {
      if (n.dragging) return;
      n.vx = (n.vx || 0) * damp + n.fx;
      n.vy = (n.vy || 0) * damp + n.fy;
      
      n.x += n.vx;
      n.y += n.vy;

      // Restrict boundaries
      n.x = Math.max(n.size, Math.min(canvas.width - n.size, n.x));
      n.y = Math.max(n.size, Math.min(canvas.height - n.size, n.y));
    });

    // 4. Draw Graph frame
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw Links
    links.forEach(l => {
      ctx.beginPath();
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
      ctx.strokeStyle = '#2d3748';
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    // Draw Nodes
    nodes.forEach(n => {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.size, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 3;
      ctx.stroke();

      // Draw text label
      ctx.font = '12px Outfit';
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.fillText(n.label, n.x, n.y - n.size - 6);
    });

    animationId = requestAnimationFrame(step);
  }

  // Interactivity: Drag & Drop Node
  let selectedNode = null;
  canvas.onmousedown = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    selectedNode = nodes.find(n => {
      const dx = n.x - mx;
      const dy = n.y - my;
      return Math.sqrt(dx * dx + dy * dy) < n.size;
    });

    if (selectedNode) {
      selectedNode.dragging = true;
      showNodeDetails(selectedNode);
    }
  };

  canvas.onmousemove = (e) => {
    if (selectedNode && selectedNode.dragging) {
      const rect = canvas.getBoundingClientRect();
      selectedNode.x = e.clientX - rect.left;
      selectedNode.y = e.clientY - rect.top;
    }
  };

  canvas.onmouseup = () => {
    if (selectedNode) {
      selectedNode.dragging = false;
      selectedNode = null;
    }
  };

  step();

  return {
    stop() {
      active = false;
      cancelAnimationFrame(animationId);
    }
  };
}

function showNodeDetails(node) {
  const panel = document.getElementById('graph-node-details');
  if (!panel) return;
  panel.innerHTML = `
    <h3 style="font-size: 14px; margin-bottom: 8px;">Node details:</h3>
    <p style="font-size: 13px; margin-bottom: 4px;"><strong>ID:</strong> ${node.id}</p>
    <p style="font-size: 13px; margin-bottom: 4px;"><strong>Type:</strong> ${node.type}</p>
    <p style="font-size: 13px; margin-bottom: 12px;"><strong>Title:</strong> ${node.label}</p>
    <span class="badge secondary">Linked</span>
  `;
}

// ─── UI Status Updates ───
function updateConnectionIndicator() {
  const dot = document.querySelector('.status-dot');
  const text = document.querySelector('.status-text');
  if (!dot || !text) return;

  if (state.connected) {
    dot.className = 'status-dot green';
    text.textContent = 'Connected';
  } else {
    dot.className = 'status-dot red';
    text.textContent = 'Disconnected';
  }
}

function updateSystemStatusBadge() {
  const badge = document.getElementById('system-status-badge');
  if (!badge) return;
  
  badge.textContent = state.systemState;
  badge.className = 'badge default';

  if (state.systemState === 'cycling') badge.classList.add('info');
  else if (state.systemState === 'idle') badge.classList.add('success');
  else if (state.systemState === 'halted') badge.classList.add('danger');
}

// ─── REST Fetch Status Helpers ───
async function fetchFreshStatus() {
  try {
    const host = window.location.host || 'localhost:7700';
    
    // 0. Fetch project details from info
    try {
      const infoRes = await fetch(`http://${host}/api/v2/info`);
      const infoData = await infoRes.json();
      if (infoData.ok && infoData.data.project_root) {
        const rootPath = infoData.data.project_root;
        const parts = rootPath.split(/[/\\]/);
        state.project.name = parts[parts.length - 1] || 'Stratum Project';
        document.getElementById('project-title').textContent = state.project.name;
      }
    } catch (err) {
      console.error('[REST] Error fetching project info:', err);
    }

    // 0b. Fetch initialization status
    try {
      const initStateRes = await fetch(`http://${host}/api/v2/init/state`);
      const initStateData = await initStateRes.json();
      if (initStateData.ok) {
        state.initialised = initStateData.data.initialised;
      }
    } catch (err) {
      console.error('[REST] Error fetching init status:', err);
    }

    // 1. Fetch system state
    const stateRes = await fetch(`http://${host}/api/v2/system/state`);
    const stateData = await stateRes.json();
    if (stateData.ok) {
      state.systemState = stateData.data.state;
      state.awaitingConfirmation = stateData.data.awaiting_confirmation || false;
      state.awaitingShardingApproval = stateData.data.awaiting_sharding_approval || false;
      updateSystemStatusBadge();
    }

    // 2. Fetch active tasks
    try {
      const taskRes = await fetch(`http://${host}/api/v2/intake/taskstore`);
      const taskData = await taskRes.json();
      if (taskData.ok && taskData.data.tasks && taskData.data.tasks.length > 0) {
        state.tasks = taskData.data.tasks;
      } else {
        // Mock some tasks if backend returns none for testing visual aesthetics
        state.tasks = [
          { title: 'SQLite Database Schema', status: 'open', priority: 1, stale: false },
          { title: 'API Endpoints Router', status: 'open', priority: 2, stale: false }
        ];
      }
    } catch {}

    // 3. Fetch documents list
    try {
      const docRes = await fetch(`http://${host}/api/v2/intake/documents`);
      const docData = await docRes.json();
      if (docData.ok && docData.data.documents) {
        state.documents = docData.data.documents;
      } else {
        state.documents = [
          { title: 'E2E Design Brief', sections: [1, 2], status: 'promoted' }
        ];
      }
    } catch {}

    triggerViewRender();
  } catch (err) {
    console.error('[REST] Error synchronizing state:', err);
  }
}

// ─── Initialization ───
document.addEventListener('DOMContentLoaded', () => {
  initRouter();
  client.connect();
});
