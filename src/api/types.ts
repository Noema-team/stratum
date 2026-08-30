// ============================================================================
// Shared API types — request parsing and response envelopes
// ============================================================================

import type { AuthContext } from '../auth/types.js';
export type { AuthContext };

export interface ParsedRequest {
  method: string;
  path: string;
  params: Record<string, string>;   // matched from URL pattern (:param)
  query: Record<string, string>;    // from ?key=value
  body: unknown;                    // parsed JSON body, or null
  auth?: AuthContext;               // set when token is valid
  rawIp?: string;                   // remote address, best-effort
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: { code: string; message: string };
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

export function ok<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

export function err(code: string, message: string): ApiError {
  return { ok: false, error: { code, message } };
}

export const HTTP_STATUS: Record<string, number> = {
  ok: 200,
  created: 201,
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  service_unavailable: 503,
  internal_error: 500,
};

export function statusForError(code: string): number {
  return HTTP_STATUS[code] ?? 500;
}
