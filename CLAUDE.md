# CLAUDE.md — project memory for Hernas MCP

Read this before touching the code. Facts that cost a debugging session to learn are written here.

## What this is
`hernas-mcp` replaces the user's `arena-mcp` (upstream: `github.com/Pankajpavan5/arena-mcp`,
pin `64724c8dec038da59e189442b4ddfdbe3bb64630`, **no LICENSE file** — user owns the copyright as
repo owner; state that before any fork). Phase 0/1 analysis lives in `hernas/ANALYSIS.md` with
76 verified `file:line` citations. Never restate an upstream claim without a citation.

## Stack (decided; do not revisit without cause)
- Node ≥22.6 native TypeScript (`node src/server.ts` runs `.ts` directly on Node 26).
- `node:sqlite` (`DatabaseSync`) — **not** better-sqlite3 (aarch64 build fails on this box).
- `node --test` — not vitest. No `tsc`, no pnpm, no `adb` on this machine.
- deps: `@modelcontextprotocol/sdk`, `ws`, `zod` — nothing else. Zero added deps for small features.

## Env constraints (learned the hard way)
- **Never** `pkill -f` / `pgrep -f` with patterns like `src/server.ts` or `HERNAS_PORT` — the
  pattern matches the shell's own command line and kills the session (seen: exit 143). Find the
  server via `/proc/*/cmdline` exact match `node src/server.ts ` plus `/proc/<pid>/environ`.
- Background servers started from a tool shell **die when that shell exits**. Start with
  `nohup env … node src/server.ts >> log 2>&1 &`.
- `dashboard.html` is read once at boot (`server.ts:160`) — restart the server after editing it.
- The in-app browser: clicks and `browser_read_page` can lag or hang when the app is backgrounded;
  screenshots may show a stale frame. Verify DOM state with `browser_eval_js`, and hash-only
  navigation (`/#bridge`) does **not** reload the document — add a query param to force it.
- Login lockout also blocks the correct key during the window — intentional; tests rely on order.

## Bugs fixed in this session (keep in tests)
- Dashboard tab switching extracted to `showTab()`; tabs deep-link via `location.hash`.
- First paint picked a thread but never loaded it (`load()` now calls `loadThread()` when it
  auto-picks) — was "No messages in this thread." on every fresh load.
- WebSocket state pushes carry `messages: []` and clobbered the loaded transcript right after
  login — the client preserves `state.messages` across WS updates (`dashboard.html`).
- Verified live: 17 registered tools (not 20 as earlier noted) via `tools/list` over `/mcp`.

## Standing gaps (do not claim these work)
- No ADB transport (upstream's real transport is a Shizuku relay long-poll; `adb` absent here).
- No real phone on the relay end-to-end; the phone client is documented in README §relay contract
  but not implemented here.
- Device registry is in-memory: a server restart forgets devices until phones re-poll.
- Battery impact is arithmetic on loop periods, not measured mAh.
- Dockerfile and the non-OpenCode client snippets are UNTESTED.

## Where it runs (as of this session)
- Local demo: `127.0.0.1:7420` (nohup, log `~/../tmp/hernas-demo.log`, data `/usr/tmp/hernas-demo`).
- Hosted: `https://hernas-mcp.onrender.com` (Render free, Singapore). Secrets live in
  `~/projects/hernas/render.env` (0600) and in the Render service env — never in the repo.
- OpenCode config: `~/.config/opencode/opencode.json` has `hernas` (local) and `hernas-cloud`
  (Render) entries, identity `opencode`. V2 shape: servers under `mcp.servers`, `oauth: false`.
- Auto-deploy is ON: every `git push` to main redeploys and wipes the ephemeral instance state.

## Verification rules
"Done" = pasted command output in `hernas/SELF_CHECK.md`. 38/38 tests green is the bar for the
core; anything new non-trivial gets a test before merge. No TODOs in shipped paths.
