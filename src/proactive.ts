/**
 * Proactive Engine — CodeBot initiates notifications and suggestions.
 *
 * Manages a queue of notifications that can come from:
 * - Routine completion alerts
 * - Due reminders
 * - System health checks
 * - SPARK milestones
 * - Connector health
 *
 * Notifications are stored in memory and served via SSE/REST to the dashboard.
 */

import * as fs from 'fs';
import * as path from 'path';
import { codebotPath } from './paths';


const MAX_NOTIFICATIONS = 100;

export type NotificationType = 'routine' | 'reminder' | 'system' | 'milestone' | 'alert' | 'suggestion';
export type NotificationPriority = 'low' | 'normal' | 'high';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  priority: NotificationPriority;
  createdAt: string;
  read: boolean;
  dismissed: boolean;
  /** Optional action the user can take */
  action?: { label: string; command: string };
}

/**
 * Proactive notification engine.
 */
export class ProactiveEngine {
  private notifications: Notification[] = [];
  private listeners: Array<(notification: Notification) => void> = [];

  constructor() {
    this.notifications = this.load();
  }

  /** Load notifications from disk */
  private load(): Notification[] {
    try {
      if (fs.existsSync(codebotPath('notifications.json'))) {
        const raw = fs.readFileSync(codebotPath('notifications.json'), 'utf-8');
        const data = JSON.parse(raw) as Notification[];
        // Filter out dismissed and keep only recent
        return data.filter(n => !n.dismissed).slice(-MAX_NOTIFICATIONS);
      }
    } catch { /* corrupted or missing */ }
    return [];
  }

  /** Save notifications to disk */
  private save(): void {
    const dir = path.dirname(codebotPath('notifications.json'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(codebotPath('notifications.json'), JSON.stringify(this.notifications, null, 2));
  }

  /** Generate a unique ID */
  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }

  /** Add a new notification */
  push(type: NotificationType, title: string, message: string, opts?: {
    priority?: NotificationPriority;
    action?: { label: string; command: string };
  }): Notification {
    const notification: Notification = {
      id: this.generateId(),
      type,
      title,
      message,
      priority: opts?.priority || 'normal',
      createdAt: new Date().toISOString(),
      read: false,
      dismissed: false,
      action: opts?.action,
    };

    this.notifications.push(notification);

    // Keep only the most recent
    if (this.notifications.length > MAX_NOTIFICATIONS) {
      this.notifications = this.notifications.slice(-MAX_NOTIFICATIONS);
    }

    this.save();

    // Notify listeners
    for (const listener of this.listeners) {
      try { listener(notification); } catch { /* ignore listener errors */ }
    }

    return notification;
  }

  /** Get all active (non-dismissed) notifications */
  getAll(): Notification[] {
    return this.notifications.filter(n => !n.dismissed);
  }

  /** Get unread count */
  getUnreadCount(): number {
    return this.notifications.filter(n => !n.dismissed && !n.read).length;
  }

  /** Mark a notification as read */
  markRead(id: string): boolean {
    const n = this.notifications.find(n => n.id === id);
    if (n) {
      n.read = true;
      this.save();
      return true;
    }
    return false;
  }

  /** Dismiss a notification */
  dismiss(id: string): boolean {
    const n = this.notifications.find(n => n.id === id);
    if (n) {
      n.dismissed = true;
      this.save();
      return true;
    }
    return false;
  }

  /** Dismiss all notifications */
  dismissAll(): number {
    let count = 0;
    for (const n of this.notifications) {
      if (!n.dismissed) {
        n.dismissed = true;
        count++;
      }
    }
    this.save();
    return count;
  }

  /** Subscribe to new notifications */
  onNotification(callback: (notification: Notification) => void): void {
    this.listeners.push(callback);
  }

  /** Remove a listener */
  removeListener(callback: (notification: Notification) => void): void {
    this.listeners = this.listeners.filter(l => l !== callback);
  }

  // ── Proactive Check Methods ──

  /** Notify about routine completion */
  notifyRoutineComplete(routineName: string, success: boolean, summary?: string): void {
    this.push(
      'routine',
      success ? `Routine completed: ${routineName}` : `Routine failed: ${routineName}`,
      summary || (success ? 'Completed successfully.' : 'Failed — check logs for details.'),
      {
        priority: success ? 'low' : 'high',
        action: success ? undefined : { label: 'View Details', command: 'View routine log' },
      }
    );
  }

  /** Notify about system health */
  notifySystemHealth(issue: string, details: string): void {
    this.push('system', `System Alert: ${issue}`, details, {
      priority: 'high',
      action: { label: 'Run Health Check', command: 'Check my system health' },
    });
  }

  /** Push a suggestion */
  suggest(title: string, message: string, command?: string): void {
    this.push('suggestion', title, message, {
      priority: 'low',
      action: command ? { label: 'Try it', command } : undefined,
    });
  }
}

/** Singleton instance */
let _engine: ProactiveEngine | null = null;

export function getProactiveEngine(): ProactiveEngine {
  if (!_engine) _engine = new ProactiveEngine();
  return _engine;
}
