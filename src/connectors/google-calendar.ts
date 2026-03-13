/**
 * Google Calendar Connector — List, create, update, delete events.
 *
 * Auth: Google Calendar API key or OAuth token (GOOGLE_CALENDAR_TOKEN).
 * Uses the Google Calendar REST API v3.
 */

import { Connector, ConnectorAction } from './base';

const TIMEOUT = 15_000;
const MAX_RESPONSE = 10_000;
const CAL_API = 'https://www.googleapis.com/calendar/v3';

function truncate(text: string): string {
  return text.length <= MAX_RESPONSE ? text : text.substring(0, MAX_RESPONSE) + '\n... (truncated)';
}

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
    const data = await res.json() as Record<string, unknown>;
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

export class GoogleCalendarConnector implements Connector {
  name = 'google_calendar';
  displayName = 'Google Calendar';
  description = 'List, create, update, and delete events on Google Calendar.';
  authType: Connector['authType'] = 'api_key';
  envKey = 'GOOGLE_CALENDAR_TOKEN';

  actions: ConnectorAction[] = [
    {
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
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'create_event',
      description: 'Create a new calendar event',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event title/summary' },
          start: { type: 'string', description: 'Start time (ISO 8601 format, e.g., "2025-03-15T10:00:00-07:00")' },
          end: { type: 'string', description: 'End time (ISO 8601 format). If omitted, defaults to 1 hour after start' },
          location: { type: 'string', description: 'Event location' },
          description: { type: 'string', description: 'Event description/notes' },
          attendees: { type: 'string', description: 'Comma-separated email addresses of attendees' },
          calendar: { type: 'string', description: 'Calendar ID (default "primary")' },
        },
        required: ['title', 'start'],
      },
      execute: async (args, cred) => {
        const title = args.title as string;
        const start = args.start as string;
        if (!title || !start) return 'Error: title and start are required';

        const calendar = (args.calendar as string) || 'primary';

        // Calculate end time (default 1 hour after start)
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

        try {
          const { status, data } = await calFetch(
            `/calendars/${encodeURIComponent(calendar)}/events`,
            cred,
            'POST',
            event,
          );

          if (status === 200 || status === 201) {
            const link = (data.htmlLink as string) || '';
            return `Event created: "${title}" on ${start}${link ? `\nLink: ${link}` : ''}`;
          }
          return `Error: Calendar API ${status}: ${JSON.stringify(data).substring(0, 200)}`;
        } catch (err: unknown) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
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

        if (Object.keys(updates).length === 0) return 'Error: No fields to update. Provide at least one of: title, start, end, location, description.';

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
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'delete_event',
      description: 'Delete a calendar event',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string', description: 'Event ID to delete' },
          calendar: { type: 'string', description: 'Calendar ID (default "primary")' },
        },
        required: ['event_id'],
      },
      execute: async (args, cred) => {
        const eventId = args.event_id as string;
        if (!eventId) return 'Error: event_id is required';
        const calendar = (args.calendar as string) || 'primary';

        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), TIMEOUT);
          const res = await fetch(
            `${CAL_API}/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}`,
            {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${cred}` },
              signal: controller.signal,
            },
          );
          clearTimeout(timer);

          if (res.status === 204 || res.status === 200) {
            return `Event deleted: ${eventId}`;
          }
          return `Error: Calendar API ${res.status}`;
        } catch (err: unknown) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
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

          // Find free slots during work hours
          const freeSlots: string[] = [];
          for (let d = 0; d < days; d++) {
            const day = new Date(now);
            day.setDate(day.getDate() + d);
            // Skip weekends
            if (day.getDay() === 0 || day.getDay() === 6) continue;

            const dayStart = new Date(day);
            dayStart.setHours(workStart, 0, 0, 0);
            const dayEnd = new Date(day);
            dayEnd.setHours(workEnd, 0, 0, 0);

            // Get events on this day
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

            // Find gaps
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
            // Check remaining time after last event
            const remaining = (dayEnd.getTime() - cursor) / (60 * 1000);
            if (remaining >= minDuration) {
              freeSlots.push(`  ${new Date(cursor).toLocaleString()} → ${dayEnd.toLocaleString()} (${Math.round(remaining)} min)`);
            }
          }

          if (!freeSlots.length) return `No free slots of ${minDuration}+ minutes found in the next ${days} days.`;
          return truncate(`Free time slots (${minDuration}+ min, ${workStart}:00-${workEnd}:00):\n\n${freeSlots.join('\n')}`);
        } catch (err: unknown) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
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
