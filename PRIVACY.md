# Privacy Policy

## CodeBot AI — Privacy & Data Handling

**Effective date:** February 2026
**Last updated:** February 2026

### Summary

CodeBot AI is a local-first tool. Your code, conversations, and data stay on your machine. We do not collect, store, or transmit any personal information, source code, or usage data by default.

---

### 1. Local-Only Architecture

CodeBot AI runs entirely on your local machine or within your own CI/CD environment. There is no CodeBot cloud service, no account system, and no central server.

- **Source code** is read from and written to your local filesystem only
- **Session history** is stored locally at `~/.codebot/sessions/`
- **Audit logs** are stored locally at `~/.codebot/audit/`
- **Metrics** are stored locally at `~/.codebot/telemetry/`
- **Configuration** is stored locally at `~/.codebot/config.json`

### 2. LLM Provider Communication

CodeBot AI sends prompts to the LLM provider you configure (e.g., Anthropic, OpenAI, Google, Ollama). This communication is:

- **Your responsibility**: You choose which provider to use and accept their terms
- **Direct**: Requests go from your machine directly to the provider's API
- **Controlled by you**: You supply your own API key
- **Not proxied**: We do not route, intercept, or log API traffic

**What is sent to the LLM provider:**
- Your task instructions (the prompt)
- Relevant source code context (files the agent reads)
- Tool call results (command output, file contents)
- Conversation history for the current session

**What is NOT sent to the LLM provider:**
- Your API keys for other services
- Files outside the project scope (unless you explicitly configure it)
- Content blocked by secret detection
- Audit logs or session history

> **Important:** Review your LLM provider's privacy policy and data retention practices. When using cloud-hosted LLMs, your code is transmitted to their servers. For maximum privacy, use a local model via Ollama.

### 3. Telemetry

**Default: OFF**

CodeBot AI does not collect or transmit any telemetry by default.

**Optional OpenTelemetry export:** If you set the `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable, CodeBot will export structured metrics (token counts, tool call counts, latency histograms) to your specified endpoint. This is entirely opt-in and sends data only to infrastructure you control.

Telemetry data exported via OpenTelemetry includes:
- LLM request counts and token usage
- Tool call counts and latency
- Error and security block counts
- Session duration

Telemetry data does **not** include:
- Source code content
- Prompt or response text
- File paths or filenames
- Personal information
- API keys or credentials

### 4. VS Code Extension

The VS Code extension (`codebot-ai-vscode`) runs locally within your VS Code instance.

- Settings (provider, model, API key) are stored in VS Code's settings storage
- The extension does not communicate with any server other than your configured LLM provider
- Webview content is rendered locally with strict Content Security Policy
- No usage analytics or crash reporting

### 5. GitHub Action

The GitHub Action (`@codebot-ai/action`) runs within your GitHub Actions runner environment.

- The action reads your repository code from the runner's filesystem
- API keys should be stored as GitHub Secrets
- PR review comments are posted via the GitHub API using the provided token
- SARIF results are uploaded to GitHub Code Scanning (if enabled)
- No data is sent to any CodeBot-operated service

### 6. Data You Control

| Data | Location | You can delete it |
|------|----------|-------------------|
| Session history | `~/.codebot/sessions/` | Yes |
| Audit logs | `~/.codebot/audit/` | Yes |
| Metrics | `~/.codebot/telemetry/` | Yes |
| Configuration | `~/.codebot/config.json` | Yes |
| Policy files | `.codebot/policy.json` | Yes |

To delete all local data:
```bash
rm -rf ~/.codebot
```

### 7. Third-Party Services

CodeBot AI may interact with third-party services only when you explicitly use tools that require them:

| Tool | Service | When |
|------|---------|------|
| `web_search` | Brave Search API | When you ask the agent to search the web |
| `web_fetch` | Target website | When you ask the agent to fetch a URL |
| `browser` | Remote browser service | When you ask the agent to browse |

These interactions are initiated by your instructions, not automatically.

### 8. Children's Privacy

CodeBot AI is a developer tool and is not directed at children under 13. We do not knowingly collect information from children.

### 9. Changes to This Policy

We may update this privacy policy from time to time. Changes will be noted in the CHANGELOG and committed to the repository. The "Last updated" date at the top of this document indicates the most recent revision.

### 10. Contact

For privacy-related questions:
- Open an issue: https://github.com/zanderone1980/codebot-ai/issues
- Email: privacy@ascendral.com
