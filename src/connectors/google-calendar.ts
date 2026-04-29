/**
 * Google Calendar Connector — list / create / update / delete / find_free_time.
 *
 * Auth: Bearer OAuth token (Google Calendar API v3). Env: GOOGLE_CALENDAR_TOKEN.
 *
 * §8 Connector Contract (PR 14)
 * -----------------------------
 * Five actions, all migrated to the contract:
 *
 *   list_events     — read   ['read-only', 'account-access', 'net-fetch']
 *   find_free_time  — read   ['read-only', 'account-access', 'net-fetch']
 *
 *   create_event    — write  ['account-access', 'net-fetch', 'send-on-behalf']
 *                     idempotency: { kind: 'arg', arg: 'request_id' }
 *                     Google Calendar genuinely supports a client-supplied
 *                     `events.insert?requestId=…` parameter explicitly for
 *                     "create events idempotently" — rare among Google APIs.
 *                     See https://developers.google.com/calendar/api/v3/reference/events/insert
 *
 *   update_event    — write  ['account-access', 'net-fetch', 'send-on-behalf']
 *                     idempotency: { kind: 'unsupported', reason: ... }
 *                     `events.patch` has no idempotency-key parameter. ETag /
 *                     If-Match provides optimistic concurrency, NOT
 *                     idempotency. Two PATCHes with the same payload but
 *                     different sequenceNumbers are accepted by the API
 *                     and may produce different results, so the connector
 *                     does NOT treat that as safe-retry semantics.
 *
 *   delete_event    — write  ['account-access', 'net-fetch', 'send-on-behalf', 'delete-data']
 *                     idempotency: { kind: 'unsupported', reason: ... }
 *                     HTTP DELETE on Google Calendar events is naturally
 *                     idempotent (second call returns 410 Gone), but no
 *                     client-supplied idempotency key exists. The
 *                     connector documents this gap and does NOT pretend
 *                     the natural HTTP semantics are equivalent to a
 *                     server-checked dedup contract.
 *
 * Reauth detection (`isGoogleCalendarAuthError`)
 * ----------------------------------------------
 * 401 is always reauth (Google rotates OAuth bearer tokens; expired
 * access tokens land here). 403 is split — Google returns 403 for both
 * auth-class problems (insufficient scope, deleted credentials) and
 * non-auth quota / rate problems. Only 403s whose `error.errors[].reason`
 * names auth (`authError`, `invalidCredentials`, `forbidden`,
 * `insufficientPermissions`) trigger reauth. 403s with `rateLimitExceeded`,
 * `userRateLimitExceeded`, `quotaExceeded`, `dailyLimitExceeded` are NOT
 * reauth — the user just waits.
 *
 * `vaultKeyName: 'google_calendar'` declared explicitly.
 */

import { Connector, ConnectorAction, ConnectorPreview, ConnectorReauthError } from './base';
import { createHash } from 'crypto';

const TIMEOUT = 15_000;
const MAX_RESPONSE = 10_000;
const CAL_API = 'https://www.googleapis.com/calendar/v3';

function truncate(text: string): string {
  return text.length <= MAX_RESPONSE ? text : text.substring(0, MAX_RESPONSE) + '\n... (truncated)';
}

/** SHA-256 hash + length for audit redaction. Hex, first 16 chars. */
function hashAndLength(value: string): { hash: string; length: number } {
  return {
    hash: createHash('sha256').update(value).digest('hex').substring(0, 16),
    length: value.length,
  };
}

// ─── Reauth classifier (pure, no network) ─────────────────────────────────

interface GoogleApiError {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    errors?: Array<{ reason?: string; domain?: string; message?: string }>;
  };
}

/**
 * Decide whether a Google Calendar API response (status + body) indicates
 * a reauth-class failure. Pure function — no I/O. Exported so the test
 * suite can exercise the classification table without mocking fetch.
 *
 * Rules:
 *   - 401 → always reauth (token expired / revoked).
 *   - 403 with `errors[].reason` in the auth-class set → reauth.
 *   - 403 with `errors[].reason` in the rate/quota set → NOT reauth.
 *   - 403 with no recognizable reason → NOT reauth (fail closed: don't
 *     trigger a misleading reconnect prompt for an obscure permission
 *     issue we can't classify).
 *   - Anything else → NOT reauth.
 *
 * Keep this in sync with the Google Calendar API error reference:
 * https://developers.google.com/calendar/api/guides/errors
 */
const GOOGLE_AUTH_REASONS: ReadonlySet<string> = new Set([
  'authError',
  'invalidCredentials',
  'insufficientPermissions',
]);
const GOOGLE_NON_AUTH_403_REASONS: ReadonlySet<string> = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
  'variableTermLimitExceeded',
  'requestThrottled',
]);

export function isGoogleCalendarAuthError(status: number, body: GoogleApiError | undefined): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;
  const errs = body?.error?.errors ?? [];
  // Explicit non-auth wins over explicit auth (rate-limit + auth in the
  // same response is ambiguous; treat conservatively as non-auth so the
  // user retries rather than reconnects).
  if (errs.some(e => e.reason && GOOGLE_NON_AUTH_403_REASONS.has(e.reason))) return false;
  if (errs.some(e => e.reason && GOOGLE_AUTH_REASONS.has(e.reason))) return true;
  return false;
}

// ─── HTTP wrapper ─────────────────────────────────────────────────────────

