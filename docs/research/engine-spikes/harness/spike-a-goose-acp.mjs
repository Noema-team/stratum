#!/usr/bin/env node
// Spike A round 2 — Goose over ACP with strengthened evidence (see ../README.md, findings §Round 2).
// Round 1 weaknesses addressed:
//   G5: conversation-only nonce (never on disk) + timeline verification BEFORE the follow-up prompt.
//   G4: cancel fires only after observed activity; PASS requires a partially-written file.
//   G6: SIGKILL fires only after observed in-flight side effects; post-reload stability asserted; new PID recorded.
//   G3: engine spawned under a restrictive profile (GOOSE_MODE=approve) to elicit session/request_permission.
//   Budget: MAX_PROMPTS cap enforced in addition to per-request timeouts. Usage events recorded in transcript.
// Usage: node spike-a-goose-acp.mjs basic|restart|cancel|sigkill   (gated: basic -> restart -> cancel -> sigkill)

import { spawn, execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const GOOSE_BIN = process.env.GOOSE_BIN ?? "goose";
const GOOSE_ACP_ARGS = (process.env.GOOSE_ACP_ARGS ?? "acp").split(" ").filter(Boolean);
const TIMEOUT = Number(process.env.SPIKE_TIMEOUT_MS ?? 240_000);
const MAX_PROMPTS = Number(process.env.SPIKE_MAX_PROMPTS ?? 12);
const OUT = process.env.SPIKE_OUT ?? join("/tmp", "stratum-spike-v2");
const ENGINE_TAG = "GOOSE_ACP_R2";
const phase = process.argv[2];
if (!["basic", "restart", "cancel", "sigkill"].includes(phase)) {
  console.error("usage: node spike-a-goose-acp.mjs basic|restart|cancel|sigkill");
  process.exit(2);
}

mkdirSync(join(OUT, "goose-work"), { recursive: true });
const work = join(OUT, "goose-work");
const sessionState = join(OUT, "goose-session.json");
const transcriptFile = join(OUT, "goose-acp.jsonl");
if (!existsSync(join(work, ".git"))) execSync("git init -q", { cwd: work });

const log = (...a) => console.log(...a);
const REDACTIONS = [/(sk-[A-Za-z0-9_-]{8,})/g, /(Bearer\s+\S+)/g];
const redact = (s) => REDACTIONS.reduce((acc, re) => acc.replace(re, "[REDACTED]"), String(s));
const record = (dir, obj) => {
  const line = redact(JSON.stringify({ t: Date.now(), phase, dir, ...obj }));
  writeFileSync(transcriptFile, (existsSync(transcriptFile) ? readFileSync(transcriptFile, "utf8") : "") + line + "\n");
};

// Restrictive profile attempt: GOOSE_MODE=approve should make the engine ask before tool use.
const RESTRICTIVE_ENV = { GOOSE_MODE: "approve" };

const CODEWORD = "CX-" + randomUUID().slice(0, 8);
const spikeTxt = join(work, "spike.txt");
const countTxt = join(work, "count.txt");
const TASK1 = `Create a file named spike.txt in this directory whose exact contents are exactly two lines: first line SPIKE_OK_2026_10_19 and second line ${ENGINE_TAG}_RESUME. Also, remember this codeword: ${CODEWORD}. Never write the codeword into any file — it must exist only in this conversation.`;
const TASK2 = `Create a file named count.txt in this directory immediately, containing just the number 1. Then append the numbers 2 through 500 one at a time, appending each as its own step.`;
const RESUME_Q = `Without reading any files and without using any tools, reply with: (1) the exact two lines of spike.txt as you created them, and (2) the codeword I gave you earlier in this conversation.`;

const countLines = () => { try { return readFileSync(countTxt, "utf8").split(/\r?\n/).filter(Boolean).length; } catch { return -1; } };
const spikeLines = () => { try { return readFileSync(spikeTxt, "utf8").split(/\r?\n/).filter(Boolean); } catch { return null; } };
const statOf = (p) => { try { const s = statSync(p); return { mtimeMs: s.mtimeMs }; } catch { return null; } };

// ---------- minimal ACP client (newline-delimited JSON-RPC over stdio) ----------
let proc = null;
let nextId = 1;
const pending = new Map();
const updates = [];
let requestPermissionCount = 0;
let promptCount = 0;
const updateTypeInventory = new Map();
let activeSignal = { toolCalls: 0, messageChunks: 0 }; // per-prompt activity, reset by prompt()

const send = (obj) => { record("C->A", obj); proc.stdin.write(JSON.stringify(obj) + "\n"); };
const request = (method, params, ms = TIMEOUT) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`TIMEOUT ${method} (${ms}ms)`)); }, ms);
    pending.set(id, { resolve, reject, timer, method });
    send({ jsonrpc: "2.0", id, method, params });
  });
};
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startProcess() {
  proc = spawn(GOOSE_BIN, GOOSE_ACP_ARGS, { cwd: work, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...RESTRICTIVE_ENV } });
  record("note", { spawnedPid: proc.pid, restrictiveEnv: RESTRICTIVE_ENV });
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { record("A->C/unparsed", { line: redact(line).slice(0, 400) }); continue; }
      handle(msg);
    }
  });
  proc.stderr.on("data", (d) => record("A->C/stderr", { text: redact(d.toString()).trim().slice(0, 2000) }));
  proc.on("exit", (code, sig) => record("proc/exit", { code, signal: sig, pid: proc.pid }));
  return new Promise((res, rej) => { proc.on("spawn", res); proc.on("error", rej); });
}
function killProcess(sig = "SIGKILL") {
  return new Promise((res) => {
    if (!proc || proc.exitCode !== null) return res();
    proc.on("exit", res);
    proc.kill(sig);
    setTimeout(res, 5000).unref?.();
  });
}

