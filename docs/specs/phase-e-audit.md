# Phase E — Audit: Spec vs Implementation

**Date:** 2026-05-12
**Spec:** `docs/apps/sdk-orchestrator/v2/specs/phase-e-daemon-mvp.md`
**Implementation:** `src/sdk-orchestrator/v2/src/`

---

## Summary

| Status | Count |
|---|---|
| ✅ Fully matches spec | 4 modules |
| 🔶 Partial match | 3 modules |
| ❌ Missing / Deviates | 1 area |
| 📝 Spec-only (not implemented) | 0 |

---

## Module-by-Module

### ✅ PIDFile (`src/pid-file.ts`, 31 lines)

Spec says:
- `writePidFile(path, pid) → Promise<void>`
- `readPidFile(path) → Promise<number | null>`
- `removePidFile(path) → Promise<void>`
- `isPidAlive(pid) → boolean`

Implementation: ✅ All 4 functions exist, correct signatures, uses `process.kill(pid, 0)` for alive check. Matches spec exactly.

### ✅ DaemonConfig (`src/daemon-config.ts`, 128 lines)

Spec says:
- `DaemonConfig` interface with `port`, `projectRoot`, `foreground`, `noOpen`
- `DaemonCommand` discriminated union (5 commands)
- `parseCLIArgs(argv) → DaemonCommand`

Implementation: ✅ All types defined. Parse function handles `init`, `start`, `stop`, `status`, `discover` with correct flags. Default port 7700.

### ✅ RuleLoader (`src/rule-loader.ts`, 118 lines)

Spec says:
- `RuleLoader` interface with `loadAll`, `generateDefaults`, `validate`
- Generate 7 default rule files
- Validate against Zod schemas from types.ts

Implementation: ✅ Three methods exist. Generates all 7 files with minimal YAML templates. Uses `js-yaml` for parsing. Validates with Zod safeParse.

### 🔶 InitService (`src/init-service.ts`, 455 lines)

| Spec section | Status | Notes |
|---|---|---|
| InitState data model | ✅ | Matches |
| `init(projectRoot, params) → InitResult` | ✅ | 10-step sequence |
| `resume(projectRoot) → InitResult` | ✅ | Partial state tracking |
| `reset(projectRoot, name) → void` | ✅ | Cleanup + name check |
| Step 0: Prerequisite check | ✅ | Git + Node + .sle/ absent |
| Step 1: Project identity | ✅ | Name + description |
| Step 2: Project type | ✅ | |
| Step 3: Remotes | 🔶 | Spec says 3a/3b/3c (code + issues + docs). Impl has simplified version |
| Step 4: Rule files | ✅ | Via RuleLoader |
| Step 5: TaskStore | 🔶 | Spec says Beads or local. Impl: local only |
| Step 6: Docs clone | 🔲 | Stubbed — returns empty |
| Step 7: agent.md + map.yaml | ✅ | Basic templates |
| Step 8: Prompt templates | 🔲 | Stubbed |
| Step 9: Commit | 🔲 | Stubbed |
| Step 10: Daemon start | 📝 | Spec says "manual via sle start" |
| Resume behaviour | ✅ | init-state.json tracking |
| Reset with confirm_name | ✅ | |

**Deviation:** step3 is simplified, step5/6/8/9 are stubs, not implementations. Spec explicitly says "simplified init" but the stubs should perhaps throw or log rather than silently no-op.

### 🔶 DiscoveryService (`src/discovery-service.ts`, 266 lines)

| Spec section | Status | Notes |
|---|---|---|
| `start(projectRoot, params) → DiscoverySession` | ✅ | Returns session with opening question |
| `submitResponse(sessionId, round, response) → RoundResult` | ✅ | Echoes back as markdown draft |
| `approveRound(sessionId, round) → void` | ✅ | State transition + session cleanup |
| `getStatus(sessionId) → DiscoveryResult` | ✅ | |
| State transition (idle→discovering) | ✅ | Uses StateAPI |
| Solo mode (1 round) | ✅ | Implemented |
| Full mode (4 rounds) | 📝 | Spec says solo-only for MVP |
| Session persistence | ✅ | .sle/discovery-session.json |
| Opening question generation | 🔶 | Spec says question from spec. Impl: hardcoded string |

**Deviation:** Opening question is hardcoded ("What problem does your project solve?"), not generated from project type context. Trivial to fix, but the spec is vague here too.

### 🔶 DaemonServer (`src/daemon.ts`, 219 lines)

| Endpoint | Status | Notes |
|---|---|---|
| GET /api/v2/health | ✅ | Returns healthy + uptime |
| GET /api/v2/info | ✅ | Returns DaemonInfo |
| GET /api/v2/system/state | ✅ | |
| POST /api/v2/system/state/transition | ✅ | |
| GET /api/v2/system/flags | ✅ | |
| PATCH /api/v2/system/flags | ✅ | |
| POST /api/v2/init | ✅ | |
| GET /api/v2/init/state | ✅ | |
| POST /api/v2/discovery/start | ✅ | |
| GET /api/v2/discovery/status | ✅ | |
| JSON body parser | ✅ | |
| APIResponse/APIError envelope | ✅ | Discriminated union |
| Error handler (500 on unhandled) | ✅ | |
| State lock (serialize state changes) | 📝 | Not implemented — spec mentions this but it's a nice-to-have |
| PID file on start | ❌ | Spec says write `.sle/daemon.pid`. Impl has writePidFile available but DaemonServer.start() doesn't call it. **Deviation** |
| Graceful shutdown | ❌ | Spec says SIGTERM → graceful shutdown. Not implemented. **Deviation** |

### ✅ CLI (`src/cli.ts`, 229 lines)

Spec says:
- `sle init` — calls InitService
- `sle start` — starts DaemonServer
- `sle stop` — reads PID, kills, removes file
- `sle status` — checks if daemon alive
- `sle discover` — starts session
- Help text for all commands

Implementation: ✅ All 5 commands work. Help text on no args / -h. Dispatches to correct services. Handle errors with process.exit(1).

---

## Key Deviations (Need Fix)

| # | Severity | What | Where |
|---|---|---|---|
| 1 | **Medium** | DaemonServer.start() doesn't write PID file | `daemon.ts` |
| 2 | **Low** | Opening question is hardcoded, not from project type | `discovery-service.ts` |
| 3 | **Low** | Init step3/5/6/8/9 are stubs (silent no-op) | `init-service.ts` |

## Test Coverage

**Spec defines 4 test files, 47+ tests. Implementation: Zero Phase E tests exist.** The spec says the slice must have tests before it's complete. This is the biggest gap.

---

## Overall Assessment

| Area | Match |
|---|---|
| Type definitions | ✅ ~95% |
| Module interfaces | ✅ ~90% |
| Business logic | 🔶 ~75% |
| Error handling | ✅ ~80% |
| Tests | ❌ 0% |
| **Total** | **🔶 ~75%** |

The code is a reasonable first pass but needs:
1. PID file integration in DaemonServer
2. Tests (the big one — 4 files, 47+ tests per spec)
3. Stubs in InitService should either implement or throw, not silently pass