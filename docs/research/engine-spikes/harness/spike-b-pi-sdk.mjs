#!/usr/bin/env node
// Spike B — embed Pi via @earendil-works/pi-coding-agent TS SDK, in-process.
// Needs node >= 22.19 (e.g. ~/.nvm/versions/node/v22.23.2/bin/node).
// Run stages separately so stage3 is a true cold restart:
//   node spike-b-pi-sdk.mjs stage1   # task + verify
//   node spike-b-pi-sdk.mjs stage2   # mid-turn abort
//   node spike-b-pi-sdk.mjs stage3   # reopen persisted session, resume question
// Transcript: out/pi-sdk.jsonl

import { mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const OUT_DIR = join(import.meta.dirname, "out");
const ENGINE_TAG = "PI_SDK";
mkdirSync(join(OUT_DIR, "pi-work"), { recursive: true });
const work = join(OUT_DIR, "pi-work");
const sessionsDir = join(OUT_DIR, "pi-sessions");
mkdirSync(sessionsDir, { recursive: true });

const transcript = [];
const log = (...a) => console.log(...a);
const record = (obj) => {
  transcript.push({ t: Date.now(), ...obj });
  writeFileSync(join(OUT_DIR, "pi-sdk.jsonl"), transcript.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

const stage = process.argv[2] ?? "stage1";
const spikeTxt = join(work, "spike.txt");
const countTxt = join(work, "count.txt");
const TASK1 = `Create a file named spike.txt in this directory. Its exact contents must be exactly two lines: first line SPIKE_OK_2026_10_19 and second line ${ENGINE_TAG}_RESUME. Do nothing else.`;
const TASK2 = `Write the numbers from 1 to 500 into a file named count.txt in this directory, one number per line.`;
const RESUME_Q = `Without modifying any files, reply with the exact two lines of spike.txt.`;
const ID_FILE = join(sessionsDir, "last-session-id");

function readSpikeLines() {
  try { return readFileSync(spikeTxt, "utf8").split(/\r?\n/).filter(Boolean); } catch { return null; }
}
function countLines() {
  try { return readFileSync(countTxt, "utf8").split(/\r?\n/).filter(Boolean).length; } catch { return -1; }
}

async function runStage1() {
  rmSync(spikeTxt, { force: true });
  const { session } = await createAgentSession({ cwd: work, sessionManager: SessionManager.create(work, sessionsDir) });
  writeFileSync(ID_FILE, session.sessionId);
  record({ ev: "created", sessionId: session.sessionId, file: session.sessionFile });
  const events = [];
  const unsub = session.subscribe((e) => { events.push(e); record({ ev: e.type, detail: e.type === "message_update" ? e.assistantMessageEvent?.type : undefined }); });
  let permissionEvents = 0;
  try {
    await session.prompt(TASK1);
  } finally { unsub(); }
  const lines = readSpikeLines();
  const g2 = JSON.stringify(lines) === JSON.stringify(["SPIKE_OK_2026_10_19", `${ENGINE_TAG}_RESUME`]) ? "PASS exact file contents" : `FAIL contents=${JSON.stringify(lines)}`;
  // Permission interception: record whether any tool-execution events required host mediation.
  const toolEvents = events.filter((e) => e.type?.startsWith("tool")).length;
  log("G1 handshake: PASS sessionId=" + session.sessionId);
  log("G2 task:", g2);
  log(`G3 permission: events=${toolEvents} (record mechanism — Pi defers isolation to host by design; see out/pi-sdk.jsonl)`);
  session.dispose();
  log("\nstage1 done. session id:", session.sessionId);
}

async function runStage2() {
  rmSync(countTxt, { force: true });
  const { session } = await createAgentSession({ cwd: work, sessionManager: SessionManager.create(work, sessionsDir) });
  let sawActivity = false;
  const unsub = session.subscribe((e) => {
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") sawActivity = true;
    record({ ev: e.type });
  });
  const p = session.prompt(TASK2);
  const timer = setInterval(() => { if (sawActivity) { clearInterval(timer); session.abort(); } }, 250);
  try { await p; } catch (e) { record({ ev: "prompt-error", msg: String(e.message ?? e) }); }
  clearInterval(timer);
  unsub();
  const n = countLines();
  log("G4 cancel:", n >= 0 && n < 500 ? `PASS countLines=${n} (<500)` : `FAIL countLines=${n}`);
  session.dispose();
}

async function runStage3() {
  const id = readFileSync(ID_FILE, "utf8").trim();
  const sessions = await SessionManager.list(work, sessionsDir);
  const found = sessions.find((s) => s.id === id);
  if (!found) { log("G5 resume: FAIL session not found among", sessions.length); process.exit(1); }
  const mtimeBefore = statSync(spikeTxt).mtimeMs;
  const { session } = await createAgentSession({ cwd: work, sessionManager: SessionManager.open(found.path) });
  const replayed = session.messages?.length ?? 0;
  record({ ev: "reopened", sessionId: id, replayedMessages: replayed });
  const events = [];
  const unsub = session.subscribe((e) => { events.push(e); record({ ev: e.type }); });
  let text = "";
  try {
    await session.prompt(RESUME_Q);
    text = session.getLastAssistantText?.() ?? "";
  } finally { unsub(); }
  const mtimeAfter = statSync(spikeTxt).mtimeMs;
  const ok = text.includes("SPIKE_OK_2026_10_19") && text.includes(`${ENGINE_TAG}_RESUME`) && mtimeBefore === mtimeAfter;
  log("G5 resume:", ok
    ? `PASS reopened ${replayed} persisted messages; answer quoted both markers; file untouched`
    : `FAIL answer=${JSON.stringify(text.slice(0, 200))} mtime stable=${mtimeBefore === mtimeAfter}`);
  session.dispose();
}

const gates = { stage1: runStage1, stage2: runStage2, stage3: runStage3 };
await gates[stage]();