function handle(msg) {
  record("A->C", msg);
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) { clearTimeout(p.timer); pending.delete(msg.id); msg.error ? p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`)) : p.resolve(msg.result); }
    return;
  }
  if (msg.method === "session/update") {
    const kind = msg.params?.update?.sessionUpdate ?? "unknown";
    updateTypeInventory.set(kind, (updateTypeInventory.get(kind) ?? 0) + 1);
    if (kind === "tool_call" || kind === "tool_call_update") activeSignal.toolCalls++;
    if (kind === "agent_message_chunk") activeSignal.messageChunks++;
    updates.push(msg.params?.update);
    return;
  }
  if (msg.method === "session/request_permission") {
    requestPermissionCount++;
    const opts = msg.params?.options ?? [];
    const pick = opts.find((o) => o.kind === "allow_once") ?? opts[0]; // never auto-select allow_always
    send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: pick?.optionId } } });
    return;
  }
  if (msg.method === "fs/read_text_file" || msg.method === "fs/write_text_file") {
    const p = msg.params || {};
    try {
      const fp = join(work, p.path);
      if (!fp.startsWith(work)) throw new Error("outside workspace");
      if (msg.method === "fs/read_text_file") send({ jsonrpc: "2.0", id: msg.id, result: { content: readFileSync(fp, "utf8") } });
      else { writeFileSync(fp, p.content ?? ""); send({ jsonrpc: "2.0", id: msg.id, result: {} }); }
    } catch (e) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e.message ?? e) } });
    }
    return;
  }
  if (msg.id !== undefined && msg.method) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unimplemented: ${msg.method}` } });
  }
}

async function initialize() {
  const res = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  record("note", { protocolVersion: res?.protocolVersion, agentCapabilities: res?.agentCapabilities, authMethods: res?.authMethods?.map((a) => a.id) });
  if (res?.authMethods?.[0]) await request("authenticate", { methodId: res.authMethods[0].id });
  return res;
}
const newSession = async () => (await request("session/new", { cwd: work, mcpServers: [] })).sessionId;
async function prompt(sessionId, text) {
  if (promptCount >= MAX_PROMPTS) throw new Error(`prompt budget exhausted (${MAX_PROMPTS}) — stopping per cost limits`);
  promptCount++;
  activeSignal = { toolCalls: 0, messageChunks: 0 };
  updates.length = 0;
  const res = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  return { stopReason: res?.stopReason, text: updates.map((u) => u?.content?.text ?? u?.delta?.text ?? "").join(""), activity: { ...activeSignal } };
}
// Wait until the engine shows observable activity (tool call or streamed generation), or time out.
async function awaitActivity(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (activeSignal.toolCalls > 0 || activeSignal.messageChunks >= 3) return true;
    await sleep(250);
  }
  return false;
}

