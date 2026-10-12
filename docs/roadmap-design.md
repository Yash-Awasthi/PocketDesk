# Roadmap design — 2026-10-12

Scope: the items picked from the open roadmap (device revocation, E2EE shares, foreground
service and biometric lock, WebRTC screen transport) plus three requirements:

- traffic must be `wss`, never plain `ws`;
- on the PC the daemon is visible only in Task Manager;
- settings are managed from the PC browser, and the phone keeps prompts, files and control.

`plan.md` and `CONTEXT.md` are older than the code. Several roadmap items are already
shipped or no longer apply, so Part 1 records where each one really stands before Part 2
designs the work that is left.

---

## Part 1 — Where each item stands

| Item | State in the code | Decision |
|---|---|---|
| Device revocation | Done on the daemon and in the browser. `devices.js` has per-device tokens, `revoke` and `allow`, a 90-day idle expiry and an iroh endpoint binding. `handlers/system.js:151` revokes, disconnects the device with 4003 and rotates the pairing token. `public/index.html:1727-1755` shows the device table. The phone has no device UI. | No phone UI. Move the device table to the settings page (Part 2.2). |
| E2EE shares | Shares were deleted in `1676aa3` ("Remove PC features that nothing on the phone or browser uses"). | Drop. There is nothing left to encrypt. Transport encryption is covered in Part 2.1. |
| Foreground service | Done. `LinkService.kt`, `foregroundServiceType="specialUse"` in the manifest. | Close the item. It still needs an on-device run. |
| Biometric lock | Done. `AppLock.kt` uses `BiometricPrompt` (weak biometric or device credential) and re-locks after 30 s in the background. | Close the item. It still needs an on-device run. |
| WebRTC screen transport | The ~3 fps JPEG path is gone. `desktop_video.js` streams H.264 (NVENC, QSV or x264) over ws, or over iroh with one QUIC stream per GOP, and steps the bitrate up and down with congestion. `docs/TRANSPORT-BENCH.md` measures it: no stalls at 5 % loss over iroh, and latency stays bounded to about one GOP when the link is too slow. | Drop WebRTC (Part 3). |
| Visible only in Task Manager | Mostly done (`4b33d18`). A windowless launcher starts the daemon as `PocketDesk.exe` from the HKCU Run key, with no tray icon and no window. | Close the remaining gaps (Part 2.3). |

---

## Part 2 — Design

### 2.1 wss only

**Why it matters.** Over `ws://` the hello message, which carries the pairing token or
the device token, crosses the LAN in cleartext. So does every terminal byte, file and
screen frame. Anyone on the same Wi-Fi can read them, and can replay the token to take
full control of the PC. `wss://` wraps the same traffic in TLS. The phone pins the
certificate's SHA-256 fingerprint from the QR code, so a self-signed certificate is as
safe as a CA-issued one.

**What is already right.**

- The daemon generates a self-signed certificate in pure Node on first run and enables TLS
  (`config.js:47-58`).
- The QR payload carries the fingerprint, and `Tls.pinnedClient` refuses any other
  certificate.
- Off-LAN traffic goes over iroh, which is QUIC with TLS 1.3 keyed to each endpoint's
  identity. A relay sees only ciphertext, so remote access is already end-to-end encrypted.
- On the relay path the hello carries an HMAC of the token, never the token itself.

**Holes.**

1. If certificate generation fails, the user daemon serves plaintext on every interface
   and only prints a warning (`config.js:55-57`). The console daemon already refuses to
   start in that case.
2. Setting `"tls": { "enabled": false }` in `config.json` silently makes the LAN
   plaintext.
3. The phone accepts `ws://`. `Pairing.kt:22` allows it in QR payloads,
   `WsClient.kt:301` connects with no TLS at all, and the manifest sets
   `usesCleartextTraffic="true"`.
4. The browser client hardcodes `ws://localhost:8765/ws` as its default
   (`public/index.html:124`, `:490`).

**Design.** The rule is that plaintext never leaves the machine.

- *Daemon.* When `useTls` is false, `server.listen` binds `127.0.0.1` instead of every
  interface, and logs why. This covers holes 1 and 2 with one line. The env-driven
  test mode already uses plain HTTP on loopback, so the tests keep working. iroh is
  unaffected because it carries its own encryption.
- *Phone.* `Pairing.parse` and the manual-add dialog reject `ws://` URLs with "re-pair
  over wss". `WsClient.openTransport` refuses a non-`wss` URL instead of falling back to
  the base client. Remove `usesCleartextTraffic` from the manifest; nothing else in the
  app uses `http://`. Existing `ws://` entries in `ServerBook` fail with the same message,
  and the user re-scans the QR code.
- *Browser client.* Derive the default URL from `location`
  (`wss://` + `location.host` + `/ws` when the page was served over HTTPS).
- *Manual add without a fingerprint* keeps the trust-on-first-use dialog
  (`Tls.collectingClient`). The QR code remains the recommended path.

**Checks.**

- `daemon/test`: a daemon started without TLS refuses a connection on the LAN address
  and accepts one on `127.0.0.1`.
- `PairingTest`: a `ws://` payload yields no entry. A `wss://` payload with a
  fingerprint parses.
- Deleting the loopback bind makes the daemon test fail.

### 2.2 Settings live in the PC browser

**Principle.** The phone does work: chat, terminals, files, desktop, and power actions.
Anything that changes the daemon's security posture is changed at the PC, in the browser
settings page. A stolen phone, or a leaked device token, can then use the PC but cannot
remove the other devices, turn off two-factor pairing or change the password.

**Today.**

- The settings page is `/pair`. It is served only to loopback, and only with `?k=<token>`.
  It already drives the connection password and the control toggle through
  `/access/*` (`server.js:150-177`).
- Device list, revoke and allow are WS messages, used by the full browser client
  (`index.html`) over any authenticated socket.
- TOTP setup and teardown are on the phone (`ui/PcControls.kt:83-117`, `ws.totp(...)`).

**Design.**

- Add these `/access` routes, behind the same loopback, Host and key checks:
  - `GET /access/devices` returns `devices.list()`.
  - `POST /access/devices/revoke {clientId}` does what `device_revoke` does today:
    revoke, disconnect, rotate the token and rebuild the pair page.
  - `POST /access/devices/allow {clientId}`.
  - `POST /access/totp {action: setup|enable|disable, code}` reuses `totp.js`.
- `pair.html` gains a Devices section and a Two-factor section. These sit next to the
  existing password and control controls.
- Remove from the WS protocol: `device_revoke`, `device_allow` and the TOTP
  setup/enable/disable messages. `device_list` stays read-only in case a client wants to
  show it. Update `test/protocol-contract.test.mjs` to match.
- Remove from the phone: the "Two-factor pairing" section of `PcControls.kt` and the
  matching `WsClient.totp` code. The pairing-time code dialog (`PcControls.kt:150-165`)
  stays, because it is part of authentication, not a setting.
- Remove the device table from `index.html` and replace it with a link to the settings
  page. That link works only when the browser is on the PC itself.

**Trade-off on the record.** Settings need someone at the PC, or an RDP or desktop
session to it. That is the intent: the same rule AnyDesk applies to its security
settings.

**Checks.**

- `daemon/test`: each new `/access` route returns 403 without the key, 403 from a
  non-loopback Host header, and works with both.
- `daemon/test`: a WS `device_revoke` now gets "unknown message type".
- `daemon/test`: revoking through `/access` still disconnects the device and rotates the
  token, which moves the existing revoke test to the new route.

### 2.3 Visible only in Task Manager

