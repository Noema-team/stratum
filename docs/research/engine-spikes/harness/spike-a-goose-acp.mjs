#!/usr/bin/env node
// Spike A — drive Goose as an ACP agent over stdio. Zero dependencies.
// See ../README.md for safety rules, acceptance criteria and versions.
// Usage: node spike-a-goose-acp.mjs basic|restart|cancel|sigkill
// Phases are gated: each destructive phase refuses to run without the previous PASS.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";

const GOOSE_BIN = process.env.GOOSE_BIN ?? "goose";
const GOOSE_ACP_ARGS = (process.env.GOOSE_ACP_ARGS ?? "acp").split(" ").filter(Boolean);
const TIMEOUT = Number(process.env.SPIKE_TIMEOUT_MS ?? 240_000);
const OUT = process.env.SPIKE_OUT ?? join("/tmp", "stratum-spike-out");
const ENGINE_TAG = "GOOSE_ACP";
const phase = process.argv[2];
if (!["basic", "restart", "cancel", "sigkill"].includes(phase)) {
  console.error("usage: node spike-a-goose-acp.mjs basic|restart|cancel|sigkill");
  process.exit(2);
}

mkdirSync(join(OUT, "goose-work"), { recursive: true });
const work = join(OUT, "goose-work");
const sessionState = join(OUT, "goose-session.json");
const transcriptFile = join(OUT, "goose-acp.jsonl");
if (!existsSync(join(work, ".git"))) execSync("git init -q", { cwd: work }); // isolation: scratch repo only

const log = (...a) => console.log(...a);
const REDACTIONS = [/(sk-[A-Za-z0-9_-]{8,})/g, /(Bearer\s+\S+)/g];
const redact = (s) => REDACTIONS.reduce((acc, re) => acc.replace(re, "[REDACTED]"), String(s));
const record = (dir, obj) => {
  const line = redact(JSON.stringify({ t: Date.now(), phase, dir, ...obj }));
  writeFileSync(transcriptFile, (existsSync(transcriptFile) ? readFileSync(transcriptFile, "utf8") : "") + line + "\n");
};

const spikeTxt = join(work, "spike.txt");
const countTxt = join(work, "count.txt");
const TASK1 = `Create a file named spike.txt in this directory. Its exact contents must be exactly two lines: first line SPIKE_OK_2026_10_19 and second line ${ENGINE_TAG}_RESUME. Do nothing else.`;
const TASK2 = `Write the numbers from 1 to 500 into a file named count.txt in this directory, one number per line.`;
const RESUME_Q = `Without modifying any files, reply with the exact two lines of spike.txt.`;

// ---------- minimal ACP client (newline-delimited JSON-RPC over stdio) ----------
let proc = null;
let nextId = 1;
const pending = new Map();
const updates = [];
let requestPermissionCount = 0;
const updateTypeInventory = new Map();

