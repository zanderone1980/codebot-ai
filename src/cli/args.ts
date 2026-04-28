/**
 * CLI argument parsing and help display.
 * Extracted from cli.ts for maintainability.
 */

import { DEFAULT_DASHBOARD_PORT } from './dashboard-config';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function c(text: string, style: keyof typeof C): string {
  return `${C[style]}${text}${C.reset}`;
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      result.version = true;
      continue;
    }
    if (arg === '--auto-approve' || arg === '--autonomous' || arg === '--auto') {
      result['auto-approve'] = true;
      result.autonomous = true;
      result.auto = true;
      continue;
    }
    // PR 11 — `--allow-capability <comma-list>`. Session-only opt-in
    // for labels that would otherwise force interactive approval. The
    // raw string is preserved here; parseAllowCapabilityFlag() in
    // capability-allowlist.ts validates the closed set and the
    // never-allowable hard excludes (move-money, spend-money,
    // send-on-behalf, delete-data) at agent startup.
    if (arg === '--allow-capability') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        // Surfaces as a startup-time validation error rather than a
        // silent ignore — see config.ts for the exact message.
        result['allow-capability'] = '';
      } else {
        result['allow-capability'] = next;
        i++;
      }
      continue;
    }
    if (arg === '--continue' || arg === '-c') {
      result.continue = true;
      continue;
    }
    if (arg === '--setup' || arg === '--init') {
      result.setup = true;
      continue;
    }
    if (arg === '--init-policy') {
      result['init-policy'] = true;
      continue;
    }
    if (arg === '--sandbox-info') {
      result['sandbox-info'] = true;
      continue;
    }
    if (arg === '--verify-audit') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result['verify-audit'] = next;
        i++;
      } else {
        result['verify-audit'] = true;
      }
      continue;
    }
    if (arg === '--export-audit') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result['export-audit'] = next;
        i++;
      } else {
        result['export-audit'] = true;
      }
      continue;
    }
    if (arg === '--replay') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result['replay'] = next;
        i++;
      } else {
        result['replay'] = true;
      }
      continue;
    }
    if (arg === '--dashboard') {
      result.dashboard = true;
      continue;
    }
    // Vault Mode — turn CodeBot into a read-only research assistant over a
    // folder of markdown notes (Obsidian vault, plain directory, whatever).
    //   --vault <path>            : path to the vault
    //   --vault-writable          : allow edit_file / write_file tools
    //   --vault-allow-network     : allow web_fetch / http_client tools
    if (arg === '--vault') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--vault requires a path argument, e.g. --vault ~/Documents/my-notes');
      }
      result.vault = next;
      i++;
      continue;
    }
    if (arg === '--vault-writable') {
      result['vault-writable'] = true;
      continue;
    }
    if (arg === '--vault-allow-network') {
      result['vault-allow-network'] = true;
      continue;
    }
    if (arg === '--daemon') {
      result.daemon = true;
      continue;
    }
    if (arg === '--host') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result.host = next;
        i++;
      }
      continue;
    }
    if (arg === '--tui') {
      result.tui = true;
      continue;
    }
    if (arg === '--no-stream') {
      result.noStream = true;
      continue;
    }
    if (arg === '--theme') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result.theme = next;
        i++;
      } else {
        result.theme = true;
      }
      continue;
    }
    if (arg === '--doctor') {
      result.doctor = true;
      continue;
    }
    if (arg === '--preset') {
      const next = argv[i + 1];
      result.preset = next && !next.startsWith('--') ? next : true;
      if (typeof result.preset === 'string') i++;
      continue;
    }
    if (arg === '--init-preset') {
      const next = argv[i + 1];
      result['init-preset'] = next && !next.startsWith('--') ? next : true;
      if (typeof result['init-preset'] === 'string') i++;
      continue;
    }
    if (arg === '--core-only') {
      result['core-only'] = true;
      continue;
    }
    if (arg === '--task') {
      const next = argv[i + 1];
      result.task = next && !next.startsWith('--') ? next : true;
      if (typeof result.task === 'string') i++;
      continue;
    }
    if (arg === '--audit-log') {
      const next = argv[i + 1];
      result['audit-log'] = next && !next.startsWith('--') ? next : '';
      i++;
      continue;
    }
    if (arg === '--output') {
      const next = argv[i + 1];
      result.output = next || 'text';
      i++;
      continue;
    }
    if (arg === '--max-cost') {
      const next = argv[i + 1];
      result['max-cost'] = next;
      i++;
      continue;
    }

    if (arg === '--solve') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result['solve'] = next;
        i++;
      } else {
        result['solve'] = true;
      }
      continue;
    }
    if (arg === '--open-pr') {
      result['open-pr'] = true;
      continue;
    }
    if (arg === '--safe') {
      result['safe'] = true;
      continue;
    }
    if (arg === '--no-constitutional') {
      result['no-constitutional'] = true;
      continue;
    }
    if (arg === '--dry-run' || arg === '--estimate') {
      result['dry-run'] = true;
      continue;
    }
    if (arg === '--deterministic') {
      result['deterministic'] = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      // Issue #7: don't let an unknown flag swallow the user's task message.
      //
      // Legitimate flag values are short identifiers (URLs, model names,
      // file paths, numbers, integers). Real task messages are long and
      // typically contain spaces. If `next` looks like a sentence rather
      // than a flag value, treat the current flag as a boolean and let
      // `next` fall through to the positional path on the next iteration.
      const looksLikeMessage = !!next && (next.length > 60 || /\s/.test(next));
      if (next && !next.startsWith('--') && !looksLikeMessage) {
        result[key] = next;
        i++;
      } else {
        result[key] = true;
      }
      continue;
    }
    positional.push(arg);
  }

  if (positional.length > 0) {
    result.message = positional.join(' ');
  }

  return result;
}

