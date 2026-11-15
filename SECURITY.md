# Threat model & security notes

## Assets
- The phone: shell access = the device. Highest value.
- The bridge: an attacker who can `send_message` can steer every connected AI agent.
- The access key: unlocks the dashboard and full control.

## Auth design
- **Dashboard key**: 10 digits from the CSPRNG, generated on first boot, shown once, stored as
  scrypt (N=16384) in `key.json` mode 0600. No default key exists to ship accidentally
  (upstream hardcoded `d31eeff29eb82855` at `server.py:44`).
- **Lockout**: 5 wrong keys per IP in 60 s → the IP is locked out for the window, even with the
  correct key. Intent: make brute force pointless at 10^10 space.
- **Session**: HttpOnly SameSite=Strict cookie, idle timeout 12 h, CSRF token required on every
  write (checked server-side), Origin checked on POSTs.
- **Relay token**: separate credential from the key, 128-bit CSPRNG, persisted in `kv` so a
  restart doesn't orphan phones, printed once at boot. Constant-time compared.
- **Audit**: every tool call logged with agent, device, args (redacted), ok/error, duration.

## What is protected, and what is not
| threat | status |
|---|---|
| Remote attacker reaches server | only if you set `HERNAS_HOST` off loopback; boot prints a warning |
| Brute-force dashboard key | lockout + 10-digit space |
| CSRF / XSS on dashboard | Strict cookie + CSRF header + `esc()` on all interpolated HTML |
| Phone impersonating another phone | per-device queues; a poll must carry the device id it claims; results rejected if job belongs to another device |
| Rogue agent reading others' messages | identity = `x-hernas-agent`; a rogue can register its own id but gets only messages addressed to it (or `broadcast`) |
| Runaway agent loops | hop ceiling, per-agent turns, cooldown, token budget, STOP |
| Job output leaking secrets into agent context | output capped 512 KiB, audit args redacted |

## Honest limits
- HTTP is **cleartext on loopback**. If you bind off-loopback you must put TLS in front
  (reverse proxy). There is no built-in TLS.
- The relay token travels in a header over that cleartext link; on a LAN that is sniffable.
- The 10-digit key is ~33 bits: fine behind lockout on loopback, weak if exposed.
- Agents are trusted once they hold a valid agent id. There is no per-agent ACL yet — any agent
  can `shell` on any listed device. Multi-tenant hardening is future work.
- Screenshots and shell output are stored on disk unencrypted (`shots/`, db).
