export interface PendingAgentPrompt {
  sessionId: string;
  key: string;
  text: string;
}

export interface StringStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storageKey(sessionId: string): string {
  return `stratum.agent-session.${sessionId}.pending-prompt`;
}

export function readPendingAgentPrompt(storage: StringStorage, sessionId: string): PendingAgentPrompt | null {
  const value = storage.getItem(storageKey(sessionId));
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PendingAgentPrompt>;
    return parsed.sessionId === sessionId && typeof parsed.key === 'string' && typeof parsed.text === 'string'
      ? { sessionId, key: parsed.key, text: parsed.text }
      : null;
  } catch { return null; }
}

export function savePendingAgentPrompt(storage: StringStorage, prompt: PendingAgentPrompt): void {
  storage.setItem(storageKey(prompt.sessionId), JSON.stringify(prompt));
}

export function clearPendingAgentPrompt(storage: StringStorage, sessionId: string): void {
  storage.removeItem(storageKey(sessionId));
}
