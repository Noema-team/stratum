import { randomBytes, createHash } from 'crypto';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { ApiToken, AuthContext } from './types.js';
import { TOKEN_PREFIX } from './types.js';

// ============================================================================
// TokenRepository — thin SQLite accessor
// ============================================================================

class TokenRepository {
  private readonly insert: Database.Statement;
  private readonly byHash: Database.Statement;
  private readonly byId: Database.Statement;
  private readonly touchLastUsed: Database.Statement;
  private readonly revokeStmt: Database.Statement;
  private readonly list: Database.Statement;

  constructor(db: Database.Database) {
    this.insert = db.prepare(
      'INSERT INTO api_tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)',
    );
    this.byHash = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?');
    this.byId = db.prepare('SELECT * FROM api_tokens WHERE id = ?');
    this.touchLastUsed = db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?');
    this.revokeStmt = db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?');
    this.list = db.prepare('SELECT * FROM api_tokens ORDER BY created_at');
  }

  save(t: ApiToken): void {
    this.insert.run(t.id, t.name, t.tokenHash, t.createdAt);
  }

  findByHash(hash: string): ApiToken | undefined {
    const r = this.byHash.get(hash) as Record<string, unknown> | undefined;
    return r ? rowToToken(r) : undefined;
  }

  findById(id: string): ApiToken | undefined {
    const r = this.byId.get(id) as Record<string, unknown> | undefined;
    return r ? rowToToken(r) : undefined;
  }

  markUsed(id: string, at: string): void {
    this.touchLastUsed.run(at, id);
  }

  revoke(id: string, at: string): void {
    this.revokeStmt.run(at, id);
  }

  listAll(): ApiToken[] {
    return (this.list.all() as Record<string, unknown>[]).map(rowToToken);
  }
}

function rowToToken(r: Record<string, unknown>): ApiToken {
  return {
    id: r.id as string,
    name: r.name as string,
    tokenHash: r.token_hash as string,
    createdAt: r.created_at as string,
    expiresAt: r.expires_at as string | undefined ?? undefined,
    lastUsedAt: r.last_used_at as string | undefined ?? undefined,
    revokedAt: r.revoked_at as string | undefined ?? undefined,
  };
}

// ============================================================================
// TokenStore — public service
// ============================================================================

export class TokenStore {
  private readonly repo: TokenRepository;

  constructor(db: Database.Database) {
    this.repo = new TokenRepository(db);
  }

  // Creates a new token and returns the raw (unhashed) token string.
  // The caller must surface this once — it cannot be recovered later.
  create(name: string): { token: string; record: ApiToken } {
    const raw = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const hash = hashToken(raw);
    const record: ApiToken = {
      id: randomUUID(),
      name,
      tokenHash: hash,
      createdAt: new Date().toISOString(),
    };
    this.repo.save(record);
    return { token: raw, record };
  }

  // Validates a raw token. Returns AuthContext if valid, null otherwise.
  validate(raw: string): AuthContext | null {
    if (!raw.startsWith(TOKEN_PREFIX)) return null;
    const hash = hashToken(raw);
    const record = this.repo.findByHash(hash);
    if (!record) return null;
    if (record.revokedAt) return null;
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) return null;
    this.repo.markUsed(record.id, new Date().toISOString());
    return { tokenId: record.id, tokenName: record.name };
  }

  revoke(id: string): boolean {
    const record = this.repo.findById(id);
    if (!record) return false;
    this.repo.revoke(id, new Date().toISOString());
    return true;
  }

  list(): ApiToken[] {
    return this.repo.listAll();
  }
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
