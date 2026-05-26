import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
import type { RuntimeMapManager } from './runtime-map.js';

export interface SLEEvent {
  type: string;
  cycle: number;
  iteration: number;
  timestamp: string;
  payload: any;
  session_id?: string;
}

export class EventBus {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  private onApprovalRespondCallback?: (data: {
    type: 'approval.respond';
    gate: string;
    decision: 'approve' | 'reject' | 'revise' | 'modify';
    message?: string;
  }) => Promise<void>;

  private onCategoriesConfirmCallback?: (data: {
    type: 'categories.confirm';
    categories: string[];
  }) => Promise<void>;

  constructor(
    private server: Server,
    private mapManager: RuntimeMapManager
  ) {
    this.wss = new WebSocketServer({ noServer: true });

    // Handle WebSocket upgrade on the HTTP server for `/events` route
    this.server.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
      const host = req.headers.host || 'localhost';
      const url = new URL(req.url || '', `http://${host}`);
      if (url.pathname === '/events') {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', async (ws: WebSocket) => {
      this.clients.add(ws);

      // On connection, immediately broadcast `system.ready` state snapshot
      try {
        const map = await this.mapManager.read();
        const cycle = map.cycle?.number ?? 0;
        const iteration = map.cycle?.iteration ?? 0;

        const readyEvent: SLEEvent = {
          type: 'system.ready',
          cycle,
          iteration,
          timestamp: new Date().toISOString(),
          payload: {
            version: '0.1.0',
            pid: process.pid,
            uptime_ms: Math.round(process.uptime() * 1000),
          },
        };
        ws.send(JSON.stringify(readyEvent));
      } catch (err) {
        console.error('[EventBus] Failed to send system.ready on connection:', err);
      }

      ws.on('message', async (message: string) => {
        try {
          const data = JSON.parse(message);

          if (data.type === 'approval.respond') {
            if (this.onApprovalRespondCallback) {
              await this.onApprovalRespondCallback(data);
            }
          } else if (data.type === 'categories.confirm') {
            if (this.onCategoriesConfirmCallback) {
              await this.onCategoriesConfirmCallback(data);
            }
          } else {
            // Unknown client command
            ws.send(JSON.stringify({
              type: 'error',
              cycle: 0,
              iteration: 0,
              timestamp: new Date().toISOString(),
              payload: {
                message: `Unknown command type: ${data.type}`,
                recoverable: true,
              },
            }));
          }
        } catch (err) {
          // Send error back to client
          ws.send(JSON.stringify({
            type: 'error',
            cycle: 0,
            iteration: 0,
            timestamp: new Date().toISOString(),
            payload: {
              message: err instanceof Error ? err.message : 'Invalid WebSocket message format',
              recoverable: true,
            },
          }));
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });
  }

  registerCallbacks(callbacks: {
    onApprovalRespond?: (data: any) => Promise<void>;
    onCategoriesConfirm?: (data: any) => Promise<void>;
  }) {
    if (callbacks.onApprovalRespond) this.onApprovalRespondCallback = callbacks.onApprovalRespond;
    if (callbacks.onCategoriesConfirm) this.onCategoriesConfirmCallback = callbacks.onCategoriesConfirm;
  }

  async emit(type: string, payload: any, sessionId?: string): Promise<void> {
    let cycle = 0;
    let iteration = 0;
    try {
      const map = await this.mapManager.read();
      cycle = map.cycle?.number ?? 0;
      iteration = map.cycle?.iteration ?? 0;
    } catch {}

    const event: SLEEvent = {
      type,
      cycle,
      iteration,
      timestamp: new Date().toISOString(),
      payload,
    };

    if (sessionId) {
      event.session_id = sessionId;
    }

    const message = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  close() {
    this.wss.close();
    for (const client of this.clients) {
      client.terminate();
    }
    this.clients.clear();
  }
}
