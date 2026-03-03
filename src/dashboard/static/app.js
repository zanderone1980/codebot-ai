/**
 * CodeBot AI Dashboard — Frontend Application
 * Vanilla JS, zero dependencies.
 */

const App = {
  baseUrl: window.location.origin,

  // ── Initialization ──
  init() {
    this.setupNavigation();
    this.checkHealth();
    this.navigateToHash();
    window.addEventListener('hashchange', () => this.navigateToHash());
  },

  // ── Navigation ──
  setupNavigation() {
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const section = link.dataset.section;
        window.location.hash = section;
      });
    });
  },

  navigateToHash() {
    const hash = window.location.hash.replace('#', '') || 'sessions';
    this.showSection(hash);
  },

  showSection(name) {
    // Update nav links
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.toggle('active', link.dataset.section === name);
    });

    // Show/hide sections
    document.querySelectorAll('.section').forEach(section => {
      section.classList.toggle('active', section.id === 'section-' + name);
    });

    // Load data for the section
    switch (name) {
      case 'sessions': this.loadSessions(); break;
      case 'audit': this.loadAudit(); break;
      case 'metrics': this.loadMetrics(); break;
    }
  },

  // ── Health Check ──
  async checkHealth() {
    try {
      const data = await this.fetch('/api/health');
      const el = document.getElementById('health-status');
      el.textContent = 'v' + data.version + ' \u2714';
      el.className = 'status-badge ok';
    } catch {
      const el = document.getElementById('health-status');
      el.textContent = 'Disconnected';
      el.className = 'status-badge error';
    }
  },

  // ── Sessions ──
  async loadSessions() {
    const container = document.getElementById('sessions-list');
    const detail = document.getElementById('session-detail');
    container.innerHTML = '<div class="loading">Loading sessions...</div>';
    detail.style.display = 'none';
    container.style.display = '';

    try {
      const data = await this.fetch('/api/sessions');
      if (data.sessions.length === 0) {
        container.innerHTML = '<div class="empty-state">No sessions found. Start a CodeBot session to see data here.</div>';
        return;
      }

      container.innerHTML = data.sessions.map(s => `
        <div class="card" onclick="App.loadSessionDetail('${this.escapeHtml(s.id)}')">
          <div class="card-title">${this.escapeHtml(s.id)}</div>
          <div class="card-meta">
            ${s.modifiedAt ? new Date(s.modifiedAt).toLocaleString() : 'Unknown date'}
            &middot; ${this.formatBytes(s.sizeBytes)}
          </div>
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = '<div class="empty-state">Error loading sessions</div>';
    }
  },

  async loadSessionDetail(id) {
    const container = document.getElementById('sessions-list');
    const detail = document.getElementById('session-detail');
    container.style.display = 'none';
    detail.style.display = '';

    detail.innerHTML = '<div class="loading">Loading session...</div>';

    try {
      const data = await this.fetch('/api/sessions/' + encodeURIComponent(id));
      detail.innerHTML = `
        <div class="detail-header">
          <h2>${this.escapeHtml(data.id)}</h2>
          <button class="btn-back" onclick="App.loadSessions()">&larr; Back</button>
        </div>
        <div class="card-meta" style="margin-bottom:16px">
          ${data.messageCount} messages &middot; ${data.toolCallCount} tool calls
        </div>
        <div class="message-list">
          ${data.messages.map(m => `
            <div class="message ${this.escapeHtml(m.role)}">
              <div class="message-role">${this.escapeHtml(m.role)}</div>
              <div>${this.escapeHtml(this.truncate(m.content || '', 500))}</div>
            </div>
          `).join('')}
        </div>
      `;
    } catch {
      detail.innerHTML = '<div class="empty-state">Error loading session</div>';
    }
  },

  // ── Audit ──
  async loadAudit() {
    const timeline = document.getElementById('audit-timeline');
    timeline.innerHTML = '<div class="loading">Loading audit trail...</div>';

    document.getElementById('btn-verify').onclick = () => this.verifyAudit();

    try {
      const data = await this.fetch('/api/audit?days=30');
      if (data.entries.length === 0) {
        timeline.innerHTML = '<div class="empty-state">No audit entries found.</div>';
        return;
      }

      timeline.innerHTML = data.entries.slice(-100).reverse().map(e => `
        <div class="timeline-entry ${this.escapeHtml(e.action || '')}">
          <div class="timeline-tool">${this.escapeHtml(e.tool || 'unknown')}</div>
          <div class="timeline-action">${this.escapeHtml(e.action || '')} ${e.reason ? '- ' + this.escapeHtml(this.truncate(e.reason, 80)) : ''}</div>
          <div class="timeline-time">${e.timestamp ? new Date(e.timestamp).toLocaleString() : ''}</div>
        </div>
      `).join('');
    } catch {
      timeline.innerHTML = '<div class="empty-state">Error loading audit trail</div>';
    }
  },

  async verifyAudit() {
    const result = document.getElementById('verify-result');
    result.textContent = 'Verifying...';
    result.className = 'status-text';

    try {
      const data = await this.fetch('/api/audit/verify');
      if (data.chainIntegrity === 'verified') {
        result.textContent = '\u2714 Chain verified (' + data.valid + ' entries)';
        result.className = 'status-text verified';
      } else {
        result.textContent = '\u2718 Chain broken (' + data.invalid + ' invalid entries)';
        result.className = 'status-text broken';
      }
    } catch {
      result.textContent = 'Verification failed';
      result.className = 'status-text broken';
    }
  },

  // ── Metrics ──
  async loadMetrics() {
    const cards = document.getElementById('metrics-cards');
    const chart = document.getElementById('usage-chart');
    cards.innerHTML = '<div class="loading">Loading metrics...</div>';

    try {
      const [summary, usage] = await Promise.all([
        this.fetch('/api/metrics/summary'),
        this.fetch('/api/usage'),
      ]);

      cards.innerHTML = `
        <div class="card">
          <div class="card-stat">${summary.sessions}</div>
          <div class="card-label">Total Sessions</div>
        </div>
        <div class="card">
          <div class="card-stat">${summary.auditEntries}</div>
          <div class="card-label">Audit Entries</div>
        </div>
        <div class="card">
          <div class="card-stat">${Object.keys(summary.toolUsage || {}).length}</div>
          <div class="card-label">Tools Used</div>
        </div>
      `;

      // Render usage bar chart
      if (usage.usage && usage.usage.length > 0) {
        const maxMessages = Math.max(...usage.usage.map(u => u.messageCount), 1);
        chart.innerHTML = `
          <h3 style="margin-bottom:16px;font-size:14px;color:var(--text-secondary)">Recent Sessions</h3>
          <div class="bar-chart">
            ${usage.usage.map(u => {
              const height = Math.max(5, (u.messageCount / maxMessages) * 130);
              const label = u.sessionId.substring(0, 8);
              return `<div class="bar" style="height:${height}px">
                <span class="bar-value">${u.messageCount}</span>
                <span class="bar-label">${this.escapeHtml(label)}</span>
              </div>`;
            }).join('')}
          </div>
        `;
      } else {
        chart.innerHTML = '<div class="empty-state">No usage data available</div>';
      }
    } catch {
      cards.innerHTML = '<div class="empty-state">Error loading metrics</div>';
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
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  truncate(str, max) {
    if (!str || str.length <= max) return str || '';
    return str.substring(0, max) + '...';
  },

  formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  },
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