const state = existsSync(sessionState) ? JSON.parse(readFileSync(sessionState, "utf8")) : {};
const fail = (msg) => { log(`\nPHASE ${phase}: FAIL — ${msg}`); if (proc) { try { proc.stdin.end(); } catch {} proc.kill("SIGTERM"); } process.exit(1); };
const finish = (gates) => {
  log(`\n=== PHASE ${phase}: DONE ===`);
  for (const [k, v] of Object.entries(gates)) log(`${k}: ${v}`);
  log("update-type inventory:", Object.fromEntries(updateTypeInventory));
  log("permission requests observed:", requestPermissionCount, "| prompts used:", promptCount, "/", MAX_PROMPTS);
  if (proc) { try { proc.stdin.end(); } catch {} proc.kill("SIGTERM"); }
  process.exit(0);
};

if (phase === "basic") {
  rmSync(spikeTxt, { force: true });
  await startProcess();
  await initialize();
  const sessionId = await newSession();
  writeFileSync(sessionState, JSON.stringify({ ...state, sessionId, codeword: CODEWORD, basicPass: false }));
  const r1 = await prompt(sessionId, TASK1);
  const lines = spikeLines();
  const g2 = JSON.stringify(lines) === JSON.stringify(["SPIKE_OK_2026_10_19", `${ENGINE_TAG}_RESUME`]);
  const nonceLeak = JSON.stringify(lines).includes(CODEWORD);
  log(`G1 [protocol]: PASS sessionId=${sessionId}`);
  log(`G2 [runtime]: ${g2 && !nonceLeak ? "PASS" : `FAIL`} contents=${JSON.stringify(lines)} nonceNotWrittenToDisk=${!nonceLeak} stop=${r1.stopReason}`);
  log(`G3 [runtime]: ${requestPermissionCount > 0 ? `PASS ${requestPermissionCount} session/request_permission round-trip(s) mediated under GOOSE_MODE=approve` : "STILL UNEXERCISED — no permission requests even under GOOSE_MODE=approve (documented finding; record config path used)"}`);
  if (!g2 || nonceLeak) fail("G2");
  writeFileSync(sessionState, JSON.stringify({ ...state, sessionId, codeword: CODEWORD, basicPass: true }));
  finish({ G1: "PASS", G2: "PASS", G3: requestPermissionCount > 0 ? "PASS" : "UNEXERCISED" });
}

if (!state.sessionId || state.basicPass !== true) fail("run `basic` first (gating: basic -> restart -> cancel -> sigkill)");

if (phase === "restart") {
  const mtimeBefore = statOf(spikeTxt)?.mtimeMs;
  await killProcess("SIGTERM");
  await startProcess();
  await initialize();
  const loadRes = await request("session/load", { sessionId: state.sessionId, cwd: work, mcpServers: [] });
  record("note", { loadResponse: loadRes ?? null });
  // Verify timeline restoration BEFORE sending anything new.
  await sleep(4000);
  const replayed = updates.length; // session/update events emitted by load
  // Conversation-only fact: the codeword was spoken once, never written to disk.
  const r = await prompt(state.sessionId, RESUME_Q);
  const mtimeAfter = statOf(spikeTxt)?.mtimeMs;
  const nonceOk = r.text.includes(state.codeword);
  const g5 = replayed > 0 && nonceOk && mtimeBefore === mtimeAfter;
  log(`G5 [runtime]: ${g5 ? "PASS" : "FAIL"} replayedEvents=${replayed} codewordFromMemory=${nonceOk} fileUntouched=${mtimeBefore === mtimeAfter} stop=${r.stopReason}`);
  log(`   answer excerpt: ${JSON.stringify(r.text.slice(0, 220))}`);
  if (!g5) fail("G5 — conversation restoration not proven (documented finding)");
  state.restartPass = true;
  writeFileSync(sessionState, JSON.stringify(state));
  finish({ G5: "PASS" });
}

