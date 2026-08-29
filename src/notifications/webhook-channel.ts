import { createHmac } from 'crypto';
import type { NotificationChannel, NotificationPayload, WebhookConfig } from './types.js';

export class WebhookChannel implements NotificationChannel {
  readonly type = 'webhook';

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly config: WebhookConfig,
  ) {}

  async send(payload: NotificationPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.headers,
    };

    if (this.config.secret) {
      const sig = createHmac('sha256', this.config.secret).update(body).digest('hex');
      headers['X-Stratum-Signature'] = `sha256=${sig}`;
    }

    const res = await fetch(this.config.url, { method: 'POST', headers, body });
    if (!res.ok) {
      throw new Error(`Webhook delivery failed: ${res.status} ${res.statusText}`);
    }
  }
}