export function showHelp() {
  console.log(`${c('CodeBot AI', 'bold')} - Local-first AI coding assistant

${c('Quick Start:', 'bold')}
  codebot --setup                  Run interactive setup wizard
  codebot                          Start interactive mode
  codebot "fix the bug in app.ts"  Single message mode
  echo "explain this" | codebot    Pipe mode

${c('Options:', 'bold')}
  --setup              Run the setup wizard (auto-runs on first use)
  --model <name>       Model to use (default: qwen2.5-coder:32b)
  --provider <name>    Provider: openai, anthropic, gemini, deepseek, groq, mistral, xai
  --base-url <url>     LLM API base URL (auto-detects Ollama/LM Studio/vLLM + cloud)
  --api-key <key>      API key (or set provider-specific env var)
  --dashboard          Start web dashboard on port ${DEFAULT_DASHBOARD_PORT}
  --daemon             Start persistent background daemon
  --vault <path>       Vault Mode: research-assistant over a folder of markdown notes
                       (read-only by default, no network calls, full audit log)
  --vault-writable     Allow edit_file / write_file in vault mode
  --vault-allow-network  Allow web_fetch / http_client in vault mode
  --host <addr>        Dashboard bind address (default: 127.0.0.1, use 0.0.0.0 for LAN)
  --tui                Full-screen TUI mode with panels
  --no-stream          Suppress streaming progress indicators
  --theme <name>       Theme: dark, light, mono (default: auto)
  --autonomous         Skip ALL permission prompts — full auto mode
  --auto-approve       Same as --autonomous
  --allow-capability <list>  Comma-separated capability labels to bypass
                       interactive approval in unattended mode. Required
                       alongside --auto-approve for any tool that carries
                       account-access / write-fs / run-cmd / net-fetch /
                       browser-write labels. Refuses move-money,
                       spend-money, send-on-behalf, delete-data — those
                       still require per-call interactive approval.
                       Example: --allow-capability account-access,net-fetch
  --resume <id>        Resume a previous session by ID
  --continue, -c       Resume the most recent session
  --max-iterations <n> Max agent loop iterations (default: 50)
  --sandbox <mode>     Execution sandbox: docker, host, auto (default: auto)
  -h, --help           Show this help
  -v, --version        Show version

${c('Security & Policy:', 'bold')}
  --init-policy        Generate default .codebot/policy.json
  --verify-audit [id]  Verify audit log hash chain integrity
  --export-audit sarif Export audit log as SARIF 2.1.0 JSON
  --sandbox-info       Show Docker sandbox status

${c('Diagnostics:', 'bold')}
  --doctor             Run environment health check
  --dry-run, --estimate Estimate cost without executing
  --heartbeat <on|off|status>
                       Anonymous opt-in install ping (see docs/PRIVACY.md)

${c('Issue Solving:', 'bold')}
  --solve <url>          Solve a GitHub issue autonomously
  --open-pr              Push branch and create PR (default: dry-run)
  --safe                 Conservative mode (max 3 files, no dep changes)
  --max-files <n>        Max files to modify (default: 10)
  --timeout-min <n>      Hard timeout in minutes (default: 20)
  --json                 Structured JSON output

${c('Constitutional Safety:', 'bold')}
  --no-constitutional    Disable CORD + VIGIL safety layer
  (enabled by default — 14-dimension constitutional evaluation + threat patrol)

${c('Debugging & Replay:', 'bold')}
  --replay [id]        Replay a session, re-execute tools, compare outputs
  --deterministic      Set temperature=0 for reproducible outputs

${c('Supported Providers:', 'bold')}
  Local:      Ollama, LM Studio, vLLM (auto-detected)
  Anthropic:  Claude Opus/Sonnet/Haiku (ANTHROPIC_API_KEY)
  OpenAI:     GPT-4o, GPT-4.1, o1/o3/o4 (OPENAI_API_KEY)
  Google:     Gemini 2.5/2.0/1.5 (GEMINI_API_KEY)
  DeepSeek:   deepseek-chat, deepseek-reasoner (DEEPSEEK_API_KEY)
  Groq:       Llama, Mixtral on Groq (GROQ_API_KEY)
  Mistral:    mistral-large, codestral (MISTRAL_API_KEY)
  xAI:        Grok-3 (XAI_API_KEY)

${c('Examples:', 'bold')}
  codebot --model claude-opus-4-6          Uses Anthropic API
  codebot --model gpt-4o                   Uses OpenAI API
  codebot --model gemini-2.5-pro           Uses Gemini API
  codebot --model deepseek-chat            Uses DeepSeek API
  codebot --model qwen2.5-coder:32b        Uses local Ollama
  codebot --autonomous "refactor src/"     Full auto, no prompts
  codebot --init-policy                    Create security policy
  codebot --verify-audit                   Check audit integrity
  codebot --export-audit sarif > r.sarif   Export SARIF report

${c('Interactive Commands:', 'bold')}
  /help      Show commands
  /model     Show or change model
  /models    List all supported models
  /sessions  List saved sessions
  /auto      Toggle autonomous mode
  /clear     Clear conversation
  /compact   Force context compaction
  /usage     Show token usage & cost
  /cost      Show running cost
  /metrics   Show session metrics
  /risk      Show risk assessment summary
  /policy    Show security policy
  /audit     Verify session audit chain
  /rate      Show provider rate limits
  /theme     Show or change theme
  /doctor    Run environment health check
  /toolcost  Show per-tool cost breakdown
  /config    Show configuration
  /quit      Exit`);
}
