/**
 * CodeBot AI Dashboard -- Grok-Style with Matrix Code Rain
 * Vanilla JS, zero dependencies.
 */

/** Authenticated fetch — sends auth token with every /api/ request */
function apiFetch(path, opts) {
  opts = opts || {};
  var headers = opts.headers ? Object.assign({}, opts.headers) : {};
  var token = window.__CODEBOT_TOKEN;
  if (token) headers['Authorization'] = 'Bearer ' + token;
  opts.headers = headers;
  var base = window.location.origin;
  // Add 30s timeout via AbortController
  var controller = new AbortController();
  var timeoutId = setTimeout(function() { controller.abort(); }, 30000);
  if (!opts.signal) opts.signal = controller.signal;
  return window.fetch(base + path, opts).then(function(res) {
    clearTimeout(timeoutId);
    // Auto-reload on 401 to pick up new auth token after server restart
    if (res.status === 401 && !window.__reloading) {
      window.__reloading = true;
      window.location.reload();
    }
    return res;
  }).catch(function(err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error('Request timed out (30s)');
    throw err;
  });
}

const App = {
  baseUrl: window.location.origin,
  sessionCount: 0,
  toolsData: null,
  terminalHistory: [],
  terminalHistoryIndex: -1,
  cmdInitialized: false,
  agentConnected: false,
  agentStatus: 'idle',
  agentStatusTimer: null,
  agentStartTime: null,

  // -- Init --
  init() {
    // Detect Electron and enable title bar drag region
    if (window.electronAPI && window.electronAPI.isElectron) {
      document.body.classList.add('is-electron');
      var titlebar = document.getElementById('electron-titlebar');
      if (titlebar) titlebar.style.display = '';
    }
    this.setupNavigation();
    this.checkOnboarding();
    this.checkHealth();
    this.navigateToHash();
    window.addEventListener('hashchange', () => this.navigateToHash());
    setInterval(() => this.checkHealth(), 30000);
    this.loadConversations();
    this.connectAgentStatus();
    this.pollNotifications();
    setInterval(() => this.pollNotifications(), 30000);
  },

  // ===========================================================
  // ONBOARDING
  // ===========================================================

  async checkOnboarding() {
    try {
      var data = await this.fetch('/api/setup/status');
      if (!data.configured && !data.firstRunComplete) {
        this.startOnboarding();
      }
    } catch (err) {
      // Server not ready yet, skip onboarding check
    }
  },

  onboardingStep: 0,
  onboardingDetected: null,

  startOnboarding() {
    document.getElementById('onboarding-overlay').style.display = '';
    this.onboardingStep = 0;
    this.showOnboardingStep();
  },

  async showOnboardingStep() {
    var el = document.getElementById('onboarding-step');
    var step = this.onboardingStep;

    if (step === 0) {
      // Welcome
      el.innerHTML =
        '<h2 class="onboarding-title">Welcome to CodeBot</h2>' +
        '<p class="onboarding-desc">Your AI super agent. Let\'s get you set up in under a minute.</p>' +
        '<p class="onboarding-desc">CodeBot can help with coding, research, social media, writing, system tasks, and much more.</p>' +
        '<button class="btn-continue" onclick="App.nextOnboardingStep()">Get Started</button>';
    }
    else if (step === 1) {
      // Detect providers
      el.innerHTML = '<h2 class="onboarding-title">Detecting Providers...</h2>' +
        '<div class="onboarding-detecting"><div class="spinner"></div><p>Looking for AI providers...</p></div>';

      try {
        var data = await this.fetch('/api/setup/detect');
        this.onboardingDetected = data;

        var html = '<h2 class="onboarding-title">Choose Your AI Provider</h2>';

        if (data.localServers && data.localServers.length > 0) {
          html += '<p class="onboarding-desc">Local AI detected! No API key needed.</p>';
          for (var i = 0; i < data.localServers.length; i++) {
            var s = data.localServers[i];
            html += '<button class="onboarding-provider-btn" onclick="App.selectOnboardingProvider(&#39;ollama&#39;, &#39;' + App.escapeHtml(s.models[0] || '') + '&#39;, &#39;' + App.escapeHtml(s.url) + '&#39;)">' +
              '<strong>' + App.escapeHtml(s.name) + '</strong> <span class="onboarding-model">' + App.escapeHtml(s.models.slice(0, 3).join(', ')) + '</span>' +
            '</button>';
          }
        }

        if (data.envProviders && data.envProviders.length > 0) {
          html += '<p class="onboarding-desc">API keys detected in environment:</p>';
          for (var j = 0; j < data.envProviders.length; j++) {
            var p = data.envProviders[j];
            html += '<button class="onboarding-provider-btn" onclick="App.selectOnboardingProvider(&#39;' + App.escapeHtml(p) + '&#39;)">' +
              '<strong>' + App.escapeHtml(p.charAt(0).toUpperCase() + p.slice(1)) + '</strong>' +
            '</button>';
          }
        }

        // Always show manual API key entry option
        html += '<div class="onboarding-manual-key" style="margin-top:16px;border-top:1px solid rgba(255,255,255,0.1);padding-top:16px;">';
        if ((!data.localServers || data.localServers.length === 0) && (!data.envProviders || data.envProviders.length === 0)) {
          html += '<p class="onboarding-desc">No providers detected. Enter your API key to get started:</p>';
        } else {
          html += '<p class="onboarding-desc" style="font-size:0.85em;opacity:0.7;">Or enter a different API key:</p>';
        }
        html += '<div style="display:flex;gap:8px;margin-top:8px;">' +
          '<select id="onboard-provider-select" style="background:#1a1a2e;color:#e0e0e0;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:8px;font-size:0.9em;">' +
            '<option value="anthropic">Anthropic (Claude)</option>' +
            '<option value="openai">OpenAI (GPT)</option>' +
          '</select>' +
          '<input id="onboard-api-key" type="password" placeholder="Paste API key..." style="flex:1;background:#1a1a2e;color:#e0e0e0;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:8px;font-size:0.9em;" />' +
          '<button class="btn-continue" onclick="App.saveOnboardingKey()" style="white-space:nowrap;">Save</button>' +
          '</div>' +
          '<p id="onboard-key-error" style="color:#ff6b6b;font-size:0.8em;margin-top:6px;display:none;"></p>';
        if ((!data.localServers || data.localServers.length === 0) && (!data.envProviders || data.envProviders.length === 0)) {
          html += '<button class="btn-continue" onclick="App.nextOnboardingStep()" style="margin-top:12px;opacity:0.5;font-size:0.85em;">Skip for Now</button>';
        }
        html += '</div>';

        el.innerHTML = html;
      } catch (err) {
        el.innerHTML = '<h2 class="onboarding-title">Provider Detection</h2>' +
          '<p class="onboarding-desc">Could not detect providers. You can configure this later.</p>' +
          '<button class="btn-continue" onclick="App.nextOnboardingStep()">Continue</button>';
      }
    }
    else if (step === 2) {
      // Done
      el.innerHTML =
        '<h2 class="onboarding-title">You\'re All Set!</h2>' +
        '<p class="onboarding-desc">CodeBot is ready. Try asking it anything.</p>' +
        '<div class="onboarding-tips">' +
          '<p><strong>Quick tips:</strong></p>' +
          '<ul>' +
            '<li>Use <strong>Chat</strong> to talk to CodeBot</li>' +
            '<li>Try <strong>Workflows</strong> for one-click actions</li>' +
            '<li>Check <strong>Memory</strong> to set your preferences</li>' +
            '<li>Use the <strong>notification bell</strong> for alerts</li>' +
          '</ul>' +
        '</div>' +
        '<button class="btn-continue" onclick="App.finishOnboarding()">Start Using CodeBot</button>';
    }
  },

  async saveOnboardingKey() {
    var provider = document.getElementById('onboard-provider-select').value;
    var key = document.getElementById('onboard-api-key').value.trim();
    var errEl = document.getElementById('onboard-key-error');
    if (!key) { errEl.textContent = 'Please enter an API key.'; errEl.style.display = ''; return; }
    if (provider === 'anthropic' && !key.startsWith('sk-ant-')) {
      errEl.textContent = 'Anthropic keys start with sk-ant-'; errEl.style.display = ''; return;
    }
    errEl.style.display = 'none';
    try {
      var model = provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o';
      await apiFetch('/api/setup/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: provider, model: model, apiKey: key }),
      });
      this.onboardingStep = 2;
      this.showOnboardingStep();
    } catch (err) {
      errEl.textContent = 'Failed to save: ' + err.message; errEl.style.display = '';
    }
  },

  async selectOnboardingProvider(provider, model, baseUrl) {
    try {
      var body = { provider: provider };
      if (model) body.model = model;
      if (baseUrl) body.baseUrl = baseUrl;
      await apiFetch('/api/setup/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {}
    this.onboardingStep = 2;
    this.showOnboardingStep();
  },

  nextOnboardingStep() {
    this.onboardingStep++;
    this.showOnboardingStep();
  },

  async finishOnboarding() {
    try {
      await apiFetch('/api/setup/complete', { method: 'POST' });
    } catch (err) {}
    document.getElementById('onboarding-overlay').style.display = 'none';
  },

  // ===========================================================
  // NAVIGATION
  // ===========================================================

  setupNavigation() {
    document.querySelectorAll('.nav-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        window.location.hash = pill.dataset.panel;
      });
    });
  },

  navigateToHash() {
    const hash = window.location.hash.replace('#', '') || 'chat';
    this.showPanel(hash);
  },

  showPanel(name) {
    document.querySelectorAll('.nav-pill').forEach(pill =>
      pill.classList.toggle('active', pill.dataset.panel === name)
    );
    document.querySelectorAll('.panel').forEach(panel =>
      panel.classList.toggle('active', panel.id === 'panel-' + name)
    );
    const logoArea = document.getElementById('logo-area');
    const chatMsgs = document.getElementById('chat-messages');
    const hasMessages = chatMsgs && chatMsgs.children.length > 0;
    if (logoArea) {
      logoArea.classList.remove('faded', 'compact');
      if (name === 'chat' && hasMessages) {
        logoArea.classList.add('faded');
      } else if (name !== 'chat') {
        logoArea.classList.add('compact');
      }
    }
    document.body.classList.toggle('chat-expanded', name !== 'chat' || hasMessages);
    switch (name) {
      case 'chat': this.initChat(); break;
      case 'sessions': this.loadSessions(); break;
      case 'terminal': this.initTerminal(); break;
      case 'tools': this.initTools(); break;
      case 'workflows': this.initWorkflows(); break;
      case 'memory': this.initMemory(); break;
      case 'files': this.initFiles(); break;
      case 'status': this.initStatus(); break;
      case 'codeagi': this.initPanelCodeagi(); break;
      case 'settings': this.initSettings(); break;
    }
  },

  // ===========================================================
  // HEALTH + STATUS
  // ===========================================================

  async checkHealth() {
    const conn = document.getElementById('conn-indicator');
    if (!conn) return;
    try {
      const data = await this.fetch('/api/health');
      conn.className = 'ok';
      conn.id = 'conn-indicator';
      conn.querySelector('.conn-text').textContent = 'v' + data.version;

      // Check agent status
      try {
        const status = await this.fetch('/api/command/status');
        this.agentConnected = status.available;
      } catch { this.agentConnected = false; }
    } catch {
      conn.className = 'error';
      conn.id = 'conn-indicator';
      conn.querySelector('.conn-text').textContent = 'Offline';
    }
  },

  // ===========================================================
  // CHAT
  // ===========================================================

  chatInitialized: false,

  initChat() {
    if (this.chatInitialized) return;
    this.chatInitialized = true;

    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send');
    if (!input || !sendBtn) return;

    const send = () => {
      const msg = input.value.trim();
      if (!msg) return;
      input.value = '';
      this.lastUserMessage = msg;
      this.saveMessageToConversation('user', msg);
      this.appendChatMessage('user', msg);
      this.streamChat(msg);

      // Hide suggestion chips
      var suggestions = document.getElementById('chat-suggestions');
      if (suggestions) suggestions.style.display = 'none';

      // Fade logo + expand layout once chat starts
      const logoArea = document.getElementById('logo-area');
      if (logoArea) logoArea.classList.add('faded');
      document.body.classList.add('chat-expanded');
    };

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });

    // Wire up suggestion chips
    var chips = document.querySelectorAll('.suggestion-chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function() {
        var msg = this.getAttribute('data-msg');
        input.value = msg;
        input.focus();
      });
    }
  },

  appendChatMessage(role, content) {
    const container = document.getElementById('chat-messages');
    if (!container) return document.createElement('div');
    const div = document.createElement('div');
    div.className = 'chat-msg ' + this.escapeHtml(role);

    const roleHtml = '<div class="chat-msg-role">' + this.escapeHtml(role) + '</div>';
    let contentHtml;
    if (role === 'assistant') {
      contentHtml = '<div class="chat-msg-content">' + this.renderMarkdown(content) + '</div>';
    } else {
      contentHtml = '<div class="chat-msg-content">' + this.escapeHtml(content) + '</div>';
    }
    div.innerHTML = roleHtml + contentHtml;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
  },

  appendChatToolCall(name, args) {
    const container = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-msg tool-call';
    let argsStr = '';
    if (args && typeof args === 'object') {
      argsStr = Object.entries(args).map(function(pair) {
        return App.escapeHtml(pair[0]) + ': ' + App.escapeHtml(App.truncate(String(pair[1]), 120));
      }).join('\n');
    }

    var toolIcon = this.getToolIcon(name);
    div.innerHTML = '<div class="tool-call-header" onclick="this.parentElement.classList.toggle(&#39;expanded&#39;)">' +
      '<span class="tool-call-icon">' + toolIcon + '</span>' +
      '<span class="tool-call-name">' + this.escapeHtml(name) + '</span>' +
      '<span class="tool-call-status"><span class="tool-spinner"></span></span>' +
      '<svg class="tool-call-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>' +
      '</div>' +
      '<div class="tool-call-detail">' +
        '<pre class="tool-call-args">' + argsStr + '</pre>' +
        '<div class="tool-call-result"></div>' +
      '</div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
  },

  getToolIcon(name) {
    var icons = {
      read_file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
      write_file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
      edit_file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
      execute: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
      web_search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
      web_fetch: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
      glob: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
      grep: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
      think: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      browser: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    };
    return icons[name] || '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
  },

  updateToolCallResult(toolDiv, result, success) {
    if (!toolDiv) return;
    var statusEl = toolDiv.querySelector('.tool-call-status');
    if (statusEl) {
      statusEl.innerHTML = success
        ? '<span class="tool-status-ok">Done</span>'
        : '<span class="tool-status-err">Error</span>';
    }
    var resultEl = toolDiv.querySelector('.tool-call-result');
    if (resultEl && result) {
      resultEl.innerHTML = '<pre>' + App.escapeHtml(App.truncate(String(result), 500)) + '</pre>';
    }
  },

  async streamChat(message) {
    const container = document.getElementById('chat-messages');
    const assistantDiv = this.appendChatMessage('assistant', '');
    const contentEl = assistantDiv.querySelector('.chat-msg-content');
    contentEl.innerHTML = '<div class="chat-thinking"><span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span></div>';
    let fullText = '';
    let totalTokens = 0;
    let hasError = false;
    try {
      const res = await apiFetch('/api/command/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message }),
      });
      if (!res.ok) {
        const errD = await res.json().catch(() => ({}));
        if (res.status === 409 || errD.queued) {
          contentEl.innerHTML = '<div class="chat-queued"><span class="queue-icon">📋</span> Message queued — position #' + (errD.position || '?') + '. Agent will process it when ready.</div>';
          return;
        }
        contentEl.textContent = 'Error: ' + (errD.error || 'HTTP ' + res.status);
        return;
      }
      // Handle queued response (200 with queued flag)
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const jsonData = await res.json();
        if (jsonData.queued) {
          contentEl.innerHTML = '<div class="chat-queued"><span class="queue-icon">📋</span> Message queued — position #' + (jsonData.position || '?') + '. Agent will process it when ready.</div>';
          return;
        }
      }
      if (!res.body) { contentEl.textContent = '(empty response)'; return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') break;
          try {
            const ev = JSON.parse(payload);
            if (ev.type === 'text') {
              fullText += ev.text || '';
              contentEl.innerHTML = App.renderMarkdown(fullText);
              container.scrollTop = container.scrollHeight;
            }
            else if (ev.type === 'tool_call' && ev.toolCall) {
              this._lastToolDiv = this.appendChatToolCall(ev.toolCall.name, ev.toolCall.args);
            }
            else if (ev.type === 'tool_result' && this._lastToolDiv) {
              this.updateToolCallResult(this._lastToolDiv, ev.text || ev.result, !ev.error);
              this._lastToolDiv = null;
            }
            else if (ev.type === 'usage' && ev.usage) {
              totalTokens += (ev.usage.outputTokens || 0);
            }
            else if (ev.type === 'error') {
              hasError = true;
              var errMsg = ev.text || ev.error || 'unknown error';
              var friendlyMsg = App.friendlyError(errMsg);
              contentEl.innerHTML = App.renderMarkdown(fullText) +
                '<div class="chat-error-box">' +
                  '<div class="chat-error-icon">&#9888;</div>' +
                  '<div class="chat-error-text">' + App.escapeHtml(friendlyMsg) + '</div>' +
                  '<button class="chat-retry-btn" onclick="App.retryLastMessage()">Retry</button>' +
                '</div>';
            }
          } catch(e) {}
        }
      }
      if (!fullText && !hasError) contentEl.textContent = '(no response)';
      this.highlightAllCode();
      // Show token usage
      // Save assistant response to conversation
      if (fullText) this.saveMessageToConversation('assistant', fullText);
      if (totalTokens > 0 && !hasError) {
        var cost = (totalTokens / 1000000 * 15).toFixed(4); // ~$15/M output tokens for Sonnet
        var usageDiv = document.createElement('div');
        usageDiv.className = 'chat-usage';
        usageDiv.textContent = totalTokens + ' tokens (~$' + cost + ')';
        assistantDiv.appendChild(usageDiv);
      }
    } catch (err) {
      if (!hasError) {
        contentEl.innerHTML = '<div class="chat-error-box">' +
          '<div class="chat-error-icon">&#9888;</div>' +
          '<div class="chat-error-text">' + App.escapeHtml(App.friendlyError(String(err))) + '</div>' +
          '<button class="chat-retry-btn" onclick="App.retryLastMessage()">Retry</button>' +
        '</div>';
      }
    }
  },

  friendlyError(msg) {
    if (!msg) return 'Something went wrong. Please try again.';
    var m = msg.toLowerCase();
    if (m.includes('rate limit') || m.includes('429')) return 'Rate limited — too many requests. Wait a moment and try again.';
    if (m.includes('401') || m.includes('unauthorized') || m.includes('authentication')) return 'API key is invalid or expired. Check Settings to update your key.';
    if (m.includes('402') || m.includes('insufficient') || m.includes('credit') || m.includes('billing')) return 'API credits exhausted. Add credits to your API account to continue.';
    if (m.includes('timeout') || m.includes('timed out')) return 'Request timed out. Try breaking the task into smaller steps.';
    if (m.includes('network') || m.includes('fetch') || m.includes('econnrefused')) return 'Network error — cannot reach the AI provider. Check your internet connection.';
    if (m.includes('overloaded') || m.includes('503') || m.includes('529')) return 'AI provider is overloaded. Wait a moment and try again.';
    return msg;
  },

  lastUserMessage: null,

  retryLastMessage() {
    if (this.lastUserMessage) {
      var msgs = document.querySelectorAll('.chat-msg');
      if (msgs.length > 0) {
        var last = msgs[msgs.length - 1];
        if (last.querySelector('.chat-error-box')) last.remove();
      }
      this.streamChat(this.lastUserMessage);
    }
  },

  sendCapabilityDemo(category) {
    var demos = {
      code: 'Show me what you can do with code. Read a file from this project, analyze it, and suggest an improvement.',
      research: 'Research the latest trends in AI agents and autonomous coding tools. Give me a comprehensive summary.',
      automate: 'Show me your automation capabilities. Check the system health, list recent git commits, and give me a status report.',
      create: 'Write a professional LinkedIn post announcing an AI-powered coding agent that can autonomously write, test, and deploy code.',
      connect: 'Show me all the app integrations you support and how they work. List your connectors and their capabilities.',
      safe: 'Explain your safety architecture. What prevents you from doing something dangerous? Walk me through your 8-layer safety stack.',
    };
    var msg = demos[category] || 'What can you do?';
    var input = document.getElementById('chat-input');
    if (input) input.value = msg;
    // Trigger the send
    var sendBtn = document.getElementById('chat-send');
    if (sendBtn) sendBtn.click();
  },

  newChat() {
    // Reset agent conversation on the server
    apiFetch('/api/command/chat/reset', { method: 'POST' }).catch(function() {});
    this.lastUserMessage = null;
    this.activeConversationId = null;

    // Clear chat messages and reset to initial state
    var container = document.getElementById('chat-messages');
    if (container) container.innerHTML = '';

    // Show suggestion chips again
    var suggestions = document.getElementById('chat-suggestions');
    if (suggestions) suggestions.style.display = '';

    // Reset logo and layout
    var logoArea = document.getElementById('logo-area');
    if (logoArea) logoArea.classList.remove('faded');
    document.body.classList.remove('chat-expanded');

    // Focus input
    var input = document.getElementById('chat-input');
    if (input) { input.value = ''; input.focus(); }

    this.renderConversationList();
  },


  // ===========================================================
  // FILE EXPLORER
  // ===========================================================

  filesInitialized: false,

  async initFiles() {
    if (this.filesInitialized) return;
    this.filesInitialized = true;
    this.browseDir();
  },

  async browseDir(dirPath) {
    var url = '/api/files/browse';
    if (dirPath) url += '?path=' + encodeURIComponent(dirPath);
    try {
      var data = await this.fetch(url);
      // Breadcrumb
      var breadcrumb = document.getElementById('file-breadcrumb');
      if (breadcrumb) {
        var parts = data.path.split('/').filter(Boolean);
        var crumbs = '<span class="breadcrumb-item" onclick="App.browseDir(&#39;/&#39;)">root</span>';
        var built = '';
        for (var i = 0; i < parts.length; i++) {
          built += '/' + parts[i];
          var isLast = i === parts.length - 1;
          crumbs += ' <span class="breadcrumb-sep">/</span> ';
          if (isLast) {
            crumbs += '<span class="breadcrumb-item active">' + this.escapeHtml(parts[i]) + '</span>';
          } else {
            crumbs += '<span class="breadcrumb-item" onclick="App.browseDir(&#39;' + this.escapeHtml(built) + '&#39;)">>' + this.escapeHtml(parts[i]) + '</span>';
          }
        }
        breadcrumb.innerHTML = crumbs;
      }

      // File list
      var list = document.getElementById('file-list');
      if (!list) return;
      var html = '';
      if (data.parent) {
        html += '<div class="file-item directory" onclick="App.browseDir(&#39;' + this.escapeHtml(data.parent) + '&#39;)"><span class="file-icon">&#128193;</span> <span class="file-name">..</span></div>';
      }
      for (var j = 0; j < data.items.length; j++) {
        var item = data.items[j];
        if (item.type === 'directory') {
          html += '<div class="file-item directory" onclick="App.browseDir(&#39;' + this.escapeHtml(item.path) + '&#39;)"><span class="file-icon">&#128193;</span> <span class="file-name">' + this.escapeHtml(item.name) + '</span></div>';
        } else {
          var sizeStr = item.size ? this.formatBytes(item.size) : '';
          html += '<div class="file-item file" onclick="App.previewFile(&#39;' + this.escapeHtml(item.path) + '&#39;, &#39;' + this.escapeHtml(item.name) + '&#39;)"><span class="file-icon">' + this.getFileIcon(item.ext) + '</span> <span class="file-name">' + this.escapeHtml(item.name) + '</span><span class="file-size">' + sizeStr + '</span></div>';
        }
      }
      list.innerHTML = html;
    } catch (err) {
      var list = document.getElementById('file-list');
      if (list) list.innerHTML = '<div class="file-error">Error loading files</div>';
    }
  },

  async previewFile(filePath, fileName) {
    try {
      var data = await this.fetch('/api/files/read?path=' + encodeURIComponent(filePath));
      var preview = document.getElementById('file-preview');
      var nameEl = document.getElementById('file-preview-name');
      var contentEl = document.getElementById('file-preview-content');
      if (preview) preview.classList.add('visible');
      if (nameEl) nameEl.textContent = fileName;
      if (contentEl) {
        var ext = fileName.split('.').pop() || '';
        var langMap = { ts: 'typescript', js: 'javascript', py: 'python', json: 'json', css: 'css', html: 'html', md: 'markdown', sh: 'bash', yml: 'yaml', yaml: 'yaml' };
        var lang = langMap[ext] || '';
        contentEl.textContent = data.content;
        if (typeof hljs !== 'undefined' && lang) {
          contentEl.className = 'file-preview-content language-' + lang;
          hljs.highlightElement(contentEl);
        }
      }
    } catch (err) {
      var contentEl = document.getElementById('file-preview-content');
      if (contentEl) contentEl.textContent = 'Error reading file';
    }
  },

  closeFilePreview() {
    var preview = document.getElementById('file-preview');
    if (preview) preview.classList.remove('visible');
  },

  getFileIcon(ext) {
    var icons = {
      ts: '&#128220;', js: '&#128220;', py: '&#128013;', json: '&#128203;',
      css: '&#127912;', html: '&#127760;', md: '&#128196;', svg: '&#127912;',
      png: '&#128247;', jpg: '&#128247;', gif: '&#128247;', sh: '&#9000;',
      yml: '&#9881;', yaml: '&#9881;', env: '&#128274;', lock: '&#128274;',
    };
    return icons[ext] || '&#128196;';
  },

  formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  },

  // ===========================================================
  // SYSTEM STATUS
  // ===========================================================

  statusInitialized: false,
  statusInterval: null,

  async initStatus() {
    this.loadStatus();
    if (!this.statusInterval) {
      this.statusInterval = setInterval(() => this.loadStatus(), 10000);
    }
  },

  async loadStatus() {
    try {
      var data = await this.fetch('/api/system/stats');
      var grid = document.getElementById('status-grid');
      if (!grid) return;

      var uptimeStr = this.formatUptime(data.uptime);
      var memUsed = ((data.processMemory.heapUsed / 1024 / 1024)).toFixed(0);
      var memTotal = ((data.processMemory.heapTotal / 1024 / 1024)).toFixed(0);
      var sysMem = ((data.totalMemory - data.freeMemory) / 1024 / 1024 / 1024).toFixed(1);
      var sysMemTotal = (data.totalMemory / 1024 / 1024 / 1024).toFixed(0);

      grid.innerHTML =
        '<div class="status-card">' +
          '<div class="status-card-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>' +
          '<div class="status-card-label">Uptime</div>' +
          '<div class="status-card-value">' + uptimeStr + '</div>' +
        '</div>' +
        '<div class="status-card">' +
          '<div class="status-card-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg></div>' +
          '<div class="status-card-label">Process Memory</div>' +
          '<div class="status-card-value">' + memUsed + ' / ' + memTotal + ' MB</div>' +
          '<div class="status-card-bar"><div class="status-bar-fill" style="width:' + Math.round(data.processMemory.heapUsed / data.processMemory.heapTotal * 100) + '%"></div></div>' +
        '</div>' +
        '<div class="status-card">' +
          '<div class="status-card-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg></div>' +
          '<div class="status-card-label">System Memory</div>' +
          '<div class="status-card-value">' + sysMem + ' / ' + sysMemTotal + ' GB</div>' +
          '<div class="status-card-bar"><div class="status-bar-fill" style="width:' + Math.round((data.totalMemory - data.freeMemory) / data.totalMemory * 100) + '%"></div></div>' +
        '</div>' +
        '<div class="status-card">' +
          '<div class="status-card-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg></div>' +
          '<div class="status-card-label">AI Provider</div>' +
          '<div class="status-card-value">' + this.escapeHtml(data.provider) + '</div>' +
          '<div class="status-card-sub">' + this.escapeHtml(data.model) + '</div>' +
        '</div>' +
        '<div class="status-card">' +
          '<div class="status-card-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div>' +
          '<div class="status-card-label">Platform</div>' +
          '<div class="status-card-value">' + this.escapeHtml(data.platform + '-' + data.arch) + '</div>' +
          '<div class="status-card-sub">Node ' + this.escapeHtml(data.nodeVersion) + ' &middot; ' + data.cpus + ' cores</div>' +
        '</div>' +
        '<div class="status-card">' +
          '<div class="status-card-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div>' +
          '<div class="status-card-label">Version</div>' +
          '<div class="status-card-value">v' + this.escapeHtml(data.version) + '</div>' +
          '<div class="status-card-sub">PID: ' + data.pid + '</div>' +
        '</div>';
    } catch (err) {
      var grid = document.getElementById('status-grid');
      if (grid) grid.innerHTML = '<div class="status-error">Error loading system stats</div>';
    }
  },

  formatUptime(seconds) {
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    return h + 'h ' + m + 'm';
  },

    // ===========================================================
  // CONVERSATION HISTORY
  // ===========================================================

  conversations: [],
  activeConversationId: null,

  loadConversations() {
    try {
      var stored = localStorage.getItem('codebot_conversations');
      this.conversations = stored ? JSON.parse(stored) : [];
    } catch(e) { this.conversations = []; }
    this.renderConversationList();
  },

  saveConversations() {
    try {
      localStorage.setItem('codebot_conversations', JSON.stringify(this.conversations));
    } catch(e) {}
  },

  createConversation() {
    var conv = {
      id: 'conv_' + Date.now(),
      title: 'New Chat',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.conversations.unshift(conv);
    this.activeConversationId = conv.id;
    this.saveConversations();
    this.renderConversationList();
    return conv;
  },

  getActiveConversation() {
    if (!this.activeConversationId) return null;
    return this.conversations.find(function(c) { return c.id === App.activeConversationId; });
  },

  saveMessageToConversation(role, content) {
    var conv = this.getActiveConversation();
    if (!conv) {
      conv = this.createConversation();
    }
    conv.messages.push({ role: role, content: content, ts: Date.now() });
    conv.updatedAt = new Date().toISOString();
    // Auto-title from first user message
    if (conv.title === 'New Chat' && role === 'user') {
      conv.title = content.length > 40 ? content.substring(0, 40) + '...' : content;
    }
    this.saveConversations();
    this.renderConversationList();
  },

  switchConversation(id) {
    this.activeConversationId = id;
    var conv = this.getActiveConversation();
    var container = document.getElementById('chat-messages');
    if (!container) return;
    container.innerHTML = '';

    if (conv && conv.messages) {
      for (var i = 0; i < conv.messages.length; i++) {
        var msg = conv.messages[i];
        if (msg.role === 'tool_call') {
          this.appendChatToolCall(msg.toolName || 'tool', msg.args || {});
        } else {
          this.appendChatMessage(msg.role, msg.content);
        }
      }
      this.highlightAllCode();
    }

    // Show/hide suggestions
    var hasMessages = conv && conv.messages.length > 0;
    var suggestions = document.getElementById('chat-suggestions');
    if (suggestions) suggestions.style.display = hasMessages ? 'none' : '';

    // Update layout
    var logoArea = document.getElementById('logo-area');
    if (logoArea) {
      if (hasMessages) logoArea.classList.add('faded');
      else logoArea.classList.remove('faded');
    }
    document.body.classList.toggle('chat-expanded', hasMessages);

    this.renderConversationList();
    // Reset server conversation
    apiFetch('/api/command/chat/reset', { method: 'POST' }).catch(function() {});
  },

  deleteConversation(id, evt) {
    if (evt) { evt.stopPropagation(); evt.preventDefault(); }
    this.conversations = this.conversations.filter(function(c) { return c.id !== id; });
    if (this.activeConversationId === id) {
      this.activeConversationId = this.conversations.length > 0 ? this.conversations[0].id : null;
      if (this.activeConversationId) {
        this.switchConversation(this.activeConversationId);
      } else {
        var container = document.getElementById('chat-messages');
        if (container) container.innerHTML = '';
        var suggestions = document.getElementById('chat-suggestions');
        if (suggestions) suggestions.style.display = '';
      }
    }
    this.saveConversations();
    this.renderConversationList();
  },

  renderConversationList() {
    var list = document.getElementById('chat-sidebar-list');
    if (!list) return;
    if (this.conversations.length === 0) {
      list.innerHTML = '<div class="chat-sidebar-empty">No conversations yet</div>';
      return;
    }
    var activeId = this.activeConversationId;
    list.innerHTML = this.conversations.slice(0, 50).map(function(conv) {
      var isActive = conv.id === activeId;
      var msgCount = conv.messages ? conv.messages.length : 0;
      var timeAgo = App.relativeTime(conv.updatedAt);
      return '<div class="chat-sidebar-item' + (isActive ? ' active' : '') + '" onclick="App.switchConversation(&#39;' + conv.id + '&#39;)">' +
        '<div class="chat-sidebar-item-title">' + App.escapeHtml(conv.title) + '</div>' +
        '<div class="chat-sidebar-item-meta">' + msgCount + ' msgs &middot; ' + App.escapeHtml(timeAgo) + '</div>' +
        '<button class="chat-sidebar-item-delete" onclick="App.deleteConversation(&#39;' + conv.id + '&#39;, event)" title="Delete">&times;</button>' +
      '</div>';
    }).join('');
  },

    // ===========================================================
  // SETTINGS
  // ===========================================================

  settingsLoaded: false,

  async initSettings() {
    if (this.settingsLoaded) return;
    this.settingsLoaded = true;
    try {
      var data = await this.fetch('/api/setup/status');
      if (data.provider) document.getElementById('settings-provider').value = data.provider;
      if (data.model) document.getElementById('settings-model').value = data.model;
      if (data.hasApiKey) document.getElementById('settings-api-key').placeholder = 'Key configured (hidden)';
    } catch (err) {}
  },

  toggleKeyVisibility() {
    var input = document.getElementById('settings-api-key');
    input.type = input.type === 'password' ? 'text' : 'password';
  },

  async saveSettings() {
    var provider = document.getElementById('settings-provider').value;
    var model = document.getElementById('settings-model').value;
    var apiKey = document.getElementById('settings-api-key').value.trim();
    var statusEl = document.getElementById('settings-status');
    var saveBtn = document.getElementById('settings-save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      var body = { provider: provider, model: model };
      if (apiKey) body.apiKey = apiKey;
      await apiFetch('/api/setup/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      statusEl.style.color = '#4caf50';
      statusEl.textContent = 'Settings saved. Restart the app for changes to take full effect.';
      if (apiKey) { document.getElementById('settings-api-key').value = ''; document.getElementById('settings-api-key').placeholder = 'Key configured (hidden)'; }
    } catch (err) {
      statusEl.style.color = '#ff6b6b';
      statusEl.textContent = 'Error: ' + err.message;
    }
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Settings';
  },

  // ===========================================================
  // NOTIFICATIONS
  // ===========================================================

  notificationPanelOpen: false,

  async pollNotifications() {
    try {
      var data = await this.fetch('/api/notifications');
      var badge = document.getElementById('notification-badge');
      if (!badge) return;
      if (data.unreadCount > 0) {
        badge.textContent = data.unreadCount > 99 ? '99+' : data.unreadCount;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    } catch (err) {
      // silently fail
    }
  },

  _sseBackoff: 1000,

  connectAgentStatus() {
    try {
      const token = window.__CODEBOT_TOKEN;
      const url = this.baseUrl + '/api/command/agent-status' + (token ? '?token=' + encodeURIComponent(token) : '');
      const es = new EventSource(url);
      es.onopen = () => { this._sseBackoff = 1000; };
      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          this.updateAgentStatus(data.status, data);
        } catch(err) {}
      };
      es.onerror = () => {
        es.close();
        var delay = Math.min(this._sseBackoff, 30000);
        this._sseBackoff = Math.min(this._sseBackoff * 1.5, 30000);
        setTimeout(() => this.connectAgentStatus(), delay);
      };
    } catch(err) {}
  },

  updateAgentStatus(status, data) {
    this.agentStatus = status;
    const indicator = document.getElementById('agent-status-indicator');
    if (!indicator) return;

    if (status === 'working') {
      if (!this.agentStartTime) this.agentStartTime = Date.now();
      indicator.className = 'agent-status working';
      var toolInfo = '';
      if (data && data.tool) {
        toolInfo = data.tool + (data.action ? ':' + data.action : '');
      } else if (data && data.toolDone) {
        toolInfo = data.toolDone + (data.success ? ' ✓' : ' ✗');
      }
      var label = toolInfo ? toolInfo : 'Working...';
      indicator.innerHTML = '<span class="agent-status-dot working"></span><span class="agent-status-text">' + this.escapeHtml(label) + '</span><span class="agent-status-timer" id="agent-timer">0s</span>';
      if (this.agentStatusTimer) clearInterval(this.agentStatusTimer);
      this.agentStatusTimer = setInterval(() => {
        const el = document.getElementById('agent-timer');
        if (el && this.agentStartTime) {
          const secs = Math.floor((Date.now() - this.agentStartTime) / 1000);
          el.textContent = secs < 60 ? secs + 's' : Math.floor(secs/60) + 'm ' + (secs%60) + 's';
        }
      }, 1000);
    } else if (status === 'queued') {
      indicator.className = 'agent-status queued';
      indicator.innerHTML = '<span class="agent-status-dot queued"></span><span class="agent-status-text">Queued (' + (data?.queueLength || 1) + ' pending)</span>';
    } else {
      this.agentStartTime = null;
      if (this.agentStatusTimer) { clearInterval(this.agentStatusTimer); this.agentStatusTimer = null; }
      indicator.className = 'agent-status idle';
      indicator.innerHTML = '<span class="agent-status-dot idle"></span><span class="agent-status-text">Ready</span>';
    }
  },

  toggleNotifications() {
    this.notificationPanelOpen = !this.notificationPanelOpen;
    var panel = document.getElementById('notification-panel');
    panel.style.display = this.notificationPanelOpen ? '' : 'none';
    if (this.notificationPanelOpen) {
      this.loadNotifications();
    }
  },

  async loadNotifications() {
    var list = document.getElementById('notification-list');
    try {
      var data = await this.fetch('/api/notifications');
      if (!data.notifications || data.notifications.length === 0) {
        list.innerHTML = '<div class="notification-empty">No notifications</div>';
        return;
      }

      list.innerHTML = data.notifications.slice().reverse().slice(0, 20).map(function(n) {
        var icon = { routine: 'clock', reminder: 'bell', system: 'alert', milestone: 'star', alert: 'alert', suggestion: 'lightbulb' };
        var priorityClass = n.priority === 'high' ? ' notification-high' : (n.priority === 'low' ? ' notification-low' : '');
        var readClass = n.read ? ' notification-read' : '';
        var timeAgo = App.relativeTime(n.createdAt);
        var actionHtml = n.action ? ' <button class="notification-action-btn" onclick="event.stopPropagation();App.runNotificationAction(&#39;' + App.escapeHtml(n.action.command) + '&#39;)">' + App.escapeHtml(n.action.label) + '</button>' : '';
        return '<div class="notification-card' + priorityClass + readClass + '" onclick="App.dismissNotification(&#39;' + n.id + '&#39;)">' +
          '<div class="notification-card-title">' + App.escapeHtml(n.title) + '</div>' +
          '<div class="notification-card-msg">' + App.escapeHtml(n.message).substring(0, 120) + actionHtml + '</div>' +
          '<div class="notification-card-time">' + App.escapeHtml(timeAgo) + '</div>' +
        '</div>';
      }).join('');
    } catch (err) {
      list.innerHTML = '<div class="notification-empty">Error loading</div>';
    }
  },

  async dismissNotification(id) {
    try {
      await apiFetch('/api/notifications/' + id + '/dismiss', { method: 'POST' });
      this.loadNotifications();
      this.pollNotifications();
    } catch (err) {}
  },

  async dismissAllNotifications() {
    try {
      await apiFetch('/api/notifications/dismiss-all', { method: 'POST' });
      this.loadNotifications();
      this.pollNotifications();
      this.notificationPanelOpen = false;
      document.getElementById('notification-panel').style.display = 'none';
    } catch (err) {}
  },

  runNotificationAction(command) {
    // Navigate to chat and send the command
    window.location.hash = 'chat';
    var input = document.getElementById('chat-input');
    if (input) {
      input.value = command;
      input.focus();
    }
    this.notificationPanelOpen = false;
    document.getElementById('notification-panel').style.display = 'none';
  },

  // ===========================================================
  // MEMORY & PROFILE
  // ===========================================================

  memoryLoaded: false,
  currentMemoryFile: null,

  async initMemory() {
    if (this.memoryLoaded) return;
    this.memoryLoaded = true;
    await this.loadProfile();
    await this.loadMemoryFiles();
  },

  async loadProfile() {
    var editor = document.getElementById('profile-editor');
    try {
      var data = await this.fetch('/api/profile');
      var p = data.profile;
      var prefs = p.preferences || {};

      var fields = [
        { key: 'name', label: 'Name', value: prefs.name || '', type: 'text' },
        { key: 'timezone', label: 'Timezone', value: prefs.timezone || '', type: 'text', placeholder: 'e.g., America/New_York' },
        { key: 'writingStyle', label: 'Writing Style', value: prefs.writingStyle || '', type: 'select', options: ['', 'formal', 'casual', 'professional', 'friendly'] },
        { key: 'verbosity', label: 'Verbosity', value: prefs.verbosity || '', type: 'select', options: ['', 'concise', 'normal', 'detailed'] },
        { key: 'language', label: 'Language', value: prefs.language || '', type: 'text', placeholder: 'e.g., English' },
        { key: 'interests', label: 'Interests', value: (prefs.interests || []).join(', '), type: 'text', placeholder: 'comma-separated' },
      ];

      var html = fields.map(function(f) {
        var input;
        if (f.type === 'select') {
          var opts = f.options.map(function(o) {
            return '<option value="' + App.escapeHtml(o) + '"' + (o === f.value ? ' selected' : '') + '>' + App.escapeHtml(o || '(auto)') + '</option>';
          }).join('');
          input = '<select class="tool-select profile-input" data-key="' + f.key + '">' + opts + '</select>';
        } else {
          input = '<input type="text" class="tool-input profile-input" data-key="' + f.key + '" value="' + App.escapeHtml(f.value) + '" placeholder="' + App.escapeHtml(f.placeholder || '') + '" />';
        }
        return '<div class="profile-field"><label class="tool-label">' + App.escapeHtml(f.label) + '</label>' + input + '</div>';
      }).join('');

      html += '<button class="btn-action" style="margin-top:10px" onclick="App.saveProfile()">Save Profile</button>';
      html += '<div id="profile-status" class="memory-status"></div>';

      // Show stats
      var actions = Object.entries(p.commonActions || {}).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5);
      if (actions.length > 0) {
        html += '<div class="profile-stats"><span class="memory-heading" style="margin-top:12px;display:block">Activity</span>';
        html += actions.map(function(a) {
          return '<span class="stat-chip"><strong>' + a[1] + '</strong> ' + App.escapeHtml(a[0]) + '</span>';
        }).join(' ');
        html += '</div>';
      }

      if (p.connectedServices && p.connectedServices.length > 0) {
        html += '<div class="profile-stats"><span class="memory-heading" style="margin-top:8px;display:block">Connected Services</span>';
        html += p.connectedServices.map(function(s) {
          return '<span class="stat-chip">' + App.escapeHtml(s) + '</span>';
        }).join(' ');
        html += '</div>';
      }

      editor.innerHTML = html;
    } catch (err) {
      editor.innerHTML = '<span class="cmd-error">Error loading profile: ' + App.escapeHtml(err.message) + '</span>';
    }
  },

  async saveProfile() {
    var inputs = document.querySelectorAll('.profile-input');
    var prefs = {};
    for (var i = 0; i < inputs.length; i++) {
      var key = inputs[i].getAttribute('data-key');
      var val = inputs[i].value.trim();
      if (key === 'interests' && val) {
        prefs[key] = val.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
      } else if (val) {
        prefs[key] = val;
      }
    }

    var status = document.getElementById('profile-status');
    try {
      await apiFetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: prefs }),
      });
      status.textContent = 'Profile saved!';
      status.className = 'memory-status success';
      setTimeout(function() { status.textContent = ''; }, 2000);
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
      status.className = 'memory-status error';
    }
  },

  async loadMemoryFiles() {
    var container = document.getElementById('memory-files');
    try {
      var data = await this.fetch('/api/memory');
      if (!data.files || data.files.length === 0) {
        container.innerHTML = '<p class="workflow-no-fields">No memory files yet. Memory is created automatically as you use CodeBot.</p>';
        return;
      }

      container.innerHTML = data.files.map(function(f) {
        var sizeStr = f.size > 1024 ? (f.size / 1024).toFixed(1) + ' KB' : f.size + ' B';
        return '<div class="memory-file-card" onclick="App.openMemoryEditor(&#39;' + App.escapeHtml(f.scope) + '&#39;, &#39;' + App.escapeHtml(f.file) + '&#39;)">' +
          '<span class="memory-file-name">' + App.escapeHtml(f.file) + '</span>' +
          '<span class="memory-file-meta">' + App.escapeHtml(f.scope) + ' &middot; ' + sizeStr + '</span>' +
        '</div>';
      }).join('');
    } catch (err) {
      container.innerHTML = '<span class="cmd-error">Error: ' + App.escapeHtml(err.message) + '</span>';
    }
  },

  async openMemoryEditor(scope, file) {
    var sections = document.querySelectorAll('#panel-memory .memory-section');
    var editor = document.getElementById('memory-editor');
    for (var i = 0; i < sections.length; i++) sections[i].style.display = 'none';
    editor.style.display = '';

    document.getElementById('memory-editor-title').textContent = file + ' (' + scope + ')';
    document.getElementById('memory-editor-content').value = 'Loading...';
    this.currentMemoryFile = { scope: scope, file: file };

    try {
      var data = await this.fetch('/api/memory/' + encodeURIComponent(scope) + '/' + encodeURIComponent(file));
      document.getElementById('memory-editor-content').value = data.content || '';
    } catch (err) {
      document.getElementById('memory-editor-content').value = 'Error: ' + err.message;
    }
  },

  closeMemoryEditor() {
    var sections = document.querySelectorAll('#panel-memory .memory-section');
    var editor = document.getElementById('memory-editor');
    for (var i = 0; i < sections.length; i++) sections[i].style.display = '';
    editor.style.display = 'none';
    this.currentMemoryFile = null;
  },

  async saveMemoryFile() {
    if (!this.currentMemoryFile) return;
    var content = document.getElementById('memory-editor-content').value;
    var status = document.getElementById('memory-editor-status');

    try {
      await apiFetch('/api/memory/' + encodeURIComponent(this.currentMemoryFile.scope) + '/' + encodeURIComponent(this.currentMemoryFile.file), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content }),
      });
      status.textContent = 'Saved!';
      status.className = 'memory-status success';
      setTimeout(function() { status.textContent = ''; }, 2000);
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
      status.className = 'memory-status error';
    }
  },

  // ===========================================================
  // WORKFLOWS
  // ===========================================================

  workflowsLoaded: false,
  workflowsData: null,
  currentWorkflow: null,

  async initWorkflows() {
    if (this.workflowsLoaded) return;
    this.workflowsLoaded = true;
    await this.loadWorkflows();
  },

  async loadWorkflows() {
    var grid = document.getElementById('workflow-grid');
    var cats = document.getElementById('workflow-categories');
    grid.innerHTML = this.renderLoading();

    try {
      var data = await this.fetch('/api/workflows');
      this.workflowsData = data.workflows;

      // Category filter chips
      var catHtml = '<button class="category-chip active" data-cat="all" onclick="App.filterWorkflows(&#39;all&#39;)">All</button>';
      var seenCats = {};
      for (var i = 0; i < data.workflows.length; i++) {
        var cat = data.workflows[i].category;
        if (!seenCats[cat] && data.categories[cat]) {
          seenCats[cat] = true;
          catHtml += '<button class="category-chip" data-cat="' + App.escapeHtml(cat) + '" onclick="App.filterWorkflows(&#39;' + App.escapeHtml(cat) + '&#39;)">' + App.escapeHtml(data.categories[cat].label) + '</button>';
        }
      }
      cats.innerHTML = catHtml;

      this.renderWorkflowGrid(data.workflows);
    } catch (err) {
      grid.innerHTML = this.renderEmpty('Error loading workflows', err.message || 'Check server');
    }
  },

  renderWorkflowGrid(workflows) {
    var grid = document.getElementById('workflow-grid');
    if (!workflows || workflows.length === 0) {
      grid.innerHTML = this.renderEmpty('No workflows', 'Add workflows in ~/.codebot/workflows/');
      return;
    }

    var icons = {
      send: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
      list: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
      search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
      image: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
      git: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>',
      globe: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
      clipboard: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
      edit: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    };

    grid.innerHTML = workflows.map(function(wf) {
      var icon = icons[wf.icon] || icons.clipboard;
      return '<div class="workflow-card" data-category="' + App.escapeHtml(wf.category) + '" onclick="App.openWorkflowRunner(&#39;' + App.escapeHtml(wf.name) + '&#39;)" style="--wf-color: ' + App.escapeHtml(wf.color) + '">' +
        '<div class="workflow-card-icon">' + icon + '</div>' +
        '<div class="workflow-card-name">' + App.escapeHtml(wf.description) + '</div>' +
        '<span class="workflow-card-cat">' + App.escapeHtml(wf.category) + '</span>' +
      '</div>';
    }).join('');
  },

  filterWorkflows(cat) {
    // Update active chip
    document.querySelectorAll('.category-chip').forEach(function(c) {
      c.classList.toggle('active', c.getAttribute('data-cat') === cat);
    });

    if (cat === 'all') {
      this.renderWorkflowGrid(this.workflowsData);
      return;
    }

    var filtered = (this.workflowsData || []).filter(function(wf) { return wf.category === cat; });
    this.renderWorkflowGrid(filtered);
  },

  openWorkflowRunner(name) {
    var wf = (this.workflowsData || []).find(function(w) { return w.name === name; });
    if (!wf) return;

    this.currentWorkflow = wf;

    var grid = document.getElementById('workflow-grid');
    var cats = document.getElementById('workflow-categories');
    var runner = document.getElementById('workflow-runner');
    var output = document.getElementById('workflow-output');

    grid.style.display = 'none';
    cats.style.display = 'none';
    runner.style.display = '';
    output.textContent = '';

    document.getElementById('workflow-runner-title').textContent = wf.description;
    document.getElementById('workflow-runner-desc').textContent = 'Category: ' + wf.category;

    var fieldsEl = document.getElementById('workflow-fields');

    if (!wf.inputFields || wf.inputFields.length === 0) {
      fieldsEl.innerHTML = '<p class="workflow-no-fields">This workflow has no input fields. Click Run to execute.</p>';
      return;
    }

    fieldsEl.innerHTML = wf.inputFields.map(function(f) {
      var inputHtml;
      if (f.type === 'textarea') {
        inputHtml = '<textarea class="tool-input workflow-input" name="' + App.escapeHtml(f.name) + '" placeholder="' + App.escapeHtml(f.placeholder || '') + '" ' + (f.required ? 'required' : '') + '>' + App.escapeHtml(f.default || '') + '</textarea>';
      } else if (f.type === 'select') {
        var opts = (f.options || []).map(function(o) {
          var sel = o === f.default ? ' selected' : '';
          return '<option value="' + App.escapeHtml(o) + '"' + sel + '>' + App.escapeHtml(o) + '</option>';
        }).join('');
        inputHtml = '<select class="tool-select workflow-input" name="' + App.escapeHtml(f.name) + '">' + opts + '</select>';
      } else {
        inputHtml = '<input type="' + (f.type === 'number' ? 'number' : 'text') + '" class="tool-input workflow-input" name="' + App.escapeHtml(f.name) + '" placeholder="' + App.escapeHtml(f.placeholder || '') + '" value="' + App.escapeHtml(f.default || '') + '" ' + (f.required ? 'required' : '') + ' />';
      }
      return '<div class="tool-field">' +
        '<label class="tool-label">' + App.escapeHtml(f.label) + (f.required ? ' *' : '') + '</label>' +
        inputHtml +
      '</div>';
    }).join('');
  },

  closeWorkflowRunner() {
    var grid = document.getElementById('workflow-grid');
    var cats = document.getElementById('workflow-categories');
    var runner = document.getElementById('workflow-runner');
    grid.style.display = '';
    cats.style.display = '';
    runner.style.display = 'none';
    this.currentWorkflow = null;
  },

  async submitWorkflow(e) {
    e.preventDefault();
    if (!this.currentWorkflow) return;

    var inputs = {};
    var fields = document.querySelectorAll('#workflow-fields .workflow-input');
    for (var i = 0; i < fields.length; i++) {
      inputs[fields[i].name] = fields[i].value;
    }

    var output = document.getElementById('workflow-output');
    var runBtn = document.getElementById('workflow-run-btn');
    output.textContent = 'Running...';
    runBtn.disabled = true;

    try {
      var res = await apiFetch('/api/workflows/' + encodeURIComponent(this.currentWorkflow.name) + '/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(inputs),
      });

      if (!res.ok) {
        var errData = await res.json().catch(function() { return {}; });
        output.innerHTML = '<span class="cmd-error">' + App.escapeHtml(errData.error || 'HTTP ' + res.status) + '</span>';
        runBtn.disabled = false;
        return;
      }

      // Stream SSE output
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var fullText = '';
      output.textContent = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (var j = 0; j < lines.length; j++) {
          var line = lines[j];
          if (!line.startsWith('data: ')) continue;
          var payload = line.slice(6);
          if (payload === '[DONE]') break;
          try {
            var ev = JSON.parse(payload);
            if (ev.type === 'text') {
              fullText += ev.text || '';
              output.innerHTML = App.renderMarkdown(fullText);
              output.scrollTop = output.scrollHeight;
            } else if (ev.type === 'tool_call' && ev.toolCall) {
              fullText += '\n[Tool: ' + ev.toolCall.name + ']\n';
              output.innerHTML = App.renderMarkdown(fullText);
            } else if (ev.type === 'error') {
              fullText += '\n**Error:** ' + (ev.text || ev.error || 'unknown') + '\n';
              output.innerHTML = App.renderMarkdown(fullText);
            }
          } catch (parseErr) {}
        }
      }

      if (!fullText) output.textContent = '(no output)';
    } catch (err) {
      output.innerHTML = '<span class="cmd-error">Error: ' + App.escapeHtml(err.message) + '</span>';
    } finally {
      runBtn.disabled = false;
    }
  },

  // ===========================================================
  // SESSIONS
  // ===========================================================

  sessionSearchBound: false,

  async loadSessions(searchQuery) {
    const container = document.getElementById('sessions-list');
    const detail = document.getElementById('session-detail');
    const stats = document.getElementById('session-stats');
    const searchRow = document.querySelector('.session-search-row');
    detail.style.display = 'none';
    container.style.display = '';
    if (searchRow) searchRow.style.display = '';
    container.innerHTML = this.renderLoading();

    // Wire up search with debounce (once)
    if (!this.sessionSearchBound) {
      this.sessionSearchBound = true;
      var searchInput = document.getElementById('session-search');
      if (searchInput) {
        var debounceTimer;
        searchInput.addEventListener('input', function() {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(function() {
            App.loadSessions(searchInput.value.trim());
          }, 300);
        });
      }
    }

    try {
      var q = searchQuery ? '&q=' + encodeURIComponent(searchQuery) : '';
      const data = await this.fetch('/api/sessions?limit=50' + q);
      this.sessionCount = data.total;

      stats.innerHTML = '<span class="stat-chip"><strong>' + data.total + '</strong> sessions</span>' +
        (data.hasMore ? '<span class="stat-chip">showing latest 50</span>' : '') +
        (data.sessions.length > 0 ? '<button class="btn-select-mode" onclick="App.toggleSelectMode()">' +
          (this.selectMode ? 'Cancel' : 'Select') + '</button>' : '');

      if (data.sessions.length === 0) {
        container.innerHTML = this.renderEmpty(
          searchQuery ? 'No matching sessions' : 'No sessions yet',
          searchQuery ? 'Try a different search term' : 'Start a CodeBot session to see conversations here'
        );
        return;
      }

      // Batch action bar (shown in select mode)
      var batchBar = '';
      if (this.selectMode) {
        batchBar = '<div class="batch-bar">' +
          '<label class="batch-select-all"><input type="checkbox" id="select-all-cb" onchange="App.toggleSelectAll(this.checked)" /> Select All</label>' +
          '<button class="btn-delete batch-delete-btn" onclick="App.deleteSelected()" disabled id="batch-delete-btn">Delete Selected</button>' +
        '</div>';
      }

      container.innerHTML = batchBar + data.sessions.map(function(s) {
        var date = s.modifiedAt ? App.relativeTime(s.modifiedAt) : 'Unknown';
        var fullDate = s.modifiedAt ? new Date(s.modifiedAt).toLocaleString() : '';
        var title = s.preview || s.id.substring(0, 16) + '...';
        var modelBadge = s.model ? '<span class="card-model">' + App.escapeHtml(s.model) + '</span>' : '';

        var checkbox = App.selectMode
          ? '<input type="checkbox" class="card-checkbox" data-id="' + App.escapeHtml(s.id) + '" onchange="App.updateBatchCount()" onclick="event.stopPropagation()" />'
          : '';
        var deleteBtn = App.selectMode
          ? ''
          : '<button class="card-delete-btn" onclick="event.stopPropagation();App.deleteSession(\'' + App.escapeHtml(s.id) + '\')" title="Delete session">&times;</button>';

        return '<div class="card session-card' + (App.selectMode ? ' selectable' : '') + '">' +
          deleteBtn + checkbox +
          '<div class="card-body" onclick="' + (App.selectMode
            ? 'App.toggleCardCheckbox(this.parentElement)'
            : 'App.loadSessionDetail(\'' + App.escapeHtml(s.id) + '\')') + '">' +
            '<div class="card-preview">' + App.escapeHtml(App.truncate(title, 60)) + '</div>' +
            '<div class="card-meta">' +
              '<span class="card-msg-count">' + (s.messageCount || 0) + ' msgs</span>' +
              '<span class="card-date" title="' + App.escapeHtml(fullDate) + '">' + App.escapeHtml(date) + '</span>' +
              modelBadge +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    } catch {
      container.innerHTML = this.renderEmpty('Error loading sessions', 'Check that the server is running');
    }
  },

  async loadSessionDetail(id) {
    const container = document.getElementById('sessions-list');
    const searchRow = document.querySelector('.session-search-row');
    const detail = document.getElementById('session-detail');
    container.style.display = 'none';
    if (searchRow) searchRow.style.display = 'none';
    detail.style.display = '';
    detail.innerHTML = this.renderLoading();

    try {
      const data = await this.fetch('/api/sessions/' + encodeURIComponent(id));
      const title = data.preview || data.id.substring(0, 16) + '...';

      detail.innerHTML = '<div class="detail-top"><div>' +
        '<div class="detail-title">' + this.escapeHtml(this.truncate(title, 80)) + '</div>' +
        '<div class="detail-meta"><span>' + data.messageCount + ' messages</span><span>' + data.toolCallCount + ' tool calls</span></div>' +
        '</div><div class="detail-actions">' +
        '<button class="btn-continue" onclick="App.resumeSession(\'' + this.escapeHtml(id) + '\')">Continue Session</button>' +
        '<button class="btn-delete" onclick="App.deleteSession(\'' + this.escapeHtml(id) + '\')">Delete</button>' +
        '<button class="btn-back" onclick="App.loadSessions()">Back</button>' +
        '</div></div>' +
        '<div class="message-list">' +
          data.messages.map(function(m) {
            var content = App.extractContent(m);
            var rendered = m.role === 'assistant'
              ? App.renderMarkdown(App.truncate(content, 1000))
              : App.escapeHtml(App.truncate(content, 1000));
            return '<div class="message ' + App.escapeHtml(m.role) + '">' +
              '<div class="message-role">' + App.escapeHtml(m.role) + '</div>' +
              '<div class="message-content">' + rendered + '</div></div>';
          }).join('') +
        '</div>';
    } catch {
      detail.innerHTML = this.renderEmpty('Error loading session', '');
    }
  },

  async resumeSession(sessionId) {
    try {
      var res = await apiFetch('/api/command/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId }),
      });

      if (!res.ok) {
        var err = await res.json().catch(function() { return {}; });
        alert('Failed to resume: ' + (err.error || 'Unknown error'));
        return;
      }

      var data = await res.json();

      // Switch to chat panel
      window.location.hash = 'chat';

      // Clear current chat and load history
      var chatContainer = document.getElementById('chat-messages');
      chatContainer.innerHTML = '';

      var history = await this.fetch('/api/command/history');
      if (history.messages && history.messages.length > 0) {
        var showCount = Math.min(history.messages.length, 20);
        var recentMessages = history.messages.slice(-showCount);
        for (var i = 0; i < recentMessages.length; i++) {
          var m = recentMessages[i];
          this.appendChatMessage(m.role, typeof m.content === 'string' ? m.content : String(m.content));
        }
      }

      // Add resume indicator
      var indicator = document.createElement('div');
      indicator.className = 'chat-msg system';
      indicator.innerHTML = '<div class="chat-msg-content" style="color:var(--text-muted);font-size:11px;text-align:center">' +
        'Session resumed (' + data.messageCount + ' messages loaded). Continue the conversation below.' +
      '</div>';
      chatContainer.appendChild(indicator);
      chatContainer.scrollTop = chatContainer.scrollHeight;

      // Expand chat layout (keep existing listeners, don't re-init)
      var logoArea = document.getElementById('logo-area');
      if (logoArea) logoArea.classList.add('faded');
      document.body.classList.add('chat-expanded');
    } catch (err) {
      alert('Resume failed: ' + err.message);
    }
  },

  async deleteSession(sessionId) {
    if (!confirm('Delete this session? This cannot be undone.')) return;
    try {
      var res = await apiFetch('/api/sessions/' + encodeURIComponent(sessionId), {
        method: 'DELETE',
      });
      if (!res.ok) {
        var err = await res.json().catch(function() { return {}; });
        alert('Delete failed: ' + (err.error || 'Unknown error'));
        return;
      }
      // Go back to session list
      this.loadSessions(document.getElementById('session-search') ? document.getElementById('session-search').value.trim() : '');
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  },

  selectMode: false,

  toggleSelectMode() {
    this.selectMode = !this.selectMode;
    this.loadSessions(document.getElementById('session-search') ? document.getElementById('session-search').value.trim() : '');
  },

  toggleCardCheckbox(card) {
    var cb = card.querySelector('.card-checkbox');
    if (cb) {
      cb.checked = !cb.checked;
      this.updateBatchCount();
    }
  },

  toggleSelectAll(checked) {
    document.querySelectorAll('.card-checkbox').forEach(function(cb) {
      cb.checked = checked;
    });
    this.updateBatchCount();
  },

  updateBatchCount() {
    var checked = document.querySelectorAll('.card-checkbox:checked');
    var btn = document.getElementById('batch-delete-btn');
    if (btn) {
      btn.disabled = checked.length === 0;
      btn.textContent = checked.length > 0 ? 'Delete ' + checked.length + ' Selected' : 'Delete Selected';
    }
  },

  async deleteSelected() {
    var checked = document.querySelectorAll('.card-checkbox:checked');
    var ids = [];
    checked.forEach(function(cb) { ids.push(cb.dataset.id); });
    if (ids.length === 0) return;
    if (!confirm('Delete ' + ids.length + ' session' + (ids.length > 1 ? 's' : '') + '? This cannot be undone.')) return;

    try {
      var res = await apiFetch('/api/sessions/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids }),
      });
      if (!res.ok) {
        var err = await res.json().catch(function() { return {}; });
        alert('Batch delete failed: ' + (err.error || 'Unknown error'));
        return;
      }
      var data = await res.json();
      this.selectMode = false;
      this.loadSessions(document.getElementById('session-search') ? document.getElementById('session-search').value.trim() : '');
    } catch (err) {
      alert('Batch delete failed: ' + err.message);
    }
  },

  // ===========================================================
  // TERMINAL
  // ===========================================================

  termInitialized: false,

  initTerminal() {
    if (this.termInitialized) return;
    this.termInitialized = true;

    const input = document.getElementById('terminal-input');
    this.terminalHistory = [];
    this.terminalHistoryIndex = -1;

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const cmd = input.value.trim();
        if (!cmd) return;
        App.terminalHistory.push(cmd);
        App.terminalHistoryIndex = App.terminalHistory.length;
        input.value = '';
        App.runTerminalCommand(cmd);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (App.terminalHistoryIndex > 0) {
          App.terminalHistoryIndex--;
          input.value = App.terminalHistory[App.terminalHistoryIndex];
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (App.terminalHistoryIndex < App.terminalHistory.length - 1) {
          App.terminalHistoryIndex++;
          input.value = App.terminalHistory[App.terminalHistoryIndex];
        } else {
          App.terminalHistoryIndex = App.terminalHistory.length;
          input.value = '';
        }
      }
    });
  },

  async runTerminalCommand(cmd) {
    const output = document.getElementById('terminal-output');
    const cmdLine = document.createElement('div');
    cmdLine.className = 'terminal-line cmd';
    cmdLine.textContent = '$ ' + cmd;
    output.appendChild(cmdLine);

    const resultBlock = document.createElement('div');
    resultBlock.className = 'terminal-line result';
    output.appendChild(resultBlock);
    output.scrollTop = output.scrollHeight;

    // Risk badge
    const riskLevel = this.getRiskLevel('execute', { command: cmd });
    if (riskLevel !== 'low') {
      const badge = document.createElement('span');
      badge.className = 'risk-badge risk-' + riskLevel;
      badge.textContent = riskLevel.toUpperCase();
      badge.style.marginLeft = '8px';
      cmdLine.appendChild(badge);
    }

    try {
      const res = await apiFetch('/api/command/exec', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });
      if (!res.ok) {
        const errD = await res.json().catch(() => ({}));
        resultBlock.textContent = 'Error: ' + (errD.error || 'HTTP ' + res.status);
        resultBlock.classList.add('error');
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') break;
          try {
            const ev = JSON.parse(payload);
            if (ev.type === 'stdout' || ev.type === 'stderr') {
              resultBlock.textContent += ev.text || '';
              if (ev.type === 'stderr') resultBlock.classList.add('error');
            }
            else if (ev.type === 'exit') {
              if (ev.code !== 0) {
                resultBlock.classList.add('error');
                resultBlock.textContent += '\n[exit code: ' + ev.code + ']';
              }
            }
          } catch(e) {}
        }
      }
    } catch (err) {
      resultBlock.textContent = 'Error: ' + err.message;
      resultBlock.classList.add('error');
    }
    output.scrollTop = output.scrollHeight;
  },

  // ===========================================================
  // TOOLS (Quick Actions + Tool Runner)
  // ===========================================================

  toolsInitialized: false,

  initTools() {
    if (this.toolsInitialized) return;
    this.toolsInitialized = true;

    // Quick actions
    document.querySelectorAll('.quick-btn').forEach(btn => {
      btn.addEventListener('click', () => App.runQuickAction(btn.dataset.action));
    });

    // Tool runner - wire up listeners unconditionally, load list when connected
    var toolSelect = document.getElementById('tool-select');
    var toolRunBtn = document.getElementById('tool-run-btn');
    if (toolSelect) toolSelect.addEventListener('change', (e) => App.onToolSelected(e.target.value));
    if (toolRunBtn) toolRunBtn.addEventListener('click', () => App.executeSelectedTool());

    // Load tool list (retries if agent not yet connected)
    var self = this;
    function tryLoadTools() {
      if (self.agentConnected) {
        self.loadToolList();
      } else {
        setTimeout(tryLoadTools, 2000);
      }
    }
    tryLoadTools();
  },

  async runQuickAction(action) {
    const output = document.getElementById('quick-output');
    output.style.display = '';
    output.textContent = 'Running...';

    try {
      const res = await apiFetch('/api/command/quick-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action }),
      });
      if (!res.ok) {
        const errD = await res.json().catch(() => ({}));
        output.textContent = 'Error: ' + (errD.error || 'HTTP ' + res.status);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', fullText = '';
      output.textContent = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') break;
          try {
            const ev = JSON.parse(payload);
            if (ev.type === 'text' || ev.type === 'stdout' || ev.type === 'stderr') {
              fullText += ev.text || '';
              output.textContent = fullText;
            }
            else if (ev.type === 'tool_result' && ev.toolResult) {
              fullText += '\n' + (ev.toolResult.result || '');
              output.textContent = fullText;
            }
          } catch(e) {}
        }
      }
      if (!fullText) output.textContent = '(no output)';
    } catch (err) {
      output.textContent = 'Error: ' + err.message;
    }
  },

  async loadToolList() {
    try {
      const data = await this.fetch('/api/command/tools');
      const select = document.getElementById('tool-select');
      this.toolsData = data.tools;
      const sorted = data.tools.slice().sort((a, b) => a.name.localeCompare(b.name));
      for (let i = 0; i < sorted.length; i++) {
        const opt = document.createElement('option');
        opt.value = sorted[i].name;
        opt.textContent = sorted[i].name;
        select.appendChild(opt);
      }
    } catch {}
  },

  onToolSelected(toolName) {
    let tool = null;
    if (this.toolsData) {
      for (let i = 0; i < this.toolsData.length; i++) {
        if (this.toolsData[i].name === toolName) { tool = this.toolsData[i]; break; }
      }
    }
    const descEl = document.getElementById('tool-description');
    const formEl = document.getElementById('tool-form');
    const runBtn = document.getElementById('tool-run-btn');
    const resultEl = document.getElementById('tool-result');
    resultEl.innerHTML = '';
    resultEl.style.display = 'none';
    if (!tool) { descEl.textContent = ''; formEl.innerHTML = ''; runBtn.disabled = true; return; }
    descEl.textContent = tool.description;
    runBtn.disabled = false;
    const props = tool.parameters && tool.parameters.properties ? tool.parameters.properties : {};
    const required = tool.parameters && tool.parameters.required ? tool.parameters.required : [];
    let html = '';
    const keys = Object.keys(props);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i], schema = props[key], isReq = required.indexOf(key) >= 0, desc = schema.description || '', type = schema.type || 'string';
      if (type === 'boolean') {
        html += '<div class="tool-field"><label class="tool-label"><input type="checkbox" name="' + this.escapeHtml(key) + '" class="tool-checkbox" />' + this.escapeHtml(key) + (isReq ? ' *' : '') + '</label><div class="tool-field-desc">' + this.escapeHtml(desc) + '</div></div>';
      } else {
        const it = type === 'number' ? 'number' : 'text';
        html += '<div class="tool-field"><label class="tool-label">' + this.escapeHtml(key) + (isReq ? ' *' : '') + '</label><input type="' + it + '" name="' + this.escapeHtml(key) + '" class="tool-input" placeholder="' + this.escapeHtml(desc) + '" /><div class="tool-field-desc">' + this.escapeHtml(desc) + '</div></div>';
      }
    }
    formEl.innerHTML = html;
  },

  async executeSelectedTool() {
    const toolName = document.getElementById('tool-select').value;
    if (!toolName) return;
    let tool = null;
    if (this.toolsData) {
      for (let i = 0; i < this.toolsData.length; i++) {
        if (this.toolsData[i].name === toolName) { tool = this.toolsData[i]; break; }
      }
    }
    if (!tool) return;
    const resultEl = document.getElementById('tool-result');
    resultEl.style.display = '';
    resultEl.innerHTML = this.renderLoading();
    const args = {};
    const props = tool.parameters && tool.parameters.properties ? tool.parameters.properties : {};
    const keys = Object.keys(props);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i], schema = props[key], input = document.querySelector('#tool-form [name="' + key + '"]');
      if (!input) continue;
      if (schema.type === 'boolean') { args[key] = input.checked; }
      else if (schema.type === 'number') { const v = input.value.trim(); if (v) args[key] = Number(v); }
      else { const v = input.value.trim(); if (v) args[key] = v; }
    }

    try {
      const res = await apiFetch('/api/command/tool/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: toolName, args: args })
      });
      const data = await res.json();
      if (data.is_error) {
        resultEl.innerHTML = '<div class="cmd-error">' + this.escapeHtml(data.result) + '</div>';
      } else {
        resultEl.innerHTML = '<pre class="cmd-success">' + this.escapeHtml(data.result) + '</pre><div class="cmd-meta">' + data.duration_ms + 'ms</div>';
      }
    } catch (err) {
      resultEl.innerHTML = '<div class="cmd-error">' + this.escapeHtml(err.message) + '</div>';
    }
  },




  // ===========================================================
  // RISK INDICATOR
  // ===========================================================

  getRiskLevel(toolName, args) {
    if (toolName !== 'execute') return 'low';
    let cmd = '';
    if (args && args.command) cmd = String(args.command).toLowerCase();
    if (!cmd) return 'low';
    if (/rm\s+-rf|mkfs|format\s+[a-z]:|dd\s+if=|>\s*\/dev\//.test(cmd)) return 'high';
    if (/\brm\b|\bsudo\b|\bchmod\b|\bchown\b|\bdocker\b|\bkill\b|\bpkill\b/.test(cmd)) return 'medium';
    return 'low';
  },

  getRiskClass(toolName, args) {
    return 'risk-' + this.getRiskLevel(toolName, args);
  },

  getRiskLabel(toolName, args) {
    const level = this.getRiskLevel(toolName, args);
    if (level === 'high') return 'HIGH';
    if (level === 'medium') return 'MED';
    return 'LOW';
  },

  // ===========================================================
  // MARKDOWN RENDERING
  // ===========================================================

  renderMarkdown(text) {
    if (!text) return '';
    let html = this.escapeHtml(text);

    // Code blocks with syntax highlighting
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function(match, lang, code) {
      var langClass = lang ? ' class="language-' + lang + '"' : '';
      var langLabel = lang ? '<span class="code-lang-label">' + lang + '</span>' : '';
      var copyBtn = '<button class="code-copy-btn" onclick="App.copyCode(this)">Copy</button>';
      return '<div class="code-block-wrapper">' + langLabel + copyBtn +
        '<pre><code' + langClass + '>' + code + '</code></pre></div>';
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

    // Headers
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Numbered lists
    html = html.replace(/^(\d+)\. (.+)$/gm, '<li class="numbered-li"><span class="li-num">$1.</span> $2</li>');

    // Bullet lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Horizontal rules
    html = html.replace(/^---$/gm, '<hr>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Line breaks
    html = html.replace(/\n/g, '<br>');

    // Clean up
    html = html.replace(/<\/pre><br>/g, '</pre>');
    html = html.replace(/<\/div><br>/g, '</div>');
    html = html.replace(/<\/h1><br>/g, '</h1>');
    html = html.replace(/<\/h2><br>/g, '</h2>');
    html = html.replace(/<\/h3><br>/g, '</h3>');
    html = html.replace(/<\/h4><br>/g, '</h4>');
    html = html.replace(/<\/li><br>/g, '</li>');
    html = html.replace(/<\/blockquote><br>/g, '</blockquote>');
    html = html.replace(/<hr><br>/g, '<hr>');

    return html;
  },

  copyCode(btn) {
    var code = btn.parentElement.querySelector('code');
    if (code) {
      navigator.clipboard.writeText(code.textContent).then(function() {
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
      });
    }
  },

  highlightAllCode() {
    if (typeof hljs !== 'undefined') {
      document.querySelectorAll('.code-block-wrapper pre code').forEach(function(el) {
        hljs.highlightElement(el);
      });
    }
  },

  // ===========================================================
  // HELPERS
  // ===========================================================

  async fetch(path) {
    const res = await apiFetch(path);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  },

  escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  truncate(str, max) {
    if (!str || str.length <= max) return str || '';
    return str.substring(0, max) + '\u2026';
  },

  extractContent(msg) {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content.map(c => c.text || c.content || '').join(' ');
    }
    return JSON.stringify(msg.content || '');
  },



  relativeTime(iso) {
    const now = Date.now();
    const then = new Date(iso).getTime();
    const diff = Math.floor((now - then) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString();
  },

  renderLoading() {
    return '<div class="loading-state"><div class="spinner"></div>Loading...</div>';
  },

  renderEmpty(title, desc) {
    return '<div class="empty-state"><div class="empty-title">' + this.escapeHtml(title) + '</div>' +
      (desc ? '<div class="empty-desc">' + this.escapeHtml(desc) + '</div>' : '') + '</div>';
  },  initPanelCodeagi() {
    this.codeagiSelectedMission = null;
    this.codeagiCurrentMemTab = 'reflections';
    this.loadCodeAGIMissions();
    this.loadCodeAGIWorkspace();
    this.setupCodeAGIListeners();
  },

  setupCodeAGIListeners() {
    var self = this;
    var createBtn = document.getElementById('codeagi-create-btn');
    var missionInput = document.getElementById('codeagi-mission-input');
    if (createBtn) {
      createBtn.onclick = function() { self.createCodeAGIMission(); };
      missionInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') self.createCodeAGIMission(); });
    }
    var addTaskBtn = document.getElementById('codeagi-add-task-btn');
    if (addTaskBtn) addTaskBtn.onclick = function() { self.addCodeAGITask(); };
    var runBtn = document.getElementById('codeagi-run-btn');
    if (runBtn) runBtn.onclick = function() { self.runCodeAGICycle(); };
    var streamBtn = document.getElementById('codeagi-stream-btn');
    if (streamBtn) streamBtn.onclick = function() { self.runCodeAGIStream(); };
    var refreshBtn = document.getElementById('codeagi-refresh-btn');
    if (refreshBtn) refreshBtn.onclick = function() { self.loadCodeAGIMissions(); self.loadCodeAGIWorkspace(); };
    document.querySelectorAll('.codeagi-tab').forEach(function(tab) {
      tab.onclick = function() {
        document.querySelectorAll('.codeagi-tab').forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        document.querySelectorAll('.codeagi-tab-content').forEach(function(c) { c.style.display = 'none'; c.classList.remove('active'); });
        var target = document.getElementById('codeagi-tab-' + tab.dataset.tab);
        if (target) { target.style.display = 'block'; target.classList.add('active'); }
        if (tab.dataset.tab === 'memory') self.loadCodeAGIMemory(self.codeagiCurrentMemTab);
        if (tab.dataset.tab === 'traces') self.loadCodeAGITraces();
      };
    });
    document.querySelectorAll('.codeagi-mem-tab').forEach(function(tab) {
      tab.onclick = function() {
        document.querySelectorAll('.codeagi-mem-tab').forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        self.codeagiCurrentMemTab = tab.dataset.mem;
        self.loadCodeAGIMemory(tab.dataset.mem);
      };
    });
  },

  async createCodeAGIMission() {
    var input = document.getElementById('codeagi-mission-input');
    var desc = input.value.trim();
    if (!desc) return;
    input.value = '';
    try {
      var res = await apiFetch('/api/codeagi/missions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: desc }) });
      var data = await res.json();
      this.loadCodeAGIMissions();
      if (data && data.id) this.codeagiSelectedMission = data.id;
    } catch (err) { console.error('Failed to create mission:', err); }
  },

  async addCodeAGITask() {
    if (!this.codeagiSelectedMission) return;
    var desc = document.getElementById('codeagi-task-desc').value.trim();
    if (!desc) return;
    var body = { mission_id: this.codeagiSelectedMission, description: desc, action_kind: document.getElementById('codeagi-task-kind').value || undefined, path: document.getElementById('codeagi-task-path').value || undefined, command: document.getElementById('codeagi-task-cmd').value || undefined };
    try {
      await apiFetch('/api/codeagi/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      document.getElementById('codeagi-task-desc').value = '';
      document.getElementById('codeagi-task-path').value = '';
      document.getElementById('codeagi-task-cmd').value = '';
      this.loadCodeAGIMissions();
    } catch (err) { console.error('Failed to create task:', err); }
  },

  async loadCodeAGIMissions() {
    var container = document.getElementById('codeagi-missions');
    if (!container) return;
    try {
      var res = await apiFetch('/api/codeagi/missions');
      var data = await res.json();
      var missions = Array.isArray(data.missions) ? data.missions : [];
      var tasks = Array.isArray(data.tasks) ? data.tasks : [];
      var self = this;
      if (missions.length === 0) { container.innerHTML = '<div class="hint-muted" style="padding:1rem;text-align:center">No missions yet. Create one above!</div>'; return; }
      missions.sort(function(a, b) { if (a.status === 'active' && b.status !== 'active') return -1; if (b.status === 'active' && a.status !== 'active') return 1; return (b.created_at || '').localeCompare(a.created_at || ''); });
      container.innerHTML = missions.map(function(m) {
        var mTasks = tasks.filter(function(t) { return t.mission_id === m.id; });
        var selected = self.codeagiSelectedMission === m.id ? ' selected' : '';
        return '<div class="codeagi-mission-card' + selected + '" data-mission-id="' + m.id + '">' +
          '<div class="codeagi-mission-header"><span class="codeagi-mission-id">' + m.id + '</span><span class="codeagi-mission-status ' + m.status + '">' + m.status + '</span></div>' +
          '<div class="codeagi-mission-desc">' + self.escapeHtml(m.description) + '</div>' +
          (mTasks.length > 0 ? '<div class="codeagi-mission-tasks">' + mTasks.map(function(t) {
            return '<div class="codeagi-task-item"><span class="codeagi-task-dot ' + t.status + '"></span><span>' + self.escapeHtml(t.description) + '</span>' + (t.action_kind ? '<span class="hint-muted">(' + t.action_kind + ')</span>' : '') + '</div>';
          }).join('') + '</div>' : '') + '</div>';
      }).join('');
      container.querySelectorAll('.codeagi-mission-card').forEach(function(card) {
        card.onclick = function() {
          self.codeagiSelectedMission = card.dataset.missionId;
          container.querySelectorAll('.codeagi-mission-card').forEach(function(c) { c.classList.remove('selected'); });
          card.classList.add('selected');
          var creator = document.getElementById('codeagi-task-creator');
          var label = document.getElementById('codeagi-task-mission-id');
          if (creator) creator.style.display = 'block';
          if (label) label.textContent = '(' + card.dataset.missionId + ')';
        };
      });
      var statusEl = document.getElementById('codeagi-status');
      if (statusEl) {
        var active = missions.filter(function(m) { return m.status === 'active'; }).length;
        var completed = missions.filter(function(m) { return m.status === 'completed'; }).length;
        statusEl.textContent = active + ' active \u00B7 ' + completed + ' completed \u00B7 ' + tasks.length + ' tasks';
      }
    } catch (err) { container.innerHTML = '<div class="hint-muted" style="padding:1rem">CodeAGI not available: ' + err.message + '</div>'; }
  },

  async runCodeAGICycle() {
    var runBtn = document.getElementById('codeagi-run-btn');
    var outputSection = document.getElementById('codeagi-cycle-output');
    var stepsEl = document.getElementById('codeagi-cycle-steps');
    if (!outputSection || !stepsEl) return;
    runBtn.disabled = true;
    runBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg> Running...';
    outputSection.style.display = 'block';
    stepsEl.innerHTML = '';
    var self = this;
    try {
      var res = await apiFetch('/api/codeagi/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ max_cycles: 1 }) });
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          if (!lines[i].startsWith('data: ')) continue;
          var payload = lines[i].slice(6);
          if (payload === '[DONE]') break;
          try { self.appendCodeAGIStep(stepsEl, JSON.parse(payload)); } catch(e) {}
        }
      }
    } catch (err) { self.appendCodeAGIStep(stepsEl, { type: 'error', text: err.message }); }
    finally {
      runBtn.disabled = false;
      runBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run Cycle';
      self.loadCodeAGIMissions();
      self.loadCodeAGIWorkspace();
    }
  },

  appendCodeAGIStep(container, ev) {
    var step = document.createElement('div');
    if (ev.type === 'cycle_data' && ev.data) {
      var d = ev.data;
      if (d.plan) { var s = document.createElement('div'); s.className = 'codeagi-step plan'; s.innerHTML = '<div class="codeagi-step-label">Plan</div><div>' + this.escapeHtml(JSON.stringify(d.plan.steps || d.plan, null, 1).substring(0, 300)) + '</div>'; container.appendChild(s); }
      if (d.verification) { var s = document.createElement('div'); s.className = 'codeagi-step verify'; s.innerHTML = '<div class="codeagi-step-label">Verify</div><div>' + this.escapeHtml(JSON.stringify(d.verification).substring(0, 200)) + '</div>'; container.appendChild(s); }
      if (d.critique) { var s = document.createElement('div'); s.className = 'codeagi-step critique'; s.innerHTML = '<div class="codeagi-step-label">Critique</div><div>' + this.escapeHtml(JSON.stringify(d.critique).substring(0, 200)) + '</div>'; container.appendChild(s); }
      if (d.action_outcome) { var s = document.createElement('div'); s.className = 'codeagi-step execute'; s.innerHTML = '<div class="codeagi-step-label">Execute</div><div>' + this.escapeHtml(d.action_outcome.summary || JSON.stringify(d.action_outcome).substring(0, 200)) + '</div>'; container.appendChild(s); }
      if (d.reflection) { var s = document.createElement('div'); s.className = 'codeagi-step reflect'; s.innerHTML = '<div class="codeagi-step-label">Reflect</div><div>' + this.escapeHtml(d.reflection.summary || JSON.stringify(d.reflection).substring(0, 200)) + '</div>'; container.appendChild(s); }
      if (d.status === 'idle' || (d.cycle_trace && d.cycle_trace.stop_reason)) { var s = document.createElement('div'); s.className = 'codeagi-step complete'; s.innerHTML = '<div class="codeagi-step-label">Done</div><div>' + this.escapeHtml(d.cycle_trace ? d.cycle_trace.stop_reason : d.status) + '</div>'; container.appendChild(s); }
      container.scrollTop = container.scrollHeight;
      return;
    }
    if (ev.type === 'text' || ev.type === 'log') { step.className = 'codeagi-step'; step.textContent = ev.text || ''; }
    else if (ev.type === 'status') { step.className = 'codeagi-step'; step.innerHTML = '<div class="codeagi-step-label">Status</div><div>' + this.escapeHtml(ev.text || '') + '</div>'; }
    else if (ev.type === 'complete') { step.className = 'codeagi-step complete'; step.innerHTML = '<div class="codeagi-step-label">Complete</div><div>' + this.escapeHtml(ev.text || '') + '</div>'; }
    else if (ev.type === 'error') { step.className = 'codeagi-step error'; step.innerHTML = '<div class="codeagi-step-label">Error</div><div>' + this.escapeHtml(ev.text || '') + '</div>'; }
    else { step.className = 'codeagi-step'; step.textContent = JSON.stringify(ev); }
    container.appendChild(step);
    container.scrollTop = container.scrollHeight;
  },

  async runCodeAGIStream() {
    var streamBtn = document.getElementById('codeagi-stream-btn');
    var phaseBar = document.getElementById('codeagi-phase-bar');
    var streamOutput = document.getElementById('codeagi-stream-output');
    var streamLog = document.getElementById('codeagi-stream-log');
    if (!phaseBar || !streamLog || !streamOutput) return;

    // Disable button
    streamBtn.disabled = true;
    streamBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg> Streaming...';

    // Show phase bar and stream output
    phaseBar.style.display = 'flex';
    streamOutput.style.display = 'block';
    streamLog.innerHTML = '';

    // Reset all badges to pending
    phaseBar.querySelectorAll('.codeagi-phase-badge').forEach(function(b) {
      b.className = 'codeagi-phase-badge pending';
    });

    var self = this;
    var abortController = new AbortController();

    try {
      var base = window.location.origin;
      var headers = {};
      if (window.__CODEBOT_TOKEN) headers['Authorization'] = 'Bearer ' + window.__CODEBOT_TOKEN;

      var res = await fetch(base + '/api/codeagi/run/stream?max_cycles=1', {
        headers: headers,
        signal: abortController.signal,
      });

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          if (!lines[i].startsWith('data: ')) continue;
          var payload = lines[i].slice(6);
          if (payload === '[DONE]') break;
          try {
            var ev = JSON.parse(payload);
            self.handleStreamEvent(phaseBar, streamLog, ev);
          } catch(e) {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        self.appendStreamLog(streamLog, 'error', err.message);
      }
    } finally {
      streamBtn.disabled = false;
      streamBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg> Stream Cycle';
      self.loadCodeAGIMissions();
      self.loadCodeAGIWorkspace();
    }
  },

  handleStreamEvent(phaseBar, streamLog, ev) {
    // Update phase badges
    if (ev.type === 'phase') {
      var badge = phaseBar.querySelector('[data-phase="' + ev.phase + '"]');
      if (badge) {
        badge.className = 'codeagi-phase-badge ' + ev.status;
      }
    }

    // Render log entries
    if (ev.type === 'phases_init') {
      this.appendStreamLog(streamLog, 'status', ev.text);
    } else if (ev.type === 'cycle_data' && ev.data) {
      this.appendCodeAGIStep(streamLog, ev);
    } else if (ev.type === 'log' || ev.type === 'stderr') {
      this.appendStreamLog(streamLog, ev.phase || 'log', ev.text);
    } else if (ev.type === 'complete') {
      this.appendStreamLog(streamLog, 'complete', ev.text);
    } else if (ev.type === 'error') {
      this.appendStreamLog(streamLog, 'error', ev.text);
    }
  },

  appendStreamLog(container, phase, text) {
    var entry = document.createElement('div');
    entry.className = 'codeagi-step ' + (phase || '');
    var label = phase ? '<div class="codeagi-step-label">' + this.escapeHtml(phase) + '</div>' : '';
    entry.innerHTML = label + '<div>' + this.escapeHtml(text || '') + '</div>';
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
  },


  async loadCodeAGIWorkspace(subdir) {
    var filesEl = document.getElementById('codeagi-workspace-files');
    var breadcrumb = document.getElementById('codeagi-workspace-path');
    var preview = document.getElementById('codeagi-file-preview');
    if (!filesEl) return;
    if (preview) preview.style.display = 'none';
    var p = subdir || '';
    if (breadcrumb) breadcrumb.textContent = '/' + p;
    try {
      var url = '/api/codeagi/workspace' + (p ? '?path=' + encodeURIComponent(p) : '');
      var res = await apiFetch(url);
      var data = await res.json();
      var files = data.files || [];
      var self = this;
      if (files.length === 0) { filesEl.innerHTML = '<div class="hint-muted" style="padding:0.5rem">Empty</div>'; return; }
      files.sort(function(a, b) { if (a.type === 'directory' && b.type !== 'directory') return -1; if (b.type === 'directory' && a.type !== 'directory') return 1; return a.name.localeCompare(b.name); });
      var entries = '';
      if (p) { var parent = p.split('/').slice(0, -1).join('/'); entries += '<div class="codeagi-file-item" data-action="dir" data-path="' + parent + '"><span class="codeagi-file-icon">&#11014;</span><span>..</span></div>'; }
      entries += files.map(function(f) {
        var icon = f.type === 'directory' ? '&#128193;' : '&#128196;';
        var fullPath = p ? p + '/' + f.name : f.name;
        var size = f.size != null ? self.formatFileSize(f.size) : '';
        return '<div class="codeagi-file-item" data-action="' + (f.type === 'directory' ? 'dir' : 'file') + '" data-path="' + fullPath + '"><span class="codeagi-file-icon">' + icon + '</span><span>' + f.name + '</span>' + (size ? '<span class="codeagi-file-size">' + size + '</span>' : '') + '</div>';
      }).join('');
      filesEl.innerHTML = entries;
      filesEl.querySelectorAll('.codeagi-file-item').forEach(function(item) {
        item.onclick = function() { item.dataset.action === 'dir' ? self.loadCodeAGIWorkspace(item.dataset.path) : self.previewCodeAGIFile(item.dataset.path); };
      });
    } catch (err) { filesEl.innerHTML = '<div class="hint-muted">Workspace not available</div>'; }
  },

  async previewCodeAGIFile(filePath) {
    var preview = document.getElementById('codeagi-file-preview');
    if (!preview) return;
    try {
      var res = await apiFetch('/api/codeagi/workspace/file?path=' + encodeURIComponent(filePath));
      var data = await res.json();
      preview.textContent = data.error ? 'Error: ' + data.error : (data.content || '(empty)');
      preview.style.display = 'block';
    } catch (err) { preview.textContent = 'Failed to load'; preview.style.display = 'block'; }
  },

  async loadCodeAGIMemory(type) {
    var container = document.getElementById('codeagi-memory-content');
    if (!container) return;
    try {
      var res = await apiFetch('/api/codeagi/memory/' + type);
      var items = await res.json();
      if (!Array.isArray(items) || items.length === 0) { container.innerHTML = '<div class="hint-muted" style="padding:1rem;text-align:center">No ' + type + ' yet</div>'; return; }
      items = items.slice().reverse().slice(0, 20);
      if (type === 'reflections') {
        container.innerHTML = items.map(function(r) { return '<div class="codeagi-memory-item"><div class="codeagi-memory-item-title">' + (r.summary || r.next_action || 'Reflection') + '</div>' + (r.lessons && r.lessons.length ? '<div class="codeagi-memory-item-body">Lessons: ' + r.lessons.join(', ') + '</div>' : '') + '<div class="codeagi-memory-item-meta">' + (r.mission_id || '') + ' \u00B7 ' + (r.created_at || '') + '</div></div>'; }).join('');
      } else if (type === 'semantic') {
        container.innerHTML = items.map(function(f) { return '<div class="codeagi-memory-item"><div class="codeagi-memory-item-title">' + App.escapeHtml(f.content || f.fact || JSON.stringify(f).substring(0, 100)) + '</div>' + (f.tags ? '<div class="codeagi-memory-item-body">Tags: ' + App.escapeHtml(Array.isArray(f.tags) ? f.tags.join(', ') : String(f.tags)) + '</div>' : '') + '<div class="codeagi-memory-item-meta">Confidence: ' + App.escapeHtml(String(f.confidence || '?')) + '</div></div>'; }).join('');
      } else if (type === 'procedures') {
        container.innerHTML = items.map(function(p) { return '<div class="codeagi-memory-item"><div class="codeagi-memory-item-title">' + (p.title || 'Procedure') + '</div><div class="codeagi-memory-item-body">Trigger: ' + (p.trigger || '?') + '</div>' + (p.steps ? '<div class="codeagi-memory-item-body">' + p.steps.join(' \u2192 ') + '</div>' : '') + '<div class="codeagi-memory-item-meta">Uses: ' + (p.use_count || 0) + '</div></div>'; }).join('');
      }
    } catch (err) { container.innerHTML = '<div class="hint-muted">Failed to load: ' + err.message + '</div>'; }
  },

  async loadCodeAGITraces() {
    var container = document.getElementById('codeagi-traces');
    if (!container) return;
    try {
      var res = await apiFetch('/api/codeagi/traces');
      var traces = await res.json();
      if (!Array.isArray(traces) || traces.length === 0) { container.innerHTML = '<div class="hint-muted" style="padding:1rem;text-align:center">No traces yet</div>'; return; }
      traces = traces.slice().reverse().slice(0, 20);
      container.innerHTML = traces.map(function(t) {
        var steps = t.step_count || (t.steps ? t.steps.length : 0);
        return '<div class="codeagi-trace-card"><div class="codeagi-trace-header"><span>' + (t.mission_id || '?') + '</span><span class="hint-muted">' + steps + ' steps \u00B7 ' + (t.stop_reason || '?') + '</span></div>' +
          (t.steps ? '<div class="codeagi-trace-steps">' + t.steps.map(function(s) { var c = s.action_outcome && s.action_outcome.ok ? '#00ff41' : '#ff3c3c'; return '<div class="codeagi-trace-step-dot" style="background:' + c + '"></div>'; }).join('') + '</div>' : '') + '</div>';
      }).join('');
    } catch (err) { container.innerHTML = '<div class="hint-muted">Failed to load traces</div>'; }
  },

  formatFileSize(bytes) { if (bytes < 1024) return bytes + 'B'; if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB'; return (bytes / 1048576).toFixed(1) + 'MB'; },
};


document.addEventListener('DOMContentLoaded', () => App.init());