**Already true.** A per-user Run key starts `PocketDeskLauncher.exe --daemon`, which
spawns `PocketDesk.exe` (a renamed `node.exe`) with `CreateNoWindow`. There is no tray
icon, no window and no notification. Task Manager shows "PocketDesk" under processes,
and also under Startup apps, because that tab reads the Run key.

**Gaps.**

1. `install-service.ps1:127-134` puts `PocketDesk.lnk` on the Desktop as well as in the
   Start Menu. Keep the Start Menu shortcut, because it is how the user opens the settings
   page. Drop the Desktop one.
2. The console daemon (`PocketDeskConsole.cs:83`) runs `node.exe`, so Task Manager lists
   it as "Node.js JavaScript Runtime". Copy it as `PocketDeskConsole.exe` at install time,
   the same way the user daemon is copied as `PocketDesk.exe`.
3. Child processes that do not pass `windowsHide` (`wake.js`, `power_manager.js`,
   `gitpanel.js`, `chat.js`, `freebuff_control.js`, `desktop_video.js`) inherit the
   daemon's hidden console, so they should not flash a window. This needs one
   hardware check. Add `windowsHide: true` wherever a window does appear.

**Check.** After a fresh install and logon, the only trace is Task Manager (Processes and
Startup apps) and the Start Menu entry. There is no Desktop icon, no tray icon and no
window flash during a chat turn, a git action or a desktop stream.

---

## Part 3 — Not doing

- **WebRTC.** Node has no first-class WebRTC stack, so this would mean a native
  dependency or a sidecar. iroh already provides what WebRTC would add, which is NAT
  traversal, a relay fallback and loss-tolerant QUIC. The measured H.264-over-iroh path
  already meets the latency goal. Revisit only if a measurement on a real phone over
  mobile data shows it falling short, which `TRANSPORT-BENCH.md` lists as not yet
  measured.
- **E2EE shares.** The share feature no longer exists.
- **Phone-side device or TOTP management.** Moved to the PC on purpose (Part 2.2).
- **A CA-issued certificate or mkcert.** Pinning a self-signed certificate is equally
  strong for a paired phone.

## Part 4 — Order and status

1. wss only (2.1). This is the smallest change and closes the only cleartext path.
2. Settings to the browser (2.2). Daemon routes and tests first, then `pair.html`, then
   the removals from the phone and `index.html`.
3. Task Manager gaps (2.3). The installer change and the console exe name, then the
   hardware check.
4. On-device run of the foreground service, the biometric lock and QR pairing, so those
   items can be marked verified rather than compile-checked.

### Status (2026-10-12)

- 2.1 wss only: done. A plaintext daemon refuses non-loopback sockets
  (`test/plaintext-loopback.test.mjs`), the app refuses `ws://` (`PairingTest`), and the manifest
  no longer allows cleartext.
- 2.2 settings on the PC: done. `/access/devices*` and `/access/totp/*` back the Devices and
  Two-factor sections of the pair page. The socket handlers and the phone's two-factor section
  are gone. Power stays on the phone.
- 2.3 Task Manager only: done. The install creates a Start Menu shortcut only, the SYSTEM daemon
  runs as `PocketDeskConsoleDaemon.exe`, and the remaining Windows helpers pass `windowsHide`.
  The recording toggle, which had no UI since the tray was removed, is on the settings page.
- macOS and Linux: the daemon runs hidden (LaunchAgent, systemd user service) with the
  installing shell's PATH. A PocketDesk app (macOS) or app-menu entry (Linux) opens the settings
  page. The menu-bar tray is gone. macOS streams H.264 through ffmpeg avfoundation, and its
  monitor list, which read fields the helper never sent, is fixed. The install keeps the program
  in `~/.pocketdesk/app`. CI runs the daemon suite on macOS as well.
- Linux desktop viewing stays out of scope.
- Still needs real hardware: a phone run (foreground service, biometric lock, QR pairing), a
  Windows check that no helper flashes a window, and a Mac check of H.264 capture and
  Retina input mapping.
