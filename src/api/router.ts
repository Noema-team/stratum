import type { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import type { ParsedRequest, ApiResponse } from './types.js';
import { err, statusForError } from './types.js';

export type RouteHandler = (req: ParsedRequest) => ApiResponse | Promise<ApiResponse>;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): this {
    this.routes.push({ method: method.toUpperCase(), segments: path.split('/').filter(Boolean), handler });
    return this;
  }

  private match(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
    const incoming = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.segments.length !== incoming.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = decodeURIComponent(incoming[i]);
        } else if (seg !== incoming[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? '/';
    const url = new URL(raw, 'http://localhost');
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });

    let body: unknown = null;
    const ct = req.headers['content-type'] ?? '';
    if (ct.includes('application/json')) {
      body = await readBody(req);
    }

    const found = this.match(req.method ?? 'GET', url.pathname);
    if (!found) {
      sendJson(res, 404, err('not_found', `No route for ${req.method} ${url.pathname}`));
      return;
    }

    const parsed: ParsedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      params: found.params,
      query,
      body,
    };

    try {
      const result = await found.handler(parsed);
      const status = result.ok ? 200 : statusForError(result.error.code.toLowerCase());
      sendJson(res, status, result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendJson(res, 500, err('internal_error', msg));
    }
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
