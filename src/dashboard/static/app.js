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
