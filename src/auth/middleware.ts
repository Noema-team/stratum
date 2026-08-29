import type { ParsedRequest } from '../api/types.js';
import type { AuthContext } from './types.js';
import type { TokenStore } from './token-store.js';

export type AuthResult = { ok: true; ctx: AuthContext } | { ok: false; code: string; message: string };

export function makeAuthMiddleware(tokenStore: TokenStore): (req: ParsedRequest, rawHeader?: string) => AuthResult {
  return (req, rawHeader) => {
    void req;
    const header = rawHeader ?? '';
    if (!header.startsWith('Bearer ')) {
      return { ok: false, code: 'unauthorized', message: 'Authorization: Bearer <token> required' };
    }
    const raw = header.slice(7).trim();
    const ctx = tokenStore.validate(raw);
    if (!ctx) {
      return { ok: false, code: 'unauthorized', message: 'Invalid or revoked token' };
    }
    return { ok: true, ctx };
  };
}