const send = (obj) => { record("C->A", obj); proc.stdin.write(JSON.stringify(obj) + "\n"); };
const request = (method, params, ms = TIMEOUT) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`TIMEOUT ${method} (${ms}ms) — failing phase per cost/time limits`)); }, ms);
    pending.set(id, { resolve, reject, timer, method });
    send({ jsonrpc: "2.0", id, method, params });
  });
};
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startProcess() {
  proc = spawn(GOOSE_BIN, GOOSE_ACP_ARGS, { cwd: work, stdio: ["pipe", "pipe", "pipe"] });
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
  proc.on("exit", (code, sig) => record("proc/exit", { code, signal: sig }));
  return new Promise((res, rej) => { proc.on("spawn", res); proc.on("error", rej); });
}
function killProcess(sig = "SIGKILL") {
  return new Promise((res) => {
    if (!proc || proc.exitCode !== null) return res();
    proc.on("exit", res);
    proc.kill(sig);
    setTimeout(res, 5000).unref?.(); // don't hang if the process ignores the signal
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
    updates.push(msg.params?.update);
    return;
  }
  if (msg.method === "session/request_permission") {
    requestPermissionCount++;
    const opts = msg.params?.options ?? [];
    const pick = opts.find((o) => o.kind === "allow_once") ?? opts.find((o) => o.kind === "allow_always") ?? opts[0];
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
  updates.length = 0;
  const res = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  return { stopReason: res?.stopReason, text: updates.map((u) => u?.content?.text ?? u?.delta?.text ?? "").join("") };
}
const watchReplay = (ms) => { updates.length = 0; return new Promise((r) => setTimeout(() => r(updates.length), ms)); };

async function probeSessionList(sessionId) {
  try { const r = await request("session/list", { cwd: work, mcpServers: [] }, 15_000); record("note", { sessionList: r }); return "supported"; }
  catch (e) { if (String(e).includes("-32601") || String(e).toLowerCase().includes("unimplemented") || String(e).toLowerCase().includes("method not found")) return "unsupported (FINDING)"; return `error: ${String(e).slice(0, 120)}`; }
}

// ---------- phases ----------
const state = existsSync(sessionState) ? JSON.parse(readFileSync(sessionState, "utf8")) : {};
const fail = (msg) => { log(`\nPHASE ${phase}: FAIL — ${msg}`); if (proc) { try { proc.stdin.end(); } catch {} proc.kill("SIGTERM"); } process.exit(1); };
const ok = (gates) => {
  log(`\n=== PHASE ${phase}: PASS ===`);
  for (const [k, v] of Object.entries(gates)) log(`${k}: ${v}`);
  log("update-type inventory:", Object.fromEntries(updateTypeInventory));
  log("permission requests observed:", requestPermissionCount);
  if (proc) { try { proc.stdin.end(); } catch {} proc.kill("SIGTERM"); }
  process.exit(0); // the engine child keeps the loop alive; exit explicitly per phase
};

if (phase === "basic") {
  rmSync(spikeTxt, { force: true });
  await startProcess();
  const caps = await initialize();
  const sessionId = await newSession();
  writeFileSync(sessionState, JSON.stringify({ sessionId }));
  const listProbe = await probeSessionList(sessionId);
  const r1 = await prompt(sessionId, TASK1);
  let lines = null; try { lines = readFileSync(spikeTxt, "utf8").split(/\r?\n/).filter(Boolean); } catch {}
  const g2 = JSON.stringify(lines) === JSON.stringify(["SPIKE_OK_2026_10_19", `${ENGINE_TAG}_RESUME`]);
  log(`G1 [protocol]: PASS sessionId=${sessionId} loadSession=${caps?.agentCapabilities?.loadSession} protocolVersion=${caps?.protocolVersion}`);
  log(`G2 [runtime]: ${g2 ? "PASS" : `FAIL contents=${JSON.stringify(lines)} stop=${r1.stopReason}`}`);
  log(`G3 [runtime]: ${requestPermissionCount > 0 ? `PASS mediated ${requestPermissionCount} request_permission round-trip(s)` : "N/A no session/request_permission emitted — record engine authorization state"}`);
  log(`session/list probe: ${listProbe}`);
  log("reconnection note: stdio binding couples engine lifetime to the client — detached reconnection is not exercisable here (FINDING if the runtime requires it); proceed to `restart`.");
  if (!g2) fail("G2");
  writeFileSync(sessionState, JSON.stringify({ ...state, sessionId, basicPass: true }));
  ok({ "G1": "PASS", "G2": "PASS", "G3": "see above" });
} else {
  if (!state.sessionId) fail(`no prior session state — run \`basic\` first (gating order: basic → restart → cancel → sigkill)`);
  if (phase === "restart") {
    if (state.basicPass !== true) fail("basic phase did not record a PASS");
    const mtimeBefore = statSync(spikeTxt).mtimeMs;
    await killProcess("SIGTERM"); // clean exit of the *client side*; stdio couples engine lifetime to it
    await startProcess();
    await initialize();
    await request("session/load", { sessionId: state.sessionId, cwd: work, mcpServers: [] });
    const replayed = await watchReplay(4000);
    const r3 = await prompt(state.sessionId, RESUME_Q);
    const mtimeAfter = statSync(spikeTxt).mtimeMs;
    const g5 = r3.text.includes("SPIKE_OK_2026_10_19") && r3.text.includes(`${ENGINE_TAG}_RESUME`) && mtimeBefore === mtimeAfter;
    log(`G5 [runtime]: ${g5 ? "PASS" : "FAIL"} cold-restart resume: replayedEvents=${replayed} answerQuoted=${r3.text.includes("SPIKE_OK_2026_10_19")} fileUntouched=${mtimeBefore === mtimeAfter} stop=${r3.stopReason}`);
    if (!g5) fail("G5 cold restart/resume — documented finding, no workaround applied");
    state.restartPass = true;
    writeFileSync(sessionState, JSON.stringify(state));
    ok({ "G5": "PASS" });
  } else if (phase === "cancel") {
    if (state.restartPass !== true) fail("restart phase did not record a PASS");
    // Attach a fresh client to the persisted session first (each phase is a new process).
    await startProcess();
    await initialize();
    await request("session/load", { sessionId: state.sessionId, cwd: work, mcpServers: [] });
    rmSync(countTxt, { force: true });
    const p = prompt(state.sessionId, TASK2);
    await sleep(5000); // let it get mid-count (non-destructive wait)
    notify("session/cancel", { sessionId: state.sessionId });
    let stop; try { stop = (await p).stopReason; } catch (e) { stop = `error:${String(e).slice(0, 120)}`; }
    await sleep(1500);
    let n = -1; try { n = readFileSync(countTxt, "utf8").split(/\r?\n/).filter(Boolean).length; } catch {}
    const g4 = n !== -1 ? n < 500 : true; // absent file also proves the task did not complete
    log(`G4 [runtime]: ${g4 ? "PASS" : "FAIL"} stopReason=${stop} countLines=${n} (<500 required, absent acceptable)`);
    if (!g4) fail("G4 cancellation did not stop the work");
    state.cancelPass = true;
    writeFileSync(sessionState, JSON.stringify(state));
    ok({ "G4": "PASS" });
  } else if (phase === "sigkill") {
    if (state.cancelPass !== true) fail("cancel phase did not record a PASS");
    await startProcess();
    await initialize();
    await request("session/load", { sessionId: state.sessionId, cwd: work, mcpServers: [] });
    rmSync(countTxt, { force: true });
    const p = prompt(state.sessionId, TASK2);
    await sleep(5000);
    await killProcess("SIGKILL"); // destructive: engine dies mid-turn
    try { await p; } catch (e) { record("note", { pendingPromptError: String(e).slice(0, 200) }); }
    await startProcess();
    await initialize();
    let loadOk = true;
    try { await request("session/load", { sessionId: state.sessionId, cwd: work, mcpServers: [] }); await watchReplay(4000); }
    catch (e) { loadOk = false; log(`session/load after SIGKILL: FAILED — ${String(e).slice(0, 200)}`); }
    let n = -1; try { n = readFileSync(countTxt, "utf8").split(/\r?\n/).filter(Boolean).length; } catch {}
    let quote = "(skipped — load failed)";
    if (loadOk) {
      const r = await prompt(state.sessionId, `The previous task may have been interrupted. Without modifying any files, state how many lines count.txt has and what its last line is.`);
      quote = r.text.slice(0, 300);
    }
    const g6 = loadOk && n < 500;
    log(`G6 [runtime]: ${g6 ? "PASS" : "FAIL"} sigkill resilience: loadAfterKill=${loadOk} countLines=${n} (<500 required) agentReport=${JSON.stringify(quote)}`);
    if (!g6) fail("G6 — document as finding: crash-resilient resume unsupported or inconsistent");
    ok({ "G6": "PASS" });
  }
}
