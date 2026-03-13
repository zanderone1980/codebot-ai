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

  // -- Init --
  init() {
    this.setupNavigation();
    this.checkHealth();
    this.navigateToHash();
    window.addEventListener('hashchange', () => this.navigateToHash());
    setInterval(() => this.checkHealth(), 30000);
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
      case 'swarm': this.initSwarm(); break;
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

      // Hide suggestion chips once chat starts
      var suggestions = document.getElementById('chat-suggestions');
      if (suggestions) suggestions.style.display = 'none';

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
        contentEl.textContent = 'Error: ' + (errD.error || 'HTTP ' + res.status);
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
  // SWARM
  // ===========================================================

  swarmInitialized: false,
  selectedProviders: [],
  selectedStrategy: 'auto',

  initSwarm() {
    if (this.swarmInitialized) return;
    this.swarmInitialized = true;
    this.loadSwarmProviders();
    this.renderSwarmStrategies();

    const runBtn = document.getElementById('swarm-run');
    const taskInput = document.getElementById('swarm-task');

    runBtn.addEventListener('click', () => this.runSwarm());
    taskInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.runSwarm(); }
    });
  },

  async loadSwarmProviders() {
    const container = document.getElementById('swarm-providers');
    const hint = document.getElementById('swarm-setup-hint');
    try {
      const data = await this.fetch('/api/swarm/providers');
      const availableCount = data.providers.filter(function(p) { return p.available; }).length;

      // Show setup hint if no providers have API keys
      if (hint) {
        hint.style.display = availableCount === 0 ? '' : 'none';
      }

      container.innerHTML = data.providers.map(function(p) {
        const cls = p.available ? 'swarm-card available' : 'swarm-card unavailable';
        return '<div class="' + cls + '" data-provider="' + App.escapeHtml(p.name) + '">' +
          '<span class="swarm-card-dot"></span>' +
          '<div class="swarm-card-name">' + App.escapeHtml(p.name) + '</div>' +
          '<div class="swarm-card-model">' + App.escapeHtml(p.defaultModel) + '</div>' +
        '</div>';
      }).join('');

      // Auto-select all available providers
      container.querySelectorAll('.swarm-card.available').forEach(function(card) {
        card.classList.add('selected');
        card.addEventListener('click', function() {
          card.classList.toggle('selected');
          App.updateSwarmSelection();
        });
      });
      App.updateSwarmSelection();
    } catch (err) {
      container.innerHTML = App.renderEmpty('Error loading providers', err.message);
    }
  },

  renderSwarmStrategies() {
    var strategies = [
      { id: 'auto', name: 'Auto', desc: 'Router picks best' },
      { id: 'debate', name: 'Debate', desc: 'Agents propose and vote' },
      { id: 'moa', name: 'Mixture', desc: 'Diverse solutions merged' },
      { id: 'pipeline', name: 'Pipeline', desc: 'Sequential stages' },
      { id: 'fan-out', name: 'Fan-Out', desc: 'Parallel subtasks' },
      { id: 'generator-critic', name: 'Gen-Critic', desc: 'Iterate to quality' },
    ];

    var container = document.getElementById('swarm-strategies');
    container.innerHTML = strategies.map(function(s) {
      var cls = s.id === 'auto' ? 'swarm-card selected' : 'swarm-card';
      return '<div class="' + cls + '" data-strategy="' + s.id + '">' +
        '<div class="swarm-card-name">' + App.escapeHtml(s.name) + '</div>' +
        '<div class="swarm-card-desc">' + App.escapeHtml(s.desc) + '</div>' +
      '</div>';
    }).join('');

    // Click to select (single-select)
    container.querySelectorAll('.swarm-card').forEach(function(card) {
      card.addEventListener('click', function() {
        container.querySelectorAll('.swarm-card').forEach(function(c) { c.classList.remove('selected'); });
        card.classList.add('selected');
        App.selectedStrategy = card.dataset.strategy;
      });
    });
  },

  updateSwarmSelection() {
    var selected = [];
    document.querySelectorAll('#swarm-providers .swarm-card.selected').forEach(function(card) {
      selected.push(card.dataset.provider);
    });
    this.selectedProviders = selected;

    var runBtn = document.getElementById('swarm-run');
    runBtn.disabled = selected.length === 0;

    var status = document.getElementById('swarm-status');
    if (selected.length > 0) {
      status.innerHTML = '<span class="stat-chip"><strong>' + selected.length + '</strong> provider' + (selected.length > 1 ? 's' : '') + '</span>';
    } else {
      status.innerHTML = '';
    }
  },

  async runSwarm() {
    var taskInput = document.getElementById('swarm-task');
    var task = taskInput.value.trim();
    if (!task) return;
    if (this.selectedProviders.length === 0) return;

    var output = document.getElementById('swarm-output');
    var runBtn = document.getElementById('swarm-run');
    runBtn.disabled = true;
    output.style.display = '';
    output.textContent = 'Starting swarm...\n';

    try {
      var res = await apiFetch('/api/command/swarm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: task,
          providers: this.selectedProviders,
          strategy: this.selectedStrategy,
        }),
      });

      if (!res.ok) {
        var errD = await res.json().catch(function() { return {}; });
        output.textContent = 'Error: ' + (errD.error || 'HTTP ' + res.status);
        runBtn.disabled = false;
        return;
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      output.textContent = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!line.startsWith('data: ')) continue;
          var payload = line.slice(6);
          if (payload === '[DONE]') break;
          try {
            var ev = JSON.parse(payload);
            if (ev.type === 'text') {
              output.textContent += ev.text || '';
            } else if (ev.type === 'tool_call' && ev.toolCall) {
              output.textContent += '\n[tool: ' + ev.toolCall.name + ']\n';
            } else if (ev.type === 'error') {
              output.textContent += '\n[Error: ' + (ev.text || 'unknown') + ']\n';
            }
            output.scrollTop = output.scrollHeight;
          } catch(e) {}
        }
      }
      if (!output.textContent.trim()) output.textContent = '(no output)';
    } catch (err) {
      output.textContent = 'Error: ' + err.message;
    }

    runBtn.disabled = this.selectedProviders.length === 0;
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
