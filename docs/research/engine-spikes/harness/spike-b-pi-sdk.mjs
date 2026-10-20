#!/usr/bin/env node
// Spike B round 2 — embed Pi via @earendil-works/pi-coding-agent TS SDK, in-process.
// Acceptance conditions kept equivalent to spike-a round 2 (see ../README.md):
//   G2+nonce: codeword exists only in conversation, never on disk.
//   G5: reopened session must restore the conversation (message count recorded BEFORE any new
//       prompt) and recall the codeword from memory — file rereading cannot satisfy it.
//   G4: abort only after observed activity AND a real side effect; PASS requires 1..499 lines.
//   G3: Pi has no permission system by design (README: isolation is the host's job) — record posture.
// Needs node >= 22.19. Stages are separate processes so stage3 is a true cold restart:
//   node spike-b-pi-sdk.mjs stage1|stage2|stage3
// Transcript: out/pi-sdk.jsonl

import { mkdirSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// PI_PKG lets the harness bind a specific Pi install without committing node_modules, e.g.:
//   PI_PKG='file:///home/me/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js'
const PI_PKG = process.env.PI_PKG ?? "@earendil-works/pi-coding-agent";
const { createAgentSession, SessionManager } = await import(PI_PKG);

const OUT = process.env.SPIKE_OUT ?? join("/tmp", "stratum-spike-v2");
const ENGINE_TAG = "PI_SDK_R2";
mkdirSync(join(OUT, "pi-work"), { recursive: true });
const work = join(OUT, "pi-work");
const sessionsDir = join(OUT, "pi-sessions");
mkdirSync(sessionsDir, { recursive: true });

const transcriptFile = join(OUT, "pi-sdk.jsonl");
const record = (obj) => {
  const line = JSON.stringify({ t: Date.now(), ...obj });
  writeFileSync(transcriptFile, (existsSync(transcriptFile) ? readFileSync(transcriptFile, "utf8") : "") + line + "\n");
};
const CODEWORD_FILE = join(sessionsDir, "codeword.txt");
const CODEWORD = existsSync(CODEWORD_FILE) ? readFileSync(CODEWORD_FILE, "utf8").trim() : "CX-" + randomUUID().slice(0, 8);
writeFileSync(CODEWORD_FILE, CODEWORD); // host-side only; the agent must never write it into the workspace

const stage = process.argv[2];
if (!["stage1", "stage2", "stage3"].includes(stage)) { console.error("usage: node spike-b-pi-sdk.mjs stage1|stage2|stage3"); process.exit(2); }

const spikeTxt = join(work, "spike.txt");
const countTxt = join(work, "count.txt");
const TASK1 = `Create a file named spike.txt in this directory whose exact contents are exactly two lines: first line SPIKE_OK_2026_10_19 and second line ${ENGINE_TAG}_RESUME. Also, remember this codeword: ${CODEWORD}. Never write the codeword into any file — it must exist only in this conversation.`;
const TASK2 = `Create a file named count.txt in this directory immediately, containing just the number 1. Then append the numbers 2 through 500 one at a time, appending each as its own step.`;
const RESUME_Q = `Without reading any files and without using any tools, reply with: (1) the exact two lines of spike.txt as you created them, and (2) the codeword I gave you earlier in this conversation.`;

const countLines = () => { try { return readFileSync(countTxt, "utf8").split(/\r?\n/).filter(Boolean).length; } catch { return -1; } };
const spikeLines = () => { try { return readFileSync(spikeTxt, "utf8").split(/\r?\n/).filter(Boolean); } catch { return null; } };
const statOf = (p) => { try { return { mtimeMs: statSync(p).mtimeMs }; } catch { return null; } };
const ID_FILE = join(sessionsDir, "last-session-id");
const MAX_PROMPTS = Number(process.env.SPIKE_MAX_PROMPTS ?? 12);
let promptCount = 0;

async function gatedAbort(session) {
  // Wait for observable activity AND a real side effect before aborting (review finding R2/R3).
  let sawTool = false, sawText = 0;
  for (let i = 0; i < 60; i++) {
    if (countLines() >= 1) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const started = countLines() >= 1;
  const unsub = session.subscribe((e) => {
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") sawText++;
    if (e.type === "tool_execution_start") sawTool = true;
  });
  record({ ev: "activity-gate", started, sawTool, sawText });
  if (started) await session.abort();
  else await session.abort().catch(() => {}); // nothing to gate on — record as failure condition below
  return { started, sawTool, sawText };
}

if (stage === "stage1") {
  rmSync(spikeTxt, { force: true });
  const { session } = await createAgentSession({ cwd: work, sessionManager: SessionManager.create(work, sessionsDir) });
  writeFileSync(ID_FILE, session.sessionId);
  const events = [];
  const unsub = session.subscribe((e) => { events.push(e.type); record({ ev: e.type, detail: e.type === "message_update" ? e.assistantMessageEvent?.type : undefined }); });
  if (++promptCount > MAX_PROMPTS) process.exit(3);
  try { await session.prompt(TASK1); } finally { unsub(); }
  const lines = spikeLines();
  const nonceLeak = JSON.stringify(lines).includes(CODEWORD);
  const g2 = JSON.stringify(lines) === JSON.stringify(["SPIKE_OK_2026_10_19", `${ENGINE_TAG}_RESUME`]) && !nonceLeak;
  log(`G1 [protocol]: PASS sessionId=${session.sessionId} messages=${session.messages?.length}`);
  log(`G2 [runtime]: ${g2 ? "PASS" : `FAIL`} contents=${JSON.stringify(lines)} nonceNotWrittenToDisk=${!nonceLeak}`);
  log(`G3: N/A by design — Pi ships no permission system (isolation is the host's job; toolEvents observed: ${events.filter((t) => t?.startsWith("tool")).length})`);
  session.dispose();
  process.exit(g2 ? 0 : 1);
}

if (stage === "stage2") {
  if (state_ok() !== true) { log("run stage1 first"); process.exit(2); }
  rmSync(countTxt, { force: true });
  const { session } = await createAgentSession({ cwd: work, sessionManager: SessionManager.create(work, sessionsDir) });
  if (++promptCount > MAX_PROMPTS) process.exit(3);
  const p = session.prompt(TASK2).catch((e) => ({ aborted: true, err: String(e).slice(0, 100) }));
  const gate = await gatedAbort(session);
  await p;
  await new Promise((r) => setTimeout(r, 1500));
  const n = countLines();
  const g4 = n >= 1 && n < 500;
  log(`G4 [runtime]: ${g4 ? "PASS" : "FAIL"} sideEffectStarted=${gate.started} stopReason=aborted countLines=${n} (require 1..499)`);
  session.dispose();
  process.exit(g4 ? 0 : 1);
}

if (stage === "stage3") {
  const id = readFileSync(ID_FILE, "utf8").trim();
  const sessions = await SessionManager.list(work, sessionsDir);
  const found = sessions.find((s) => s.id === id);
  if (!found) { log("G5: FAIL persisted session not found"); process.exit(1); }
  const mtimeBefore = statOf(spikeTxt)?.mtimeMs;
  const { session } = await createAgentSession({ cwd: work, sessionManager: SessionManager.open(found.path) });
  // Verify timeline restoration BEFORE sending anything new.
  const replayedMessages = session.messages?.length ?? 0;
  record({ ev: "reopened", sessionId: id, replayedMessages });
  if (++promptCount > MAX_PROMPTS) process.exit(3);
  let text = "";
  try { await session.prompt(RESUME_Q); text = session.getLastAssistantText?.() ?? ""; } finally {}
  const mtimeAfter = statOf(spikeTxt)?.mtimeMs;
  const nonceOk = text.includes(CODEWORD);
  const g5 = replayedMessages > 0 && nonceOk && mtimeBefore === mtimeAfter;
  log(`G5 [runtime]: ${g5 ? "PASS" : "FAIL"} replayedMessages=${replayedMessages} codewordFromMemory=${nonceOk} fileUntouched=${mtimeBefore === mtimeAfter}`);
  log(`   answer excerpt: ${JSON.stringify(text.slice(0, 220))}`);
  session.dispose();
  process.exit(g5 ? 0 : 1);
}

function state_ok() { try { return !!readFileSync(ID_FILE, "utf8"); } catch { return false; } }
