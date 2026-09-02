export type NotificationEventType =
  | 'attention.new'
  | 'decision.requested'
  | 'work.failed'
  | 'work.completed'
  | 'work.blocked';

export interface NotificationPayload {
  type: NotificationEventType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface NotificationChannel {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  send(payload: NotificationPayload): Promise<void>;
}

export interface WebhookConfig {
  url: string;
  secret?: string;
  headers?: Record<string, string>;
}

export interface ChannelRecord {
  id: string;
  name: string;
  type: 'webhook';
  config: WebhookConfig;
  enabled: boolean;
  createdAt: string;
}
