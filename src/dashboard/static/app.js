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
    this.setupNavigation();
    this.checkOnboarding();
    this.checkHealth();
    this.navigateToHash();
    window.addEventListener('hashchange', () => this.navigateToHash());
    setInterval(() => this.checkHealth(), 30000);
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

        if ((!data.localServers || data.localServers.length === 0) && (!data.envProviders || data.envProviders.length === 0)) {
          html += '<p class="onboarding-desc">No providers detected. You can set one up later.</p>';
          html += '<button class="btn-continue" onclick="App.nextOnboardingStep()">Skip for Now</button>';
        }

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
    // Update nav pills
    document.querySelectorAll('.nav-pill').forEach(pill =>
      pill.classList.toggle('active', pill.dataset.panel === name)
    );
    // Update panels
    document.querySelectorAll('.panel').forEach(panel =>
      panel.classList.toggle('active', panel.id === 'panel-' + name)
    );

    // Fade logo when chat has messages
    const logoArea = document.getElementById('logo-area');
    const chatMsgs = document.getElementById('chat-messages');
    const hasMessages = chatMsgs && chatMsgs.children.length > 0;
    if (logoArea) {
      logoArea.classList.toggle('faded', name === 'chat' && hasMessages);
    }
    // Expand layout when chat is active with messages
    document.body.classList.toggle('chat-expanded', name === 'chat' && hasMessages);

    // Load data for panels
    switch (name) {
      case 'chat': this.initChat(); break;
      case 'sessions': this.loadSessions(); break;
      case 'terminal': this.initTerminal(); break;
      case 'tools': this.initTools(); break;
      // metrics removed
      case 'workflows': this.initWorkflows(); break;
      case 'memory': this.initMemory(); break;
      case 'risk': this.loadRisk(); break;
      case 'models': this.initModels(); break;
        case 'risk': this.initRisk(); break;
      case 'codeagi': this.initPanelCodeagi(); break;
    }
  },

  // ===========================================================
  // HEALTH + STATUS
  // ===========================================================

  async checkHealth() {
    const conn = document.getElementById('conn-indicator');
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

    const send = () => {
      const msg = input.value.trim();
      if (!msg) return;
      input.value = '';
      this.appendChatMessage('user', msg);
      this.streamChat(msg);

      // Hide suggestion chips, show new chat button
      var suggestions = document.getElementById('chat-suggestions');
      if (suggestions) suggestions.style.display = 'none';
      var newChatBtn = document.getElementById('new-chat-btn');
      if (newChatBtn) newChatBtn.style.display = '';

      // Fade logo + expand layout once chat starts
      const logoArea = document.getElementById('logo-area');
      if (logoArea) logoArea.classList.add('faded');
      document.body.classList.add('chat-expanded');
    };

    // Suggestion chip click handlers
    var chips = document.querySelectorAll('.suggestion-chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function() {
        var msg = this.getAttribute('data-msg');
        input.value = msg;
        input.focus();
        // If message doesn't end with space (complete action), send immediately
        if (msg && msg.charAt(msg.length - 1) !== ' ') {
          send();
        }
      });
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
  },

  appendChatMessage(role, content) {
    const container = document.getElementById('chat-messages');
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
        return App.escapeHtml(pair[0]) + ': ' + App.escapeHtml(App.truncate(String(pair[1]), 80));
      }).join(', ');
    }

    const riskBadge = '<span class="risk-badge ' + this.getRiskClass(name, args) + '">' + this.getRiskLabel(name, args) + '</span>';
    div.innerHTML = '<div class="chat-tool-badge">tool: ' + this.escapeHtml(name) + ' ' + riskBadge + '</div>' +
      '<div class="chat-tool-args">' + argsStr + '</div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  },

  async streamChat(message) {
    const container = document.getElementById('chat-messages');
    const assistantDiv = this.appendChatMessage('assistant', '');
    const contentEl = assistantDiv.querySelector('.chat-msg-content');
    let fullText = '';
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
              this.appendChatToolCall(ev.toolCall.name, ev.toolCall.args);
            }
            else if (ev.type === 'error') {
              hasError = true;
              var errMsg = ev.text || ev.error || 'unknown error';
              contentEl.innerHTML = App.renderMarkdown(fullText) + '<div class="cmd-error">' + App.escapeHtml(errMsg) + '</div>';
            }
          } catch(e) {}
        }
      }
      if (!fullText && !hasError) contentEl.textContent = '(no response)';
    } catch (err) { contentEl.textContent = 'Error: ' + err.message; }
  },

  newChat() {
    // Clear chat messages and reset to initial state
    var container = document.getElementById('chat-messages');
    if (container) container.innerHTML = '';

    // Show suggestion chips again
    var suggestions = document.getElementById('chat-suggestions');
    if (suggestions) suggestions.style.display = '';

    // Hide new chat button
    var newChatBtn = document.getElementById('new-chat-btn');
    if (newChatBtn) newChatBtn.style.display = 'none';

    // Reset logo and layout
    var logoArea = document.getElementById('logo-area');
    if (logoArea) logoArea.classList.remove('faded');
    document.body.classList.remove('chat-expanded');

    // Focus input
    var input = document.getElementById('chat-input');
    if (input) { input.value = ''; input.focus(); }
  },

  // ===========================================================
  // NOTIFICATIONS
  // ===========================================================

  notificationPanelOpen: false,

  async pollNotifications() {
    try {
      var data = await this.fetch('/api/notifications');
      var badge = document.getElementById('notification-badge');
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

      // Expand chat layout
      this.chatInitialized = false;
      this.initChat();
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

    // Tool runner
    if (this.agentConnected) {
      this.loadToolList();
      document.getElementById('tool-select').addEventListener('change', (e) => App.onToolSelected(e.target.value));
      document.getElementById('tool-run-btn').addEventListener('click', () => App.executeSelectedTool());
    }
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

    // Code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function(match, lang, code) {
      return '<pre><code>' + code + '</code></pre>';
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // Line breaks
    html = html.replace(/\n/g, '<br>');

    // Clean up
    html = html.replace(/<\/pre><br>/g, '</pre>');
    html = html.replace(/<\/h2><br>/g, '</h2>');
    html = html.replace(/<\/h3><br>/g, '</h3>');
    html = html.replace(/<\/li><br>/g, '</li>');

    return html;
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

  formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
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
  },
  // ===========================================================
  // RISK
  // ===========================================================

  async loadRisk() {
    try {
      var data = await this.fetch('/api/risk/summary');
      document.getElementById('risk-total').textContent = data.total || 0;
      document.getElementById('risk-average').textContent = data.average || 0;
      document.getElementById('risk-peak').textContent = data.peak || 0;

      // Update bar chart
      var total = data.total || 1;
      var levels = ['green', 'yellow', 'orange', 'red'];
      for (var i = 0; i < levels.length; i++) {
        var l = levels[i];
        var count = data[l] || 0;
        var pct = Math.round((count / total) * 100);
        var bar = document.getElementById('risk-bar-' + l);
        var countEl = document.getElementById('risk-count-' + l);
        if (bar) bar.style.width = pct + '%';
        if (countEl) countEl.textContent = count;
      }

      // Color the average
      var avgEl = document.getElementById('risk-average');
      if (avgEl) {
        var avg = data.average || 0;
        avgEl.style.color = avg <= 25 ? '#39ff14' : avg <= 50 ? '#ffd700' : avg <= 75 ? '#ff6b35' : '#ff073a';
      }

      // Status
      var status = document.getElementById('risk-status');
      if (status && data.total > 0) {
        status.textContent = data.total + ' assessments | avg ' + data.average;
      }
    } catch (err) {
      console.warn('Risk load error:', err);
    }

    // Load recent history
    try {
      var hist = await this.fetch('/api/risk/history?limit=50');
      var feed = document.getElementById('risk-feed');
      if (feed && hist.history) {
        if (hist.history.length === 0) {
          feed.innerHTML = '<div class="empty-state">No risk assessments yet. Run the agent to generate risk data.</div>';
        } else {
          feed.innerHTML = hist.history.reverse().map(function(a, i) {
            var colors = { green: '#39ff14', yellow: '#ffd700', orange: '#ff6b35', red: '#ff073a' };
            var color = colors[a.level] || '#888';
            return '<div class="security-entry">' +
              '<span class="security-decision" style="color:' + color + '">' + a.level.toUpperCase() + '</span>' +
              '<span class="security-score">Score: ' + a.score + '</span>' +
              '<span class="security-factors">' + a.factors + ' factors</span>' +
              '</div>';
          }).join('');
        }
      }
    } catch (err) {
      console.warn('Risk history error:', err);
    }
  },

  initPanelCodeagi() {
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
    this.setupCodeAGIContinuous();
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
        container.innerHTML = items.map(function(f) { return '<div class="codeagi-memory-item"><div class="codeagi-memory-item-title">' + (f.content || f.fact || JSON.stringify(f).substring(0, 100)) + '</div>' + (f.tags ? '<div class="codeagi-memory-item-body">Tags: ' + (Array.isArray(f.tags) ? f.tags.join(', ') : f.tags) + '</div>' : '') + '<div class="codeagi-memory-item-meta">Confidence: ' + (f.confidence || '?') + '</div></div>'; }).join('');
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

  escapeHtml(text) { if (!text) return ''; return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },

};

document.addEventListener('DOMContentLoaded', () => App.init());


// ── Security Panel (CORD + VIGIL) ──

async function loadSecurityData() {
  try {
    const res = await apiFetch('/api/constitutional');
    if (!res.ok) return;
    const data = await res.json();

    if (!data.enabled) {
      document.getElementById('security-status').textContent = 'Not active';
      document.getElementById('security-feed').innerHTML =
        '<div style="color:#666;text-align:center;padding:2rem">Constitutional layer not active. Start an agent session to see CORD metrics.</div>';
      return;
    }

    // Update stats
    document.getElementById('sec-total').textContent = data.totalEvaluations || 0;
    document.getElementById('sec-allow').textContent = (data.decisions && data.decisions.ALLOW) || 0;
    document.getElementById('sec-challenge').textContent =
      ((data.decisions && data.decisions.CHALLENGE) || 0) + ((data.decisions && data.decisions.CONTAIN) || 0);
    document.getElementById('sec-block').textContent = (data.decisions && data.decisions.BLOCK) || 0;
    document.getElementById('sec-hardblocks').textContent = data.hardBlocks || 0;
    document.getElementById('sec-vigil-scans').textContent = data.vigilScans || 0;
    document.getElementById('sec-escalations').textContent = data.escalations || 0;
    document.getElementById('sec-canaries').textContent = data.canariesTriggered || 0;

    // Update status badge
    const blockRate = data.totalEvaluations > 0
      ? Math.round(((data.decisions && data.decisions.BLOCK) || 0) / data.totalEvaluations * 100) : 0;
    document.getElementById('security-status').textContent =
      data.totalEvaluations + ' evals | ' + blockRate + '% blocked';

    // Render recent decisions
    const feed = document.getElementById('security-feed');
    const decisions = data.recentDecisions || [];

    if (decisions.length === 0) {
      feed.innerHTML = '<div style="color:#666;text-align:center;padding:1rem">No decisions yet</div>';
      return;
    }

    feed.innerHTML = decisions.slice().reverse().slice(0, 50).map(function(d) {
      var cls = 'badge-' + (d.decision || 'allow').toLowerCase();
      var time = new Date(d.timestamp).toLocaleTimeString();
      var tool = d.tool || '-';
      var explain = d.explanation || '';
      return '<div class="security-entry">' +
        '<span class="badge ' + cls + '">' + (d.decision || 'ALLOW') + '</span>' +
        '<span class="entry-tool">' + escapeHtml(tool) + '</span>' +
        '<span class="entry-explain">' + escapeHtml(explain) + '</span>' +
        '<span class="entry-score">score:' + (d.score || 0) + '</span>' +
        '<span class="entry-time">' + time + '</span>' +
        '</div>';
    }).join('');
  } catch (e) {
    // Silently fail
  }
}

// Refresh security data when navigating to the panel
(function() {
  var origSwitch = switchPanel;
  switchPanel = function(panel) {
    origSwitch(panel);
    if (panel === 'security') loadSecurityData();
  };
})();

// Auto-refresh security data every 5 seconds when on security panel
setInterval(function() {
  var secPanel = document.getElementById('panel-security');
  if (secPanel && secPanel.classList.contains('active')) {
    loadSecurityData();
  }
}, 5000);


// ── Risk Scoring Panel ──

function initRisk() {
  fetch('/api/metrics')
    .then(function(res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(function(metrics) { renderRiskPanel(metrics); })
    .catch(function(e) { console.error('Risk panel error:', e); });
}

function renderRiskPanel(metrics) {
    // Extract risk-related metrics
    const toolCalls = metrics.tool_calls_total || {};
    const securityBlocks = metrics.security_blocks_total || {};
    const errors = metrics.errors_total || {};

    // Calculate totals
    let totalCalls = 0;
    let totalBlocks = 0;
    const toolScores = {};

    for (const [key, count] of Object.entries(toolCalls)) {
      totalCalls += count;
      if (!toolScores[key]) toolScores[key] = { calls: 0, blocks: 0, errors: 0 };
      toolScores[key].calls += count;
    }

    for (const [key, count] of Object.entries(securityBlocks)) {
      totalBlocks += count;
      const tool = key.split('{')[0] || key;
      if (!toolScores[tool]) toolScores[tool] = { calls: 0, blocks: 0, errors: 0 };
      toolScores[tool].blocks += count;
    }

    for (const [key, count] of Object.entries(errors)) {
      const tool = key.split('{')[0] || key;
      if (!toolScores[tool]) toolScores[tool] = { calls: 0, blocks: 0, errors: 0 };
      toolScores[tool].errors += count;
    }

    // Compute per-tool risk scores (higher blocks/errors ratio = higher risk)
    const toolRiskList = [];
    for (const [tool, data] of Object.entries(toolScores)) {
      const riskScore = data.calls > 0
        ? Math.round(((data.blocks + data.errors) / data.calls) * 100)
        : 0;
      toolRiskList.push({ tool, ...data, riskScore });
    }
    toolRiskList.sort((a, b) => b.riskScore - a.riskScore);

    // Distribution buckets
    let low = 0, medium = 0, high = 0, critical = 0;
    for (const t of toolRiskList) {
      if (t.riskScore <= 25) low += t.calls;
      else if (t.riskScore <= 50) medium += t.calls;
      else if (t.riskScore <= 75) high += t.calls;
      else critical += t.calls;
    }

    const total = Math.max(totalCalls, 1);
    const blockRate = totalCalls > 0 ? ((totalBlocks / totalCalls) * 100).toFixed(1) : '0';
    const avgScore = toolRiskList.length > 0
      ? Math.round(toolRiskList.reduce((sum, t) => sum + t.riskScore, 0) / toolRiskList.length)
      : 0;

    // Update summary cards
    document.getElementById('risk-total').textContent = totalCalls;
    document.getElementById('risk-block-rate').textContent = blockRate + '%';
    document.getElementById('risk-avg-score').textContent = avgScore;
    document.getElementById('risk-high-count').textContent = high + critical;

    // Update bars
    document.getElementById('risk-bar-low').style.width = ((low / total) * 100) + '%';
    document.getElementById('risk-bar-medium').style.width = ((medium / total) * 100) + '%';
    document.getElementById('risk-bar-high').style.width = ((high / total) * 100) + '%';
    document.getElementById('risk-bar-critical').style.width = ((critical / total) * 100) + '%';
    document.getElementById('risk-count-low').textContent = low;
    document.getElementById('risk-count-medium').textContent = medium;
    document.getElementById('risk-count-high').textContent = high;
    document.getElementById('risk-count-critical').textContent = critical;

    // Top risk tools
    const toolsEl = document.getElementById('risk-tools-list');
    if (toolRiskList.length > 0) {
      toolsEl.innerHTML = toolRiskList.slice(0, 12).map(t => {
        const level = t.riskScore <= 25 ? 'low' : t.riskScore <= 50 ? 'medium' : t.riskScore <= 75 ? 'high' : 'critical';
        return '<div class="risk-tool-card">' +
          '<span class="risk-tool-name">' + t.tool + '</span>' +
          '<span class="risk-tool-score ' + level + '">' + t.riskScore + '% risk</span>' +
          '</div>';
      }).join('');
    }

    // Recent high-risk (tools with blocks/errors)
    const recentEl = document.getElementById('risk-recent-list');
    const highRisk = toolRiskList.filter(t => t.blocks > 0 || t.errors > 0);
    if (highRisk.length > 0) {
      recentEl.innerHTML = highRisk.slice(0, 10).map(t => {
        const level = t.riskScore <= 25 ? 'low' : t.riskScore <= 50 ? 'medium' : t.riskScore <= 75 ? 'high' : 'critical';
        return '<div class="risk-recent-item">' +
          '<span class="risk-recent-tool">' + t.tool + ' — ' + t.blocks + ' blocks, ' + t.errors + ' errors / ' + t.calls + ' calls</span>' +
          '<span class="risk-recent-score risk-tool-score ' + level + '">' + t.riskScore + '%</span>' +
          '</div>';
      }).join('');
    }
}
