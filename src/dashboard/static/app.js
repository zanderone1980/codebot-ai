/**
 * CodeBot AI Dashboard — Frontend Application
 * Vanilla JS, zero dependencies. Premium UI.
 */

const App = {
  baseUrl: window.location.origin,
  sessionCount: 0,

  // ── Init ──
  init() {
    this.setupNavigation();
    this.checkHealth();
    this.navigateToHash();
    window.addEventListener('hashchange', () => this.navigateToHash());
    // Auto-refresh health every 30s
    setInterval(() => this.checkHealth(), 30000);
  },

  // ── Navigation ──
  setupNavigation() {
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        window.location.hash = link.dataset.section;
      });
    });
  },

  navigateToHash() {
    const hash = window.location.hash.replace('#', '') || 'sessions';
    this.showSection(hash);
  },

  showSection(name) {
    document.querySelectorAll('.nav-link').forEach(link =>
      link.classList.toggle('active', link.dataset.section === name)
    );
    document.querySelectorAll('.section').forEach(section =>
      section.classList.toggle('active', section.id === 'section-' + name)
    );
    switch (name) {
      case 'sessions': this.loadSessions(); break;
      case 'audit': this.loadAudit(); break;
      case 'metrics': this.loadMetrics(); break;
      case 'command': this.initCommand(); break;
    }
  },

  // ── Health ──
  async checkHealth() {
    const el = document.getElementById('health-status');
    try {
      const data = await this.fetch('/api/health');
      el.className = 'health-pill ok';
      el.querySelector('.health-text').textContent = `v${data.version}`;
    } catch {
      el.className = 'health-pill error';
      el.querySelector('.health-text').textContent = 'Offline';
    }
  },

  // ── Sessions ──
  async loadSessions() {
    const container = document.getElementById('sessions-list');
    const detail = document.getElementById('session-detail');
    const stats = document.getElementById('session-stats');
    detail.style.display = 'none';
    container.style.display = '';
    container.innerHTML = this.renderLoading();

    try {
      const data = await this.fetch('/api/sessions?limit=50');
      this.sessionCount = data.total;

      stats.innerHTML = `
        <span class="stat-chip"><strong>${data.total}</strong> sessions</span>
        ${data.hasMore ? '<span class="stat-chip">showing latest 50</span>' : ''}
      `;

      if (data.sessions.length === 0) {
        container.innerHTML = this.renderEmpty(
          'No sessions yet',
          'Start a CodeBot session to see conversations here'
        );
        return;
      }

      container.innerHTML = data.sessions.map(s => {
        const date = s.modifiedAt ? this.relativeTime(s.modifiedAt) : 'Unknown';
        const fullDate = s.modifiedAt ? new Date(s.modifiedAt).toLocaleString() : '';
        const shortId = s.id.substring(0, 12);
        return `
          <div class="card" onclick="App.loadSessionDetail('${this.escapeHtml(s.id)}')">
            <div class="card-top">
              <span class="card-id">${this.escapeHtml(shortId)}</span>
              <span class="card-size">${this.formatBytes(s.sizeBytes)}</span>
            </div>
            <div class="card-date" title="${this.escapeHtml(fullDate)}">${this.escapeHtml(date)}</div>
          </div>
        `;
      }).join('');
    } catch {
      container.innerHTML = this.renderEmpty('Error loading sessions', 'Check that the server is running');
    }
  },

  async loadSessionDetail(id) {
    const container = document.getElementById('sessions-list');
    const detail = document.getElementById('session-detail');
    container.style.display = 'none';
    detail.style.display = '';
    detail.innerHTML = this.renderLoading();

    try {
      const data = await this.fetch('/api/sessions/' + encodeURIComponent(id));
      const shortId = data.id.substring(0, 16);

      detail.innerHTML = `
        <div class="detail-top">
          <div>
            <div class="detail-title">${this.escapeHtml(shortId)}...</div>
            <div class="detail-meta">
              <span>${data.messageCount} messages</span>
              <span>${data.toolCallCount} tool calls</span>
            </div>
          </div>
          <button class="btn-back" onclick="App.loadSessions()">&larr; Back</button>
        </div>
        <div class="message-list">
          ${data.messages.map(m => `
            <div class="message ${this.escapeHtml(m.role)}">
              <div class="message-role">${this.escapeHtml(m.role)}</div>
              <div class="message-content">${this.escapeHtml(this.truncate(this.extractContent(m), 600))}</div>
            </div>
          `).join('')}
        </div>
      `;
    } catch {
      detail.innerHTML = this.renderEmpty('Error loading session', '');
    }
  },

  // ── Audit ──
  async loadAudit() {
    const timeline = document.getElementById('audit-timeline');
    timeline.innerHTML = this.renderLoading();
    document.getElementById('btn-verify').onclick = () => this.verifyAudit();

    try {
      const data = await this.fetch('/api/audit?days=30');
      if (data.entries.length === 0) {
        timeline.innerHTML = this.renderEmpty('No audit entries', 'Tool executions will appear here');
        return;
      }

      timeline.innerHTML = data.entries.slice(-100).reverse().map(e => `
        <div class="timeline-entry ${this.escapeHtml(e.action || '')}">
          <div class="timeline-dot"></div>
          <div class="timeline-card">
            <div class="timeline-tool">${this.escapeHtml(e.tool || 'unknown')}</div>
            <div class="timeline-action">${this.escapeHtml(e.action || '')}${e.reason ? ' — ' + this.escapeHtml(this.truncate(e.reason, 100)) : ''}</div>
            <div class="timeline-time">${e.timestamp ? this.relativeTime(e.timestamp) : ''}</div>
          </div>
        </div>
      `).join('');
    } catch {
      timeline.innerHTML = this.renderEmpty('Error loading audit trail', '');
    }
  },

  async verifyAudit() {
    const el = document.getElementById('verify-result');
    el.textContent = 'Verifying...';
    el.className = 'verify-badge';

    try {
      const data = await this.fetch('/api/audit/verify');
      if (data.chainIntegrity === 'verified') {
        el.textContent = `\u2713 Verified (${data.valid} entries)`;
        el.className = 'verify-badge verified';
      } else {
        el.textContent = `\u2717 Broken (${data.invalid} invalid)`;
        el.className = 'verify-badge broken';
      }
    } catch {
      el.textContent = 'Failed';
      el.className = 'verify-badge broken';
    }
  },

  // ── Metrics ──
  async loadMetrics() {
    const cards = document.getElementById('metrics-cards');
    const chart = document.getElementById('usage-chart');
    const breakdown = document.getElementById('tool-breakdown');
    cards.innerHTML = this.renderLoading();

    try {
      const [summary, usage] = await Promise.all([
        this.fetch('/api/metrics/summary'),
        this.fetch('/api/usage'),
      ]);

      // Stats cards
      const toolCount = Object.keys(summary.toolUsage || {}).length;
      const actionCount = Object.keys(summary.actionBreakdown || {}).length;
      cards.innerHTML = `
        <div class="stat-card purple">
          <div class="stat-value">${summary.sessions}</div>
          <div class="stat-label">Sessions</div>
        </div>
        <div class="stat-card cyan">
          <div class="stat-value">${summary.auditEntries}</div>
          <div class="stat-label">Audit Events</div>
        </div>
        <div class="stat-card green">
          <div class="stat-value">${toolCount}</div>
          <div class="stat-label">Tools Used</div>
        </div>
        <div class="stat-card yellow">
          <div class="stat-value">${actionCount}</div>
          <div class="stat-label">Action Types</div>
        </div>
      `;

      // Bar chart
      if (usage.usage && usage.usage.length > 0) {
        const maxMsg = Math.max(...usage.usage.map(u => u.messageCount), 1);
        chart.innerHTML = `
          <div class="chart-title">Recent Sessions</div>
          <div class="bar-chart">
            ${usage.usage.map(u => {
              const h = Math.max(8, (u.messageCount / maxMsg) * 140);
              const label = u.sessionId.substring(0, 6);
              return `
                <div class="bar-wrapper">
                  <span class="bar-value">${u.messageCount}</span>
                  <div class="bar" style="height:${h}px" title="${this.escapeHtml(u.sessionId)}"></div>
                  <span class="bar-label">${this.escapeHtml(label)}</span>
                </div>`;
            }).join('')}
          </div>
        `;
      } else {
        chart.innerHTML = this.renderEmpty('No usage data', 'Run some sessions to see charts');
      }

      // Tool breakdown
      const tools = Object.entries(summary.toolUsage || {}).sort((a, b) => b[1] - a[1]);
      if (tools.length > 0) {
        const maxCount = tools[0][1];
        breakdown.innerHTML = `
          <div class="chart-title">Tool Usage</div>
          ${tools.slice(0, 15).map(([name, count]) => `
            <div class="breakdown-row">
              <span class="breakdown-name">${this.escapeHtml(name)}</span>
              <div class="breakdown-bar">
                <div class="breakdown-fill" style="width:${(count / maxCount * 100).toFixed(1)}%"></div>
              </div>
              <span class="breakdown-count">${count}</span>
            </div>
          `).join('')}
        `;
      } else {
        breakdown.innerHTML = '';
      }
    } catch {
      cards.innerHTML = this.renderEmpty('Error loading metrics', '');
    }
  },

  // ── Command Center ──
  cmdInitialized: false,
  toolsData: null,
  terminalHistory: [],
  terminalHistoryIndex: -1,

  async initCommand() {
    let agentConnected = false;
    try {
      const status = await this.fetch('/api/command/status');
      agentConnected = status.available;
    } catch { /* standalone */ }

    // Always show command panel — Terminal + Quick Actions work without agent
    document.getElementById('cmd-unavailable').style.display = 'none';
    document.getElementById('cmd-available').style.display = '';

    // Status badge
    const statusEl = document.getElementById('cmd-status');
    if (statusEl) {
      statusEl.innerHTML = agentConnected
        ? '<span class="badge badge-ok">Agent Connected</span>'
        : '<span class="badge badge-warn">Standalone Mode</span>';
    }

    // Disable agent-only tabs when standalone
    if (!agentConnected) {
      document.querySelectorAll('.cmd-tab').forEach(tab => {
        const t = tab.dataset.cmdTab;
        if (t === 'chat' || t === 'toolrunner') {
          tab.classList.add('disabled');
          tab.title = 'Requires agent — run codebot --dashboard';
        }
      });
      // Default to terminal tab in standalone
      document.querySelectorAll('.cmd-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.cmd-panel').forEach(p => p.classList.remove('active'));
      const termTab = document.querySelector('.cmd-tab[data-cmd-tab="terminal"]');
      if (termTab) termTab.classList.add('active');
      const termPanel = document.getElementById('cmd-terminal');
      if (termPanel) termPanel.classList.add('active');
    }

    if (this.cmdInitialized) return;
    this.cmdInitialized = true;
    this.agentConnected = agentConnected;

    document.querySelectorAll('.cmd-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        if (tab.classList.contains('disabled')) return;
        document.querySelectorAll('.cmd-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.cmd-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('cmd-' + tab.dataset.cmdTab).classList.add('active');
      });
    });
    if (agentConnected) this.initChat();
    this.initQuickActions();
    this.initTerminal();
    if (agentConnected) this.initToolRunner();
  },

  initChat() {
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send');
    const send = () => {
      const msg = input.value.trim();
      if (!msg) return;
      input.value = '';
      this.appendChatMessage('user', msg);
      this.streamChat(msg);
    };
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
  },

  appendChatMessage(role, content) {
    const container = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-msg ' + this.escapeHtml(role);
    div.innerHTML = '<div class="chat-msg-role">' + this.escapeHtml(role) + '</div><div class="chat-msg-content">' + this.escapeHtml(content) + '</div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
  },

  appendChatToolCall(name, args) {
    const container = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-msg tool-call';
    var argsStr = '';
    if (args && typeof args === 'object') {
      argsStr = Object.entries(args).map(function(pair) { return App.escapeHtml(pair[0]) + ': ' + App.escapeHtml(App.truncate(String(pair[1]), 80)); }).join(', ');
    }
    div.innerHTML = '<div class="chat-tool-badge">tool: ' + this.escapeHtml(name) + '</div><div class="chat-tool-args">' + argsStr + '</div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  },

  async streamChat(message) {
    const container = document.getElementById('chat-messages');
    const assistantDiv = this.appendChatMessage('assistant', '');
    const contentEl = assistantDiv.querySelector('.chat-msg-content');
    var fullText = '';
    try {
      const res = await window.fetch(this.baseUrl + '/api/command/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message }),
      });
      if (!res.ok) { var errD = await res.json().catch(function(){return {};}); contentEl.textContent = 'Error: ' + (errD.error || 'HTTP ' + res.status); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      var buffer = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!line.startsWith('data: ')) continue;
          var payload = line.slice(6);
          if (payload === '[DONE]') break;
          try {
            var ev = JSON.parse(payload);
            if (ev.type === 'text') { fullText += ev.text || ''; contentEl.textContent = fullText; container.scrollTop = container.scrollHeight; }
            else if (ev.type === 'tool_call' && ev.toolCall) { this.appendChatToolCall(ev.toolCall.name, ev.toolCall.args); }
            else if (ev.type === 'error') { contentEl.textContent = fullText + '\n[Error: ' + (ev.text || 'unknown') + ']'; }
          } catch(e) {}
        }
      }
      if (!fullText) contentEl.textContent = '(no response)';
    } catch (err) { contentEl.textContent = 'Error: ' + err.message; }
  },

  initQuickActions() {
    document.querySelectorAll('.quick-btn').forEach(function(btn) {
      btn.addEventListener('click', function() { App.runQuickAction(btn.dataset.action); });
    });
  },

  async runQuickAction(action) {
    const output = document.getElementById('quick-output');
    output.style.display = ''; output.textContent = 'Running...';
    try {
      const res = await window.fetch(this.baseUrl + '/api/command/quick-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action }),
      });
      if (!res.ok) { var errD = await res.json().catch(function(){return {};}); output.textContent = 'Error: ' + (errD.error || 'HTTP ' + res.status); return; }
      const reader = res.body.getReader(); const decoder = new TextDecoder();
      var buffer = '', fullText = ''; output.textContent = '';
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i]; if (!line.startsWith('data: ')) continue;
          var payload = line.slice(6); if (payload === '[DONE]') break;
          try { var ev = JSON.parse(payload);
            if (ev.type === 'text') { fullText += ev.text || ''; output.textContent = fullText; }
            else if (ev.type === 'stdout') { fullText += ev.text || ''; output.textContent = fullText; }
            else if (ev.type === 'stderr') { fullText += ev.text || ''; output.textContent = fullText; }
            else if (ev.type === 'tool_result' && ev.toolResult) { fullText += '\n' + (ev.toolResult.result || ''); output.textContent = fullText; }
          } catch(e) {}
        }
      }
      if (!fullText) output.textContent = '(no output)';
    } catch (err) { output.textContent = 'Error: ' + err.message; }
  },

  initTerminal() {
    const input = document.getElementById('terminal-input');
    this.terminalHistory = []; this.terminalHistoryIndex = -1;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const cmd = input.value.trim(); if (!cmd) return;
        this.terminalHistory.push(cmd); this.terminalHistoryIndex = this.terminalHistory.length;
        input.value = ''; this.runTerminalCommand(cmd);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); if (this.terminalHistoryIndex > 0) { this.terminalHistoryIndex--; input.value = this.terminalHistory[this.terminalHistoryIndex]; }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.terminalHistoryIndex < this.terminalHistory.length - 1) { this.terminalHistoryIndex++; input.value = this.terminalHistory[this.terminalHistoryIndex]; }
        else { this.terminalHistoryIndex = this.terminalHistory.length; input.value = ''; }
      }
    });
  },

  async runTerminalCommand(cmd) {
    const output = document.getElementById('terminal-output');
    const cmdLine = document.createElement('div'); cmdLine.className = 'terminal-line cmd'; cmdLine.textContent = '$ ' + cmd; output.appendChild(cmdLine);
    const resultBlock = document.createElement('div'); resultBlock.className = 'terminal-line result'; output.appendChild(resultBlock);
    output.scrollTop = output.scrollHeight;
    try {
      const res = await window.fetch(this.baseUrl + '/api/command/exec', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });
      if (!res.ok) { var errD = await res.json().catch(function(){return {};}); resultBlock.textContent = 'Error: ' + (errD.error || 'HTTP ' + res.status); resultBlock.classList.add('error'); return; }
      const reader = res.body.getReader(); const decoder = new TextDecoder(); var buffer = '';
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i]; if (!line.startsWith('data: ')) continue;
          var payload = line.slice(6); if (payload === '[DONE]') break;
          try { var ev = JSON.parse(payload);
            if (ev.type === 'stdout' || ev.type === 'stderr') { resultBlock.textContent += ev.text || ''; if (ev.type === 'stderr') resultBlock.classList.add('error'); }
            else if (ev.type === 'exit' && ev.code !== 0) { resultBlock.classList.add('error'); resultBlock.textContent += '\n[exit code: ' + ev.code + ']'; }
          } catch(e) {}
        }
      }
    } catch (err) { resultBlock.textContent = 'Error: ' + err.message; resultBlock.classList.add('error'); }
    output.scrollTop = output.scrollHeight;
  },

  initToolRunner() {
    this.loadToolList();
    document.getElementById('tool-select').addEventListener('change', (e) => { this.onToolSelected(e.target.value); });
    document.getElementById('tool-run-btn').addEventListener('click', () => { this.executeSelectedTool(); });
  },

  async loadToolList() {
    try {
      const data = await this.fetch('/api/command/tools'); const select = document.getElementById('tool-select');
      this.toolsData = data.tools;
      var sorted = data.tools.slice().sort(function(a, b) { return a.name.localeCompare(b.name); });
      for (var i = 0; i < sorted.length; i++) { var opt = document.createElement('option'); opt.value = sorted[i].name; opt.textContent = sorted[i].name; select.appendChild(opt); }
    } catch {}
  },

  onToolSelected(toolName) {
    var tool = null;
    if (this.toolsData) { for (var i = 0; i < this.toolsData.length; i++) { if (this.toolsData[i].name === toolName) { tool = this.toolsData[i]; break; } } }
    const descEl = document.getElementById('tool-description'), formEl = document.getElementById('tool-form'), runBtn = document.getElementById('tool-run-btn'), resultEl = document.getElementById('tool-result');
    resultEl.innerHTML = ''; resultEl.style.display = 'none';
    if (!tool) { descEl.textContent = ''; formEl.innerHTML = ''; runBtn.disabled = true; return; }
    descEl.textContent = tool.description; runBtn.disabled = false;
    var props = tool.parameters && tool.parameters.properties ? tool.parameters.properties : {};
    var required = tool.parameters && tool.parameters.required ? tool.parameters.required : [];
    var html = ''; var keys = Object.keys(props);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i], schema = props[key], isReq = required.indexOf(key) >= 0, desc = schema.description || '', type = schema.type || 'string';
      if (type === 'boolean') { html += '<div class="tool-field"><label class="tool-label"><input type="checkbox" name="' + this.escapeHtml(key) + '" class="tool-checkbox" />' + this.escapeHtml(key) + (isReq ? ' *' : '') + '</label><div class="tool-field-desc">' + this.escapeHtml(desc) + '</div></div>'; }
      else { var it = type === 'number' ? 'number' : 'text'; html += '<div class="tool-field"><label class="tool-label">' + this.escapeHtml(key) + (isReq ? ' *' : '') + '</label><input type="' + it + '" name="' + this.escapeHtml(key) + '" class="tool-input" placeholder="' + this.escapeHtml(desc) + '" /><div class="tool-field-desc">' + this.escapeHtml(desc) + '</div></div>'; }
    }
    formEl.innerHTML = html;
  },

  async executeSelectedTool() {
    var toolName = document.getElementById('tool-select').value; if (!toolName) return;
    var tool = null; if (this.toolsData) { for (var i = 0; i < this.toolsData.length; i++) { if (this.toolsData[i].name === toolName) { tool = this.toolsData[i]; break; } } }
    if (!tool) return;
    const resultEl = document.getElementById('tool-result'); resultEl.style.display = ''; resultEl.innerHTML = this.renderLoading();
    var args = {}; var props = tool.parameters && tool.parameters.properties ? tool.parameters.properties : {}; var keys = Object.keys(props);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i], schema = props[key], input = document.querySelector('#tool-form [name="' + key + '"]');
      if (!input) continue;
      if (schema.type === 'boolean') { args[key] = input.checked; }
      else if (schema.type === 'number') { var v = input.value.trim(); if (v) args[key] = Number(v); }
      else { var v = input.value.trim(); if (v) args[key] = v; }
    }
    try {
      var res = await window.fetch(this.baseUrl + '/api/command/tool/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: toolName, args: args }) });
      var data = await res.json();
      if (data.is_error) { resultEl.innerHTML = '<div class="cmd-error">' + this.escapeHtml(data.result) + '</div>'; }
      else { resultEl.innerHTML = '<pre class="cmd-success">' + this.escapeHtml(data.result) + '</pre><div class="cmd-meta">' + data.duration_ms + 'ms</div>'; }
    } catch (err) { resultEl.innerHTML = '<div class="cmd-error">' + this.escapeHtml(err.message) + '</div>'; }
  },

  // ── Helpers ──
  async fetch(path) {
    const res = await window.fetch(this.baseUrl + path);
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
    return `
      <div class="empty-state">
        <div class="empty-title">${this.escapeHtml(title)}</div>
        ${desc ? '<div class="empty-desc">' + this.escapeHtml(desc) + '</div>' : ''}
      </div>
    `;
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
