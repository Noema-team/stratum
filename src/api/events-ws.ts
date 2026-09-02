// WebSocket /events compatibility transport for ControlPlaneServer.
//
// Responsibilities:
//   - Accept WS upgrade on /events only; destroy sockets on any other path.
//   - Emit system.ready on connect.
//   - Translate approval.respond commands to canonical Decision resolution
//     via ResumePort (backed by ResumeService in production).
//   - Broadcast domain events (chat.message, system.state_changed, etc.)
//     to all connected clients when called by HTTP handlers.
//
// Does not own lifecycle state; is not an execution authority.

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type Database from 'better-sqlite3';
import { findPendingCheckpointsByStep } from './compat-state.js';

export interface WsEvent {
  type: string;
  payload: Record<string, unknown>;
}

// Minimal interface so tests can pass a mock without constructing ResumeService.
export interface ResumePort {
  resume(decisionId: string, resolution: {
    selectedOptionId: string;
    rationale?: string;
    resolvedAt: string;
    resolvedBy?: string;
  }): Promise<void>;
}

const GATE_TO_STEP: Record<string, string> = {
  CONFIRM: 'confirm',
  SHARDING_APPROVAL: 'sharding_approval',
};

const OPTION_MAP: Record<string, Record<string, string>> = {
  CONFIRM: { approve: 'approve', revise: 'revise' },
  SHARDING_APPROVAL: { approve: 'approve', reject: 'reject' },
};

export class EventsWebSocketAdapter {
  private readonly wss: WebSocketServer;

  constructor(
    server: Server,
    private readonly db: Database.Database,
    private readonly workspaceId: string,
    private readonly resumeService: ResumePort | undefined,
  ) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0];
      if (path === '/events') {
        this.wss.handleUpgrade(req, socket as never, head, ws => {
          this.wss.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', ws => {
      this.send(ws, { type: 'system.ready', payload: { name: 'stratum' } });
      ws.on('message', raw => void this.handleMessage(ws, raw));
    });
  }

  broadcast(event: WsEvent): void {
    const msg = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }

  private send(ws: WebSocket, event: WsEvent): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }

  private async handleMessage(ws: WebSocket, raw: unknown): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      this.send(ws, { type: 'error', payload: { code: 'parse_error', message: 'Invalid JSON' } });
      return;
    }

    const m = msg as Record<string, unknown>;
    if (m.type === 'approval.respond') {
      await this.handleApproval(ws, m);
    }
    // Unknown message types are silently ignored.
  }

  private async handleApproval(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const gate = msg.gate as string | undefined;
    const decision = msg.decision as string | undefined;
    const message = msg.message as string | undefined;

    if (!gate || !decision) {
      this.send(ws, { type: 'approval.result', payload: { ok: false, error: 'bad_request', message: 'gate and decision are required' } });
      return;
    }

    const stepId = GATE_TO_STEP[gate];
    if (!stepId) {
      this.send(ws, { type: 'approval.result', payload: { ok: false, error: 'bad_request', message: `Unknown gate: ${gate}` } });
      return;
    }

    const optionId = OPTION_MAP[gate]?.[decision];
    if (!optionId) {
      this.send(ws, { type: 'approval.result', payload: { ok: false, error: 'bad_request', message: `Unknown decision '${decision}' for gate '${gate}'` } });
      return;
    }

    const candidates = findPendingCheckpointsByStep(this.db, this.workspaceId, stepId);

    if (candidates.length === 0) {
      this.send(ws, { type: 'approval.result', payload: { ok: false, error: 'not_found', message: 'No pending checkpoint Decision found for this gate' } });
      return;
    }

    if (candidates.length > 1) {
      this.send(ws, {
        type: 'approval.result',
        payload: {
          ok: false,
          error: 'ambiguous_decision',
          message: `${candidates.length} pending Decisions match gate '${gate}'; cannot choose one`,
          candidates,
        },
      });
      return;
    }

    if (!this.resumeService) {
      this.send(ws, { type: 'approval.result', payload: { ok: false, error: 'service_unavailable', message: 'ResumeService not configured' } });
      return;
    }

    const decisionId = candidates[0];
    try {
      await this.resumeService.resume(decisionId, {
        selectedOptionId: optionId,
        rationale: message,
        resolvedAt: new Date().toISOString(),
      });
      this.send(ws, { type: 'approval.result', payload: { ok: true, decisionId } });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.send(ws, { type: 'approval.result', payload: { ok: false, error: 'resume_error', message: errMsg } });
    }
  }

  close(): Promise<void> {
    // Terminate all open connections before closing the server; without this,
    // wss.close() waits for each client's close handshake to complete and hangs
    // if any client is mid-close or the test process exits before the exchange
    // finishes.
    for (const client of this.wss.clients) {
      client.terminate();
    }
    return new Promise((resolve, reject) =>
      this.wss.close(err => (err ? reject(err) : resolve())),
    );
  }
}