if (phase === "cancel") {
  if (state.restartPass !== true) fail("restart phase did not record a PASS");
  await startProcess();
  await initialize();
  await request("session/load", { sessionId: state.sessionId, cwd: work, mcpServers: [] });
  rmSync(countTxt, { force: true });
  const pPromise = prompt(state.sessionId, TASK2).catch((e) => ({ stopReason: `error:${String(e).slice(0, 80)}`, text: "" }));
  // Require observable activity AND a real side effect before cancelling (review finding R2).
  const active = await awaitActivity(20000);
  let started = false;
  for (let i = 0; i < 60; i++) { if (countLines() >= 1) { started = true; break; } await sleep(500); }
  if (!started) fail("G4 — no observable activity and no side effect; cannot evaluate cancellation (review finding R2)");
  notify("session/cancel", { sessionId: state.sessionId });
  const resolved = await pPromise;
  await sleep(2500);
  const n = countLines();
  const g4 = n >= 1 && n < 500;
  log(`G4 [runtime]: ${g4 ? "PASS" : "FAIL"} activityObserved=${active} sideEffectStarted=${started} stopReason=${resolved.stopReason} countLines=${n} (require 1..499)`);
  if (!g4) fail("G4 — cancellation evidence insufficient");
  state.cancelPass = true;
  writeFileSync(sessionState, JSON.stringify(state));
  finish({ G4: "PASS" });
}

if (phase === "sigkill") {
  if (state.cancelPass !== true) fail("cancel phase did not record a PASS");
  await startProcess();
  await initialize();
  await request("session/load", { sessionId: state.sessionId, cwd: work, mcpServers: [] });
  rmSync(countTxt, { force: true });
  const p = prompt(state.sessionId, TASK2).catch(() => ({ stopReason: "killed", text: "" }));
  // Gate the kill on an in-flight side effect: file exists and generation/tool activity observed.
  let started = false;
  for (let i = 0; i < 90; i++) { if (countLines() >= 1) { started = true; break; } await sleep(500); }
  if (!started) fail("G6 — task never produced a side effect; cannot evaluate mid-operation kill (review finding R3)");
  await awaitActivity(5000);
  const pidBefore = proc.pid;
  await killProcess("SIGKILL");
  try { await p; } catch {}
  await sleep(1000);
  const killedState = { lines: countLines(), mtime: statOf(countTxt)?.mtimeMs };
  // New process must be a genuinely different PID.
  await startProcess();
  await initialize();
  const newPid = proc.pid;
  const loadOk = await request("session/load", { sessionId: state.sessionId, cwd: work, mcpServers: [] }).then(() => true).catch((e) => { record("note", { loadAfterKillError: String(e).slice(0, 200) }); return false; });
  await sleep(4000);
  // No zombie writes: file must be stable across the reload window.
  const stable = countLines() === killedState.lines && statOf(countTxt)?.mtimeMs === killedState.mtime;
  let report = "(skipped — load failed)";
  let fabricated = false;
  if (loadOk) {
    const r = await prompt(state.sessionId, `The previous task may have been interrupted. Without using any tools: state whether the count-to-500 task completed, and how many lines count.txt reached, to the best of your knowledge of this conversation.`);
    report = r.text.slice(0, 300);
    fabricated = /\b(completed|finished|done|all 500)\b/i.test(r.text) && !/interrupt|not complete|stopped|did not/i.test(r.text);
  }
  const g6 = loadOk && killedState.lines > 0 && killedState.lines < 500 && stable && newPid !== pidBefore && !fabricated;
  log(`G6 [runtime]: ${g6 ? "PASS" : "FAIL"} pid ${pidBefore}->${newPid} loadAfterKill=${loadOk} linesAtKill=${killedState.lines} stableAfterReload=${stable} fabricatedCompletion=${fabricated}`);
  log(`   agent report excerpt: ${JSON.stringify(report)}`);
  if (!g6) fail("G6 — crash-resilient resume not proven (documented finding)");
  finish({ G6: "PASS" });
}
