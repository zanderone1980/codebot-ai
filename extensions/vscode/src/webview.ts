import * as vscode from 'vscode';

/**
 * Generates the full HTML content for the chat webview panel.
 * Uses VS Code CSS custom properties for theme integration.
 */
export function getWebviewContent(
  webview: vscode.Webview,
  _extensionUri: vscode.Uri
): string {
  // Generate a nonce for Content-Security-Policy
  const nonce = getNonce();

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';"
  />
  <title>CodeBot AI</title>
  <style nonce="${nonce}">
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground, #cccccc);
      background-color: var(--vscode-editor-background, #1e1e1e);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Header ──────────────────────────────────────── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      background: var(--vscode-sideBar-background, #252526);
      flex-shrink: 0;
    }

    .header-title {
      font-weight: 600;
      font-size: 13px;
    }

    .header-info {
      font-size: 11px;
      opacity: 0.7;
    }

    .header-actions {
      display: flex;
      gap: 6px;
    }

    .header-btn {
      background: none;
      border: none;
      color: var(--vscode-editor-foreground, #ccc);
      cursor: pointer;
      padding: 4px 6px;
      border-radius: 3px;
      font-size: 12px;
    }

    .header-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, #333);
    }

    /* ── Message List ────────────────────────────────── */
    .message-list {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .message {
      padding: 8px 12px;
      border-radius: 6px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
      max-width: 100%;
    }

    .message-user {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      align-self: flex-end;
      border-radius: 6px 6px 2px 6px;
    }

    .message-assistant {
      background: var(--vscode-editorWidget-background, #2d2d30);
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      align-self: flex-start;
      border-radius: 6px 6px 6px 2px;
    }

    .message-thinking {
      background: transparent;
      color: var(--vscode-descriptionForeground, #888);
      font-style: italic;
      font-size: 12px;
      padding: 4px 12px;
      align-self: flex-start;
      opacity: 0.7;
    }

    .message-error {
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
      color: var(--vscode-errorForeground, #f48771);
      align-self: flex-start;
    }

    /* ── Tool Call Block ─────────────────────────────── */
    .tool-call {
      background: var(--vscode-textBlockQuote-background, #2a2a2d);
      border-left: 3px solid var(--vscode-activityBarBadge-background, #007acc);
      padding: 8px 12px;
      border-radius: 0 4px 4px 0;
      font-size: 12px;
      align-self: flex-start;
      max-width: 100%;
    }

    .tool-call-header {
      font-weight: 600;
      color: var(--vscode-textLink-foreground, #3794ff);
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .tool-call-risk {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      font-weight: 500;
    }

    .risk-low {
      background: #2d4a2d;
      color: #73c991;
    }

    .risk-medium {
      background: #4a3d1a;
      color: #cca700;
    }

    .risk-high {
      background: #4a1d1d;
      color: #f48771;
    }

    .tool-call-args {
      color: var(--vscode-descriptionForeground, #999);
      overflow-x: auto;
    }

    .tool-result {
      background: var(--vscode-textBlockQuote-background, #2a2a2d);
      border-left: 3px solid var(--vscode-testing-iconPassed, #388a34);
      padding: 8px 12px;
      border-radius: 0 4px 4px 0;
      font-size: 12px;
      align-self: flex-start;
      max-width: 100%;
      overflow-x: auto;
    }

    /* ── Usage Display ───────────────────────────────── */
    .usage-info {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      padding: 4px 12px;
      text-align: center;
      opacity: 0.7;
    }

    /* ── Input Area ──────────────────────────────────── */
    .input-area {
      display: flex;
      gap: 8px;
      padding: 10px 12px;
      border-top: 1px solid var(--vscode-panel-border, #444);
      background: var(--vscode-sideBar-background, #252526);
      flex-shrink: 0;
      align-items: flex-end;
    }

    .input-area textarea {
      flex: 1;
      resize: none;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 4px;
      padding: 8px 10px;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.4;
      min-height: 36px;
      max-height: 150px;
      outline: none;
    }

    .input-area textarea:focus {
      border-color: var(--vscode-focusBorder, #007acc);
    }

    .input-area textarea::placeholder {
      color: var(--vscode-input-placeholderForeground, #888);
    }

    .send-btn {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      border-radius: 4px;
      padding: 8px 14px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .send-btn:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }

    .send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* ── Spinner ─────────────────────────────────────── */
    .spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-descriptionForeground, #888);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 6px;
      vertical-align: middle;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* ── Scrollbar ────────────────────────────────────── */
    .message-list::-webkit-scrollbar {
      width: 6px;
    }

    .message-list::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background, #444);
      border-radius: 3px;
    }

    .message-list::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground, #555);
    }

    code {
      font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
      background: var(--vscode-textCodeBlock-background, #1a1a1a);
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 0.9em;
    }

    pre {
      background: var(--vscode-textCodeBlock-background, #1a1a1a);
      padding: 8px 10px;
      border-radius: 4px;
      overflow-x: auto;
      margin: 4px 0;
    }

    pre code {
      padding: 0;
      background: none;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="header-title">CodeBot AI</div>
      <div class="header-info" id="sessionInfo">No active session</div>
    </div>
    <div class="header-actions">
      <button class="header-btn" id="clearBtn" title="Clear history">Clear</button>
    </div>
  </div>

  <div class="message-list" id="messageList"></div>

  <div class="input-area">
    <textarea
      id="userInput"
      placeholder="Ask CodeBot anything..."
      rows="1"
    ></textarea>
    <button class="send-btn" id="sendBtn">Send</button>
  </div>

  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();

      const messageList = document.getElementById('messageList');
      const userInput = document.getElementById('userInput');
      const sendBtn = document.getElementById('sendBtn');
      const clearBtn = document.getElementById('clearBtn');
      const sessionInfo = document.getElementById('sessionInfo');

      let isRunning = false;
      let currentAssistantEl = null;

      // ── Outbound messages ─────────────────────────────

      function sendMessage() {
        const text = userInput.value.trim();
        if (!text || isRunning) return;

        appendMessage('user', text);
        vscode.postMessage({ type: 'sendMessage', text: text });
        userInput.value = '';
        autoResizeTextarea();
        setRunning(true);
        currentAssistantEl = null;
      }

      sendBtn.addEventListener('click', sendMessage);

      userInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      userInput.addEventListener('input', autoResizeTextarea);

      clearBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'clearHistory' });
        messageList.innerHTML = '';
        sessionInfo.textContent = 'No active session';
        currentAssistantEl = null;
      });

      // ── Inbound messages ──────────────────────────────

      window.addEventListener('message', function (event) {
        const msg = event.data;

        switch (msg.type) {
          case 'sessionStarted':
            sessionInfo.textContent = msg.provider + ' / ' + msg.model;
            break;

          case 'sessionEnded':
            setRunning(false);
            currentAssistantEl = null;
            break;

          case 'error':
            appendMessage('error', msg.message);
            setRunning(false);
            currentAssistantEl = null;
            break;

          case 'agentEvent':
            handleAgentEvent(msg.event);
            break;
        }
      });

      // ── Agent event rendering ─────────────────────────

      function handleAgentEvent(event) {
        switch (event.type) {
          case 'thinking':
            appendMessage('thinking', event.content || 'Thinking...');
            break;

          case 'text':
            if (!currentAssistantEl) {
              currentAssistantEl = appendMessage('assistant', '');
            }
            currentAssistantEl.textContent += (event.content || '');
            scrollToBottom();
            break;

          case 'tool_call':
            appendToolCall(event);
            break;

          case 'tool_result':
            appendToolResult(event);
            break;

          case 'done':
            setRunning(false);
            currentAssistantEl = null;
            break;

          case 'error':
            appendMessage('error', event.error || 'Unknown error');
            setRunning(false);
            currentAssistantEl = null;
            break;

          case 'compaction':
            appendMessage('thinking', '[Context compacted]');
            break;

          case 'usage':
            appendUsage(event);
            break;
        }
      }

      // ── DOM helpers ───────────────────────────────────

      function appendMessage(role, text) {
        const el = document.createElement('div');
        el.className = 'message message-' + role;

        if (role === 'assistant') {
          el.innerHTML = formatText(text);
        } else {
          el.textContent = text;
        }

        messageList.appendChild(el);
        scrollToBottom();
        return el;
      }

      function appendToolCall(event) {
        const el = document.createElement('div');
        el.className = 'tool-call';

        let headerHtml = '<div class="tool-call-header">';
        headerHtml += '<span>Tool: ' + escapeHtml(event.tool || event.name || 'unknown') + '</span>';

        if (event.risk) {
          const level = event.risk.level || 'low';
          headerHtml += '<span class="tool-call-risk risk-' + level + '">';
          headerHtml += 'Risk: ' + event.risk.score + ' (' + level + ')';
          headerHtml += '</span>';
        }

        headerHtml += '</div>';
        el.innerHTML = headerHtml;

        if (event.args || event.input) {
          const argsEl = document.createElement('div');
          argsEl.className = 'tool-call-args';
          const argsText = JSON.stringify(event.args || event.input, null, 2);
          argsEl.textContent = argsText.length > 500
            ? argsText.substring(0, 500) + '...'
            : argsText;
          el.appendChild(argsEl);
        }

        messageList.appendChild(el);
        scrollToBottom();
        currentAssistantEl = null;
      }

      function appendToolResult(event) {
        const el = document.createElement('div');
        el.className = 'tool-result';
        const result = event.result || event.output || '';
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        el.textContent = text.length > 1000
          ? text.substring(0, 1000) + '...'
          : text;
        messageList.appendChild(el);
        scrollToBottom();
      }

      function appendUsage(event) {
        const el = document.createElement('div');
        el.className = 'usage-info';
        const parts = [];
        if (event.inputTokens) parts.push('In: ' + event.inputTokens.toLocaleString());
        if (event.outputTokens) parts.push('Out: ' + event.outputTokens.toLocaleString());
        if (event.cost) parts.push('Cost: $' + event.cost.toFixed(4));
        el.textContent = parts.join(' | ');
        messageList.appendChild(el);
        scrollToBottom();
      }

      function formatText(text) {
        if (!text) return '';
        let html = escapeHtml(text);
        // Inline code
        html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
        // Bold
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        return html;
      }

      function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
      }

      function scrollToBottom() {
        requestAnimationFrame(function () {
          messageList.scrollTop = messageList.scrollHeight;
        });
      }

      function setRunning(running) {
        isRunning = running;
        sendBtn.disabled = running;
        sendBtn.textContent = running ? 'Stop' : 'Send';

        if (running) {
          sendBtn.onclick = function () {
            vscode.postMessage({ type: 'cancelSession' });
            setRunning(false);
          };
        } else {
          sendBtn.onclick = sendMessage;
        }
      }

      function autoResizeTextarea() {
        userInput.style.height = 'auto';
        userInput.style.height = Math.min(userInput.scrollHeight, 150) + 'px';
      }

      // Focus the input on load
      userInput.focus();
    })();
  </script>
</body>
</html>`;
}

/**
 * Generates a random nonce string for CSP.
 */
function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
