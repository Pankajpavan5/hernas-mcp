# Hernas MCP

Android device control + an agent-to-agent chat bridge, over MCP. Successor to
[arena-mcp](https://github.com/Pankajpavan5/arena-mcp); analysis and reasons for every fork are in
the local `hernas/ANALYSIS.md`. Runs on plain Node (≥22.6, tested on 26) — no build step, no
Python, no ADB.

Three things in one process:

1. **Device relay** — a phone app polls long-poll endpoints, picks up shell/UI jobs, posts results.
   The phone dials out; the server never dials in, so NAT, firewalls and USB don't matter.
2. **Agent bridge** — threads where AI agents talk to each other, with loop guards: hop ceiling,
   per-agent turns, cooldown, thread token budget, STOP kill switch, dedupe.
3. **Piggyback delivery** — messages waiting for an agent are attached to the result of whatever
   tool call that agent makes next. The bridge stays alive without the client polling `read_inbox`
   or an out-of-band channel. Delivery is exactly-once with the tool result intact.

Forked from arena-mcp (commit `64724c8`, no LICENSE file — the fork author holds the copyright as
repo owner). What was deliberately cut: ADB transport (upstream's real transport is a Shizuku
relay, not ADB), fixed-interval pollers (~272 wakeups/min upstream), wildcard `"*"` device ids,
the screen mirror, and the hardcoded default relay token.

## Quick start

```sh
npm install
npm start
# prints a 10-digit access key once; dashboard on http://127.0.0.1:7420/
```

```sh
npm run doctor     # 5 checks: node version, data dir, key file, db, server reachable
npm test           # 39 tests
npm run key:rotate
```

Everything lives in `HERNAS_DATA` (default `~/.hernas`): `hernas.db` (SQLite via `node:sqlite`),
`key.json` (scrypt hash of the access key, mode 0600), `shots/` (device screenshots).

## Tools (17, live-verified over `tools/list`)

| bridge | device |
|---|---|
| `agent_register`, `agent_list` | `device_list`, `device_info` |
| `send_message`, `broadcast` | `shell`, `screenshot` |
| `read_inbox`, `thread_status`, `end_thread` | `tap`, `long_press`, `swipe` |
| | `type_text`, `keyevent`, `ui_dump` |

Every device tool takes an explicit `device` id; there is no wildcard. Agent identity comes from
the `x-hernas-agent` header (HTTP) or `HERNAS_AGENT` env (stdio).

## Hosting (Render)

A `render.yaml` blueprint is included: free Node service, `npm ci --omit=dev` +
`node src/server.ts`, `/healthz` probe. Deploy via Render Blueprint from this repo, or a plain
web service. Three secrets belong in the service env (none has a default):

- `HERNAS_MCP_KEY` — gates `/mcp`. Without it, a public deployment lets anyone call tools.
- `HERNAS_RELAY_TOKEN` — the phone's credential; fixed value survives redeploys.
- `HERNAS_ACCESS_KEY` — optional stable dashboard key; without it a fresh 10-digit key is
  printed into the service logs on every boot (free plan has an ephemeral disk, so
  threads/audit/screenshots reset on each restart anyway).

## Client config

MCP endpoint: `http://127.0.0.1:7420/mcp` locally, or the Render URL. Streamable HTTP, stateless.

- **OpenCode — TESTED.** In `opencode.json` (V2 shape, servers under `mcp.servers`):
  ```json
  { "mcp": { "servers": { "hernas": {
      "type": "remote",
      "url": "http://127.0.0.1:7420/mcp",
      "oauth": false,
      "headers": { "x-hernas-agent": "opencode" } } } } }
  ```
  Hosted: point `url` at the Render URL and add
  `"x-hernas-key": "{env:HERNAS_MCP_KEY}"` to `headers`.
- **Claude Code — UNTESTED on this box.**
  `claude mcp add --transport http hernas http://127.0.0.1:7420/mcp --header "x-hernas-key: <key>"`
- **ChatGPT / OpenAI clients — UNTESTED.** No MCP client standard yet; use the dashboard bridge
  or wrap `tools/list` / `tools/call`.
- **Claude Desktop — UNTESTED.** No remote MCP support at time of writing; use
  `node src/server.ts --stdio` (stdio mode, identity via `HERNAS_AGENT` env).

## Phone side (relay contract)

Two endpoints, guarded by the relay token (persisted in `kv`, printed at boot, never a
compile-time default):

```
GET  /api/device/poll?device=<id>&name=<model>&sdk=<n>   long-poll up to HERNAS_POLL_SECONDS
     header: x-hernas-relay-token: <token>
     → one job {id, command, timeoutMs} or 204
POST /api/device/result   {id, device, stdout, stderr, exitCode}
     header: x-hernas-relay-token: <token>
```

A minimal phone client is ~40 lines of shell/Tasker/Termux: poll, run with timeout, post result.

## Configuration

Env vars only, all optional (see `src/config.ts` for defaults):
`HERNAS_PORT` 7420 (falls back to Render's `PORT`) · `HERNAS_HOST` 127.0.0.1 (loopback on
purpose) · `HERNAS_DATA` · `HERNAS_MCP_PATH` /mcp · `HERNAS_MCP_KEY` (empty = open `/mcp`; set it
whenever `HERNAS_HOST` is not loopback) · `HERNAS_RELAY_TOKEN` · loop guards `HERNAS_MAX_HOPS` 12,
`HERNAS_MAX_TURNS` 4, `HERNAS_COOLDOWN_MS` 1500, `HERNAS_THREAD_TOKENS` 60000 ·
`HERNAS_ATTACH_MAX` 10, `HERNAS_ATTACH_BYTES` 8000 · `HERNAS_POLL_SECONDS` 25,
`HERNAS_CMD_TIMEOUT_MS` 90000, `HERNAS_MAX_OUTPUT` 512KiB · `HERNAS_SESSION_IDLE_MS` 12h.

## Dashboard

Single `src/dashboard.html`, no build step. Tabs: Devices, Bridge (threads, hop meter, STOP),
Audit, Settings. Login is the 10-digit key; session cookie HttpOnly + SameSite=Strict + CSRF
header on writes; tabs deep-link via `#devices` / `#bridge` / `#audit` / `#settings`.

Security notes: `SECURITY.md`.
