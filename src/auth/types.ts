export interface ApiToken {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

// Attached to requests that passed authentication
export interface AuthContext {
  tokenId: string;
  tokenName: string;
}

export const TOKEN_PREFIX = 'strat_';
