import type { AgentEvent } from 'codebot-ai';

// ── Messages from Extension (backend) to Webview (frontend) ─────────────

export interface AgentEventMessage {
  type: 'agentEvent';
  event: AgentEvent;
}

export interface SessionStartedMessage {
  type: 'sessionStarted';
  provider: string;
  model: string;
}

export interface SessionEndedMessage {
  type: 'sessionEnded';
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ExtensionToWebviewMessage =
  | AgentEventMessage
  | SessionStartedMessage
  | SessionEndedMessage
  | ErrorMessage;

// ── Messages from Webview (frontend) to Extension (backend) ─────────────

export interface SendMessageRequest {
  type: 'sendMessage';
  text: string;
}

export interface CancelSessionRequest {
  type: 'cancelSession';
}

export interface ClearHistoryRequest {
  type: 'clearHistory';
}

export type WebviewToExtensionMessage =
  | SendMessageRequest
  | CancelSessionRequest
  | ClearHistoryRequest;
