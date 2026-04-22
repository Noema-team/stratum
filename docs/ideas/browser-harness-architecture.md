# Browser Harness — Architecture Deep Dive

**Source:** github.com/browser-use/browser-harness (4.8k stars, browser-use team, MIT, Python 100%)
**Date analyzed:** 2026-04-22
**Purpose:** Understand browser-harness' method for potential integration with Stratum's validation system.

---

## Architecture (~592 lines total)

```
Chrome / Browser Use cloud → CDP WS → daemon.py → /tmp/bu-<NAME>.sock → run.py
```

### `run.py` (~36 lines)
Entry point. Reads Python from stdin, `exec()`s it with helpers pre-imported.
```bash
browser-harness <<'PY'
new_tab("https://example.com")
print(page_info())
PY
```

### `helpers.py` (~195 lines)
CDP primitives — the agent's "hands":
- `cdp(method, **params)` — raw CDP calls
- `click(x, y)` — coordinate-based mouse events (passes through iframes/shadow/cross-origin)
- `type_text(text)` — text input
- `screenshot(path)` — capture current page
- `goto(url)` — navigate (also checks for domain-skills)
- `js(expression)` — run JavaScript
- `wait_for_load()` — poll until `document.readyState == 'complete'`
- `list_tabs()`, `switch_tab()`, `new_tab()` — tab management
- `upload_file(selector, path)` — file upload via CDP
- `http_get(url)` — pure HTTP (no browser), supports ThreadPoolExecutor for bulk
- `drain_events()` — collect CDP events since last check

### `daemon.py` (~361 lines)
CDP websocket holder + Unix socket relay:
- One daemon per `BU_NAME` (namespaced socket/pid/log)
- Connects to user's running Chrome via DevToolsActivePort
- Protocol: one JSON line each way over Unix socket
- Auto-attaches to first real page tab
- Handles stale sessions by re-attaching
- Marks controlled tab with 🟢 emoji in title

### `admin.py` (~361 lines)
Lifecycle management:
- `ensure_daemon()` — idempotent start
- `restart_daemon()` — best-effort stop + cleanup
- `start_remote_daemon()` — provision Browser Use cloud browser
- `run_setup()` — interactive Chrome attachment
- `run_doctor()` — diagnostics
- `run_update()` — self-update with daemon restart
- Profile sync: `list_cloud_profiles()`, `sync_local_profile()`

---

## Core Design Principles

1. **Coordinate clicks default** — `Input.dispatchMouseEvent` goes through iframes/shadow/cross-origin at compositor level. No DOM-specific selectors needed for basic interaction.
2. **Connect to user's running Chrome** — doesn't launch its own browser.
3. **Screenshots first** — `screenshot()` → look → `click(x,y)` → `screenshot()` verify. The primary interaction loop.
4. **No framework** — no retries, session manager, config system, or logging framework. The agent IS the framework.
5. **Self-healing** — agent edits `helpers.py` mid-task to add missing functions.
6. **Self-improving** — creates `domain-skills/<site>/` playbooks after tasks.

---

## Self-Improvement: Domain Skills

After completing a browser task, the agent creates a domain skill capturing:

**What to capture:**
- URL patterns and query params
- Private APIs and payload shapes (often 10x faster than DOM scraping)
- Stable selectors (`data-*`, `aria-*`, `role`)
- Framework/interaction quirks unique to the site
- Waits and why they're needed
- Traps — stale drafts, legacy IDs, unicode quirks, beforeunload dialogs, CAPTCHA surfaces

**What NOT to capture:**
- Raw pixel coordinates (break on viewport/zoom changes)
- Step-by-step narration of specific tasks
- Secrets, cookies, session tokens

**Interaction skills** (reusable UI mechanics): `cookies.md`, `dialogs.md`, `iframes.md`, `shadow-dom.md`, `uploads.md`, etc.

---

## Key Patterns for Stratum

### Screenshot-driven verification
```
screenshot() → analyze → click(x,y) → screenshot() → verify
```
This is the core loop. For Stratum's validation, a `browser-check` node could:
1. Navigate to the built app
2. Screenshot each route/page
3. Compare against design specs or acceptance criteria
4. Report visual differences as validation failures

### Domain skill persistence
The agent learns site-specific quirks and persists them. For Stratum:
- After a validation cycle fails due to a UI quirk (e.g., "React combobox only commits on Escape"), persist that gotcha
- Future validation cycles load the gotcha and handle it automatically

### Remote browser support
- Browser Use cloud provides isolated browsers (free tier: 3 concurrent)
- Useful for Stratum's validation running on a headless server
- `BU_NAME` namespaces allow parallel validation nodes

### Pure HTTP for static content
`http_get()` + `ThreadPoolExecutor` — no browser needed for static pages. Stratum could validate API endpoints and static pages without spinning up a browser.

---

## Integration Concerns for Stratum

1. **Security**: Browser harness connects to running Chrome with full CDP access. In Stratum's container-based validation (DDR-008), this needs careful sandboxing.
2. **Complexity**: ~592 lines is minimal. The risk is the agent editing helpers.py freely — Stratum's gated validation model may want more controlled extension points.
3. **State management**: Browser state (cookies, auth) persists across sessions. Stratum would need to manage this explicitly per validation cycle.
4. **Performance**: Screenshots are fast but LLM analysis of screenshots is slow. Batched verification (screenshot all pages, analyze in one pass) would be more efficient.