async function calFetch(
  endpoint: string,
  token: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(`${CAL_API}${endpoint}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    // 204 No Content (DELETE success) has no body — handle gracefully
    // so the parser doesn't throw on empty input.
    let data: Record<string, unknown> = {};
    if (res.status !== 204) {
      try { data = (await res.json()) as Record<string, unknown>; } catch { data = {}; }
    }
    if (isGoogleCalendarAuthError(res.status, data as GoogleApiError)) {
      throw new ConnectorReauthError('google_calendar', `Google Calendar auth failed: HTTP ${res.status}`);
    }
    return { status: res.status, data };
  } catch (err: unknown) {
    clearTimeout(timer);
    throw err;
  }
}

function formatEvent(event: Record<string, unknown>): string {
  const summary = (event.summary as string) || '(no title)';
  const start = event.start as Record<string, string> | undefined;
  const end = event.end as Record<string, string> | undefined;
  const startTime = start?.dateTime || start?.date || '?';
  const endTime = end?.dateTime || end?.date || '';
  const location = (event.location as string) || '';
  const description = (event.description as string) || '';
  const id = (event.id as string) || '';

  let line = `  [${id.substring(0, 12)}] ${summary}\n    When: ${startTime}`;
  if (endTime) line += ` → ${endTime}`;
  if (location) line += `\n    Where: ${location}`;
  if (description) line += `\n    Notes: ${description.substring(0, 100)}`;
  return line;
}

// ─── Idempotency declaration constants ────────────────────────────────────

const UPDATE_EVENT_IDEMPOTENCY_REASON =
  'Google Calendar events.patch does not accept a client-supplied idempotency key. ETag (If-Match) provides optimistic concurrency — refusing the second write if the resource changed — but is not idempotency: two patches with identical payloads at different sequenceNumbers are both accepted and may produce different observable states. The connector does NOT treat ETag as safe-retry semantics.';

const DELETE_EVENT_IDEMPOTENCY_REASON =
  'Google Calendar events.delete is naturally idempotent at the HTTP level — a second DELETE on a removed event returns 410 Gone — but the API exposes no client-supplied idempotency key. The connector documents this gap rather than equating natural HTTP semantics with a server-checked dedup contract; a duplicate delete cannot be distinguished from a stale-id delete by the server.';

// ─── Redaction helpers ────────────────────────────────────────────────────

/**
 * Redact `description` to hash+length and `attendees` to a count of
 * email addresses. Keep `title`, `start`, `end`, `location` visible —
 * auditors need to know what meeting was created/changed, but emails
 * and notes are PII / message-class content.
 */
function redactWriteEventArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (typeof args.description === 'string') {
    const d = hashAndLength(args.description);
    out.description = `<redacted sha256:${d.hash} len:${d.length}>`;
  }
  if (typeof args.attendees === 'string' && args.attendees.length > 0) {
    const count = args.attendees.split(',').filter(s => s.trim().length > 0).length;
    const d = hashAndLength(args.attendees);
    out.attendees = `<redacted ${count} email(s) sha256:${d.hash} len:${d.length}>`;
  }
  return out;
}

// ─── Preview functions (pure, no network) ─────────────────────────────────

function previewCreateEvent(args: Record<string, unknown>): ConnectorPreview {
  const title = String(args.title ?? '');
  const start = String(args.start ?? '');
  const end = typeof args.end === 'string' && args.end.length > 0 ? args.end : '(default: start + 1h)';
  const location = typeof args.location === 'string' && args.location.length > 0 ? args.location : '';
  const calendar = typeof args.calendar === 'string' && args.calendar.length > 0 ? args.calendar : 'primary';
  const requestId = typeof args.request_id === 'string' && args.request_id.length > 0 ? args.request_id : '(none — server-only dedup)';
  const description = typeof args.description === 'string' ? args.description : '';
  const descDigest = description.length > 0 ? hashAndLength(description) : null;
  const attendeesStr = typeof args.attendees === 'string' ? args.attendees : '';
  const attendeeCount = attendeesStr.length > 0
    ? attendeesStr.split(',').filter(s => s.trim().length > 0).length
    : 0;

  const lines = [
    `Would create Google Calendar event:`,
    `  Calendar:    ${calendar}`,
    `  Title:       ${title}`,
    `  Start:       ${start}`,
    `  End:         ${end}`,
    location ? `  Location:    ${location}` : '',
    descDigest ? `  Notes:       ${descDigest.length} chars (sha256:${descDigest.hash})` : '',
    attendeeCount > 0 ? `  Attendees:   ${attendeeCount} email(s) — invites WILL be sent on commit` : '  Attendees:   (none)',
    `  request_id:  ${requestId}`,
  ].filter(Boolean);

  return {
    summary: lines.join('\n'),
    details: {
      calendar,
      title,
      start,
      end: typeof args.end === 'string' ? args.end : null,
      location: location || null,
      attendeeCount,
      descriptionLength: descDigest?.length ?? 0,
      descriptionHash: descDigest?.hash ?? null,
      requestId: typeof args.request_id === 'string' ? args.request_id : null,
    },
  };
}

function previewUpdateEvent(args: Record<string, unknown>): ConnectorPreview {
  const eventId = String(args.event_id ?? '');
  const calendar = typeof args.calendar === 'string' && args.calendar.length > 0 ? args.calendar : 'primary';
  const changes: string[] = [];
  if (typeof args.title === 'string') changes.push(`  title → ${args.title}`);
  if (typeof args.start === 'string') changes.push(`  start → ${args.start}`);
  if (typeof args.end === 'string') changes.push(`  end → ${args.end}`);
  if (typeof args.location === 'string') changes.push(`  location → ${args.location}`);
  if (typeof args.description === 'string') {
    const d = hashAndLength(args.description);
    changes.push(`  description → ${d.length} chars (sha256:${d.hash})`);
  }
  const summary = changes.length === 0
    ? `Would update Google Calendar event ${eventId} on calendar=${calendar} — but NO fields are set; the API call would error.`
    : `Would update Google Calendar event ${eventId} on calendar=${calendar}:\n${changes.join('\n')}`;
  return {
    summary,
    details: {
      calendar,
      eventId,
      changedFields: changes.length,
    },
  };
}

function previewDeleteEvent(args: Record<string, unknown>): ConnectorPreview {
  const eventId = String(args.event_id ?? '');
  const calendar = typeof args.calendar === 'string' && args.calendar.length > 0 ? args.calendar : 'primary';
  return {
    summary:
      `Would DELETE Google Calendar event:\n` +
      `  Calendar: ${calendar}\n` +
      `  Event ID: ${eventId}\n` +
      `  Effect:   removes from your calendar AND all attendees' calendars (if any). Not recoverable except via the Calendar undo window.`,
    details: { calendar, eventId },
  };
}

// ─── Action definitions ───────────────────────────────────────────────────

const listEvents: ConnectorAction = {
  name: 'list_events',
  description: 'List upcoming calendar events',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'number', description: 'Number of days ahead to look (default 7, max 30)' },
      count: { type: 'number', description: 'Max events to return (default 10, max 50)' },
      calendar: { type: 'string', description: 'Calendar ID (default "primary")' },
    },
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const days = Math.min((args.days as number) || 7, 30);
    const count = Math.min((args.count as number) || 10, 50);
    const calendar = (args.calendar as string) || 'primary';
    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    try {
      const { status, data } = await calFetch(
        `/calendars/${encodeURIComponent(calendar)}/events?timeMin=${now.toISOString()}&timeMax=${future.toISOString()}&maxResults=${count}&singleEvents=true&orderBy=startTime`,
        cred,
      );
      if (status !== 200) return `Error: Calendar API ${status}: ${JSON.stringify(data).substring(0, 200)}`;
      const events = (data.items as Array<Record<string, unknown>>) || [];
      if (!events.length) return `No events in the next ${days} days.`;
      return truncate(`Upcoming events (next ${days} days):\n\n${events.map(formatEvent).join('\n\n')}`);
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const createEvent: ConnectorAction = {
  name: 'create_event',
  description: 'Create a new calendar event. Pass `request_id` for idempotent retries.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Event title/summary' },
      start: { type: 'string', description: 'Start time (ISO 8601, e.g., "2025-03-15T10:00:00-07:00")' },
      end: { type: 'string', description: 'End time (ISO 8601). Defaults to start + 1h.' },
      location: { type: 'string', description: 'Event location' },
      description: { type: 'string', description: 'Event description/notes' },
      attendees: { type: 'string', description: 'Comma-separated email addresses of attendees. Invites will be sent.' },
      calendar: { type: 'string', description: 'Calendar ID (default "primary")' },
      request_id: { type: 'string', description: 'Idempotency key — Google Calendar dedups events.insert by this value within ~24h. Optional but recommended for retries.' },
    },
    required: ['title', 'start'],
  },
  capabilities: ['account-access', 'net-fetch', 'send-on-behalf'],
  preview: async (args, _credential): Promise<ConnectorPreview> => previewCreateEvent(args),
  redactArgsForAudit: redactWriteEventArgs,
  idempotency: { kind: 'arg', arg: 'request_id' },
  execute: async (args, cred) => {
    const title = args.title as string;
    const start = args.start as string;
    if (!title || !start) return 'Error: title and start are required';
    const calendar = (args.calendar as string) || 'primary';

    let endTime = args.end as string;
    if (!endTime) {
      const startDate = new Date(start);
      startDate.setHours(startDate.getHours() + 1);
      endTime = startDate.toISOString();
    }

    const event: Record<string, unknown> = {
      summary: title,
      start: { dateTime: start },
      end: { dateTime: endTime },
    };
    if (args.location) event.location = args.location;
    if (args.description) event.description = args.description;
    if (args.attendees) {
      event.attendees = (args.attendees as string).split(',').map(e => ({ email: e.trim() }));
    }

    // Honor the user-supplied idempotency key. Google Calendar's
    // events.insert accepts ?requestId=<opaque-string>; per the API
    // docs, identical requestIds within ~24 hours return the same
    // event rather than creating duplicates.
    let endpoint = `/calendars/${encodeURIComponent(calendar)}/events`;
    if (typeof args.request_id === 'string' && args.request_id.length > 0) {
      endpoint += `?requestId=${encodeURIComponent(args.request_id)}`;
    }

    try {
      const { status, data } = await calFetch(endpoint, cred, 'POST', event);
      if (status === 200 || status === 201) {
        const link = (data.htmlLink as string) || '';
        return `Event created: "${title}" on ${start}${link ? `\nLink: ${link}` : ''}`;
      }
      return `Error: Calendar API ${status}: ${JSON.stringify(data).substring(0, 200)}`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const updateEvent: ConnectorAction = {
  name: 'update_event',
  description: 'Update an existing calendar event',
  parameters: {
    type: 'object',
    properties: {
      event_id: { type: 'string', description: 'Event ID to update' },
      title: { type: 'string', description: 'New event title' },
      start: { type: 'string', description: 'New start time (ISO 8601)' },
      end: { type: 'string', description: 'New end time (ISO 8601)' },
      location: { type: 'string', description: 'New location' },
      description: { type: 'string', description: 'New description' },
      calendar: { type: 'string', description: 'Calendar ID (default "primary")' },
    },
    required: ['event_id'],
  },
  capabilities: ['account-access', 'net-fetch', 'send-on-behalf'],
  preview: async (args, _credential): Promise<ConnectorPreview> => previewUpdateEvent(args),
  redactArgsForAudit: redactWriteEventArgs,
  idempotency: { kind: 'unsupported', reason: UPDATE_EVENT_IDEMPOTENCY_REASON },
  execute: async (args, cred) => {
    const eventId = args.event_id as string;
    if (!eventId) return 'Error: event_id is required';
    const calendar = (args.calendar as string) || 'primary';

    const updates: Record<string, unknown> = {};
    if (args.title) updates.summary = args.title;
    if (args.start) updates.start = { dateTime: args.start };
    if (args.end) updates.end = { dateTime: args.end };
    if (args.location) updates.location = args.location;
    if (args.description) updates.description = args.description;

    if (Object.keys(updates).length === 0) {
      return 'Error: No fields to update. Provide at least one of: title, start, end, location, description.';
    }

    try {
      const { status, data } = await calFetch(
        `/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}`,
        cred,
        'PATCH',
        updates,
      );
      if (status === 200) {
        return `Event updated: "${(data.summary as string) || eventId}"`;
      }
      return `Error: Calendar API ${status}: ${JSON.stringify(data).substring(0, 200)}`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const deleteEvent: ConnectorAction = {
  name: 'delete_event',
  description: 'Delete a calendar event. Removes from attendees calendars too.',
  parameters: {
    type: 'object',
    properties: {
      event_id: { type: 'string', description: 'Event ID to delete' },
      calendar: { type: 'string', description: 'Calendar ID (default "primary")' },
    },
    required: ['event_id'],
  },
  capabilities: ['account-access', 'net-fetch', 'send-on-behalf', 'delete-data'],
  preview: async (args, _credential): Promise<ConnectorPreview> => previewDeleteEvent(args),
  // The contract requires every mutating verb to declare
  // redactArgsForAudit explicitly — even when no redaction is needed —
  // so the decision is a deliberate one and not a silent default. For
  // delete_event, `event_id` and `calendar` are not secrets and contain
  // no PII; the audit row should preserve them so a forensic reader can
  // identify exactly which event was removed. We declare an identity
  // redactor with that intent in writing.
  redactArgsForAudit: (args: Record<string, unknown>): Record<string, unknown> => ({ ...args }),
  idempotency: { kind: 'unsupported', reason: DELETE_EVENT_IDEMPOTENCY_REASON },
  execute: async (args, cred) => {
    const eventId = args.event_id as string;
    if (!eventId) return 'Error: event_id is required';
    const calendar = (args.calendar as string) || 'primary';

    try {
      const { status, data } = await calFetch(
        `/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}`,
        cred,
        'DELETE',
      );
      if (status === 204 || status === 200) return `Event deleted: ${eventId}`;
      if (status === 410) return `Event already deleted: ${eventId} (HTTP 410 Gone)`;
      return `Error: Calendar API ${status}: ${JSON.stringify(data).substring(0, 200)}`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const findFreeTime: ConnectorAction = {
  name: 'find_free_time',
  description: 'Find free time slots in the calendar',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'number', description: 'Number of days to check (default 3, max 14)' },
      duration_minutes: { type: 'number', description: 'Minimum free slot duration in minutes (default 60)' },
      work_hours_start: { type: 'number', description: 'Work day start hour (default 9)' },
      work_hours_end: { type: 'number', description: 'Work day end hour (default 17)' },
    },
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const days = Math.min((args.days as number) || 3, 14);
    const minDuration = (args.duration_minutes as number) || 60;
    const workStart = (args.work_hours_start as number) || 9;
    const workEnd = (args.work_hours_end as number) || 17;

    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    try {
      const { status, data } = await calFetch(
        `/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${future.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=100`,
        cred,
      );
      if (status !== 200) return `Error: Calendar API ${status}: ${JSON.stringify(data).substring(0, 200)}`;

      const events = (data.items as Array<Record<string, unknown>>) || [];
      const freeSlots: string[] = [];
      for (let d = 0; d < days; d++) {
        const day = new Date(now);
        day.setDate(day.getDate() + d);
        if (day.getDay() === 0 || day.getDay() === 6) continue;

        const dayStart = new Date(day);
        dayStart.setHours(workStart, 0, 0, 0);
        const dayEnd = new Date(day);
        dayEnd.setHours(workEnd, 0, 0, 0);

        const dayEvents = events.filter(e => {
          const start = (e.start as Record<string, string>)?.dateTime || (e.start as Record<string, string>)?.date;
          if (!start) return false;
          const eventDate = new Date(start);
          return eventDate >= dayStart && eventDate < dayEnd;
        }).sort((a, b) => {
          const aStart = new Date((a.start as Record<string, string>)?.dateTime || '');
          const bStart = new Date((b.start as Record<string, string>)?.dateTime || '');
          return aStart.getTime() - bStart.getTime();
        });

        let cursor = dayStart.getTime();
        for (const event of dayEvents) {
          const eventStart = new Date((event.start as Record<string, string>)?.dateTime || '').getTime();
          const eventEnd = new Date((event.end as Record<string, string>)?.dateTime || '').getTime();
          const gap = (eventStart - cursor) / (60 * 1000);
          if (gap >= minDuration) {
            freeSlots.push(`  ${new Date(cursor).toLocaleString()} → ${new Date(eventStart).toLocaleString()} (${Math.round(gap)} min)`);
          }
          cursor = Math.max(cursor, eventEnd);
        }
        const remaining = (dayEnd.getTime() - cursor) / (60 * 1000);
        if (remaining >= minDuration) {
          freeSlots.push(`  ${new Date(cursor).toLocaleString()} → ${dayEnd.toLocaleString()} (${Math.round(remaining)} min)`);
        }
      }

      if (!freeSlots.length) return `No free slots of ${minDuration}+ minutes found in the next ${days} days.`;
      return truncate(`Free time slots (${minDuration}+ min, ${workStart}:00-${workEnd}:00):\n\n${freeSlots.join('\n')}`);
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ─── Connector ────────────────────────────────────────────────────────────

export class GoogleCalendarConnector implements Connector {
  name = 'google_calendar';
  displayName = 'Google Calendar';
  description = 'List, create, update, and delete events on Google Calendar.';
  authType: Connector['authType'] = 'api_key';
  envKey = 'GOOGLE_CALENDAR_TOKEN';
  vaultKeyName = 'google_calendar';

  actions: ConnectorAction[] = [
    listEvents,
    createEvent,
    updateEvent,
    deleteEvent,
    findFreeTime,
  ];

  async validate(credential: string): Promise<boolean> {
    try {
      const { status } = await calFetch('/calendars/primary', credential);
      return status === 200;
    } catch {
      return false;
    }
  }
}
