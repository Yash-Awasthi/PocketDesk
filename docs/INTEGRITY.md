# PocketDesk and proctored assessments

Status: **plan, nothing implemented yet.** Written 2026-11-23 after a capability
audit of this tree and a read of HackerRank's and Unstop's published integrity
documentation. The goal of this document is the opposite of a bypass guide: it
lists what PocketDesk could be used for in an exam, why the current defaults
make that easy, and what we change so that it is neither easy nor deniable.

## 1. The honest answer first

**Yes — in a browser test the page cannot see PocketDesk at all, and in the
native clients the one check they rely on ("close all other applications") can
be defeated by how PocketDesk installs itself.** Not because of one feature, but
because three properties stack:

1. **No tray, no icon, no notice - hidden by design.** As audited, the daemon was installed as a
   *hidden* process: no tray, no window, an elevated Scheduled Task at logon, a protected copy
   under `Program Files`, auto-restart on crash. The W0 work changed the default to an unelevated
   per-user task with no restart policy, and the owner then ruled the tray out entirely: no tray
   icon, no window and no logon notice, with the local settings page as the only entry point.
   What still announces it: the `PocketDesk.exe` process in Task Manager, `pocketdesk --status`
   (elevated, auto-start, restart policy, ports, data folder) and start/stop/policy events in the
   Windows Event Log. Elevation is the explicit `-Protected` option and says so in `--status`.
2. **Remote input that the page cannot distinguish from typing.** Input goes in
   through `SendInput` (Windows), `CGEvent` (macOS) and `uinput` (Linux) from
   `daemon/src/desktop_capture.js`. An elevated daemon can drive elevated
   windows too (elevation is detected and used). Browser-level integrity checks
   (paste tracking, copy-block, tab focus) never see a paste event, because
   there is no clipboard involved — a helper simply types.
3. **Substitutable senses.** A helper can see the exam (screen stream), supply
   text (clipboard, file drop, typed buffer), be seen instead of the candidate
   (`PocketDesk Webcam`, `native/vcam` + `daemon/src/webcam.js`, which presents
   the phone camera as an ordinary Windows camera to any browser), and reach the
   machine from anywhere (`iroh` relay, wake-on-LAN). On Android, the PC can
   drive a phone running a mobile assessment over wireless debugging
   (`daemon/src/phone_adb/*`) with nothing on the phone but the debugging icon.

There is also one design decision that has to be called out plainly, because it
is the difference between "dual-use remote desktop" and "built to hide":
`docs/EXCLUSIVE-FULLSCREEN.md` states that PocketDesk "must stay invisible to
anti-cheat and antivirus (its capture helpers are already written to avoid the
RAT heuristics AMSI flags)", and `desktop_capture.js` splits the capture and
input helpers specifically so AMSI's remote-access-Trojan heuristic does not
fire. That is anti-malware/EDR evasion, and proctoring's native desktop clients
lean on the same layer. It should not stay.

The rest of this document is the audit and the plan to remove the easy paths
while keeping the product's actual job. Section 3b is the important one: the
native clients (HackerRank Desktop App, Unstop SmartHire) are the only layer
that can catch this, and one install decision currently makes PocketDesk
uncloseable by them.

## 2. Capability audit (this tree)

| Capability | Where | Exam relevance | Detection today |
|---|---|---|---|
| Hidden, elevated, auto-restarting daemon | `install-service.ps1`, `install.ps1` | Persists unnoticed through the whole test | Only by process/task/registry enumeration |
| Remote screen view (all monitors, up to 60 fps) | `desktop_capture.js`, `server.js`, `desktop_video.js` | A helper reads the questions | Nothing on the exam side; not visible in shot |
| Remote pointer + keyboard injection | `desktop_capture.js` (`SendInput`/`CGEvent`/`uinput`) | A helper answers; no paste event | OS-level injected-input flags only (`LLKHF_INJECTED`); page sees keystrokes |
| Elevated input into elevated windows | `isElevated()`, `RunLevel Highest` task | Drives an elevated proctoring client | Same as above |
| SYSTEM secure-desktop endpoint (opt-in `-Console`) | `install-service.ps1 -Console`, `desktop_capture.js` `RH_CONSOLE`, `docs/console-endpoint-plan.md` | Acts on UAC/lock screen, beyond what the candidate sees | Nothing user-level can see it |
| Virtual webcam from the phone | `daemon/src/webcam.js`, `native/vcam`, `native/vcam-host` | Different person / different room on camera; defeats face match and multi-face checks | Looks like a normal camera, like OBS Virtual Camera |
| Clipboard both ways + `clippy` Ctrl+C capture | `daemon/src/clippy.js`, `daemon/clippy/clippy.cs`, phone sync | Materials in/out without the browser's clipboard | OS-level clipboard access; browser paste events |
| File bridge, phone-as-drive (WebDAV), shelf | `fs_ops.js`, `phone_dav.js` | Deliver answers or take the question away | Nothing on the exam side |
| PC drives a phone over adb | `daemon/src/phone_adb/*` | Mobile assessments run on the phone; helper drives it | Android's debugging icon only |
| Phone-to-phone control | `app/.../PhoneShare.kt` | Same, with no PC at all | Red Stop pill (already good) |
| Shared mouse/keyboard across PCs (KVM) | `daemon/scripts/PocketDeskKvm.cs`, `kvm_*` | The exam PC runs nothing that talks to the network for input | Nothing on the exam PC |
| Relay reach (iroh) + wake + power | `iroh_link.js`, `wake.js`, `power_manager.js` | Helper is never on the same network; PC is on only during the test | Nothing |
| Screen recorder | `daemon/src/recorder.js` | Record the paper for a helper afterwards | Nothing |
| Capture-exclusion handshake | `docs/ALPHA-CAPTURE.md`, `setCaptureAllowed()` | Removes `WDA_EXCLUDEFROMCAPTURE` for apps that opt in | The daemon genuinely cannot override a window that stays opted out — keep this |

One nuance, to avoid overclaiming: `clippy` ignoring keys synthesised by another
program (`clippy.cs` checks the injected flag) is a *capture-fidelity* feature —
its buffer only holds what the local user typed. The bypass is remote input
itself, not clippy.

## 3. What the platforms actually check

HackerRank publishes four integrity levels (`support.hackerrank.com`):

| Mode | What it enforces | PocketDesk exposure today |
|---|---|---|
| Standard | Tab proctoring, copy/paste tracking, code-replay | Remote typing is invisible to paste tracking; nothing lists processes |
| Secure Mode | Fullscreen, copy/paste blocked, single monitor, tab-switch alerts | Helper drives fullscreen; no capture of the helper's own screen on the candidate side |
| Proctor Mode (AI add-on) | Whole-screen share, webcam snapshots (~15 s, ~5 s around violations), AI flags remote-desktop apps, face/object anomalies | Screen share shows the exam, not the helper — but the hidden daemon never appears in a screenshot; the virtual camera defeats face checks |
| Desktop App Mode | Native client: blocks remote access, blocks other apps, refuses VMs, blocks screen sharing, OS-level monitoring | The elevated hidden daemon and its injected input are exactly what an OS-level monitor is built to find; this is the mode that actually stops it — if it enumerates |

Unstop's published proctoring (`unstop.com/employers/ai-proctoring-agent`,
`unstop.com/blog/unstop-ai-proctoring`): OTP, Aadhaar-based face registration
and live re-verification, multi-face and voice detection, fullscreen and
tab-switch enforcement, continuous screen recording, IP/geo tracking, device
checks, human review of flags. It is a **browser-based** stack, so every check
except the camera is page-level; the camera is the strongest control, and it is
the one the virtual webcam would answer.

The pattern is consistent: **browser-level integrity cannot see a local process;
native desktop clients can.** A tool that is deliberately invisible to native
clients is therefore a proctoring bypass by construction.

## 3b. The native clients: HackerRank Desktop App and Unstop SmartHire

HackerRank's desktop app is a native Windows/macOS client installed **without
administrator rights**, and the integrity controls it advertises are all
*local-machine* checks: close blocked applications, block remote access, block
screen sharing/screenshots, force full screen, allow only one non-mirrored
display, refuse VMs. Its own candidate docs say to grant webcam and screen
permissions, to close every other application (`Force Close All Apps`), and —
importantly — the group-assessment guidance says to **uninstall or disable any
virtual camera software**. Unstop is different: its assessment engine
(SmartHire) is a web app with three proctoring tiers (Basic: full screen + tab
switch; Standard: + face/geo; Advanced: + Aadhaar face verification, screen
capture, 360° room scan, device and multiple-user detection), and it
**blocks virtual-camera drivers**. There is no documented Unstop secure-browser
installer.

What that means for this tree, check by check:

| Native check | Can it see PocketDesk? | Current outcome |
|---|---|---|
| Process / task enumeration | Yes — `PocketDesk.exe`, Scheduled Task `PocketDesk`, `HKCU\...\Uninstall\PocketDesk` | **Seen, but not closeable** (see below) |
| "Close all other applications" / Force Close All Apps | The app runs **unelevated**; PocketDesk runs **as administrator** from `Program Files\PocketDesk\<SID>` | **Bypassed.** An unelevated kill cannot end it; the task's `RestartCount 3` brings it back in a minute. This is the single sharpest gap. |
| Remote-access detection (RDP / AnyDesk / TeamViewer signatures) | No — PocketDesk is not an RDP session, and its process/ports match no published blocklist | **Bypassed** by name-based checks; catchable only by behavioural/allowlist monitoring |
| Injected input (low-level hooks) | Yes, in principle — `SendInput` marks events `LLKHF_INJECTED` (PocketDesk does not hide it, and must not) | **Catchable** by a native client with a hook, today |
| Screen capture / screen sharing block | Partly — PocketDesk captures with DXGI/GDI from another process; only `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` stops that | **Bypassed** unless the client marks its window uncapturable (it should) |
| One display / no mirroring | Yes — every additional monitor is captured, and the alpha-capture marker invites apps to opt out of capture protection | **Bypassed** today; a mirroring check can flag it |
| Virtual camera | Yes — `native/vcam` registers a real Windows 11 virtual camera | **Blocked** by Unstop SmartHire and by HackerRank's guidance. This feature is now a liability, not an asset |
| VM refusal | n/a | — |
| Local listener / firewall scan | Yes — 8765 (and 8766 with `-Console`), plus the `PocketDesk (daemon)` firewall rule | **Catchable** by a port/rule scan |

Two conclusions follow, and they set the plan:

1. **There is no out-of-band path.** Every PocketDesk input and capture route
   needs the daemon running on the exam machine — KVM included (the other PC
   still posts into this machine's daemon). So the native client's job is
   exactly to find and close the daemon, and PocketDesk should not fight it.
   A true hardware KVM or USB HID emulator would beat any software check, but
   PocketDesk ships none and should not.
2. **The elevation/auto-restart design is the bypass.** It is also the first
   thing to change, because it defeats the one control that reliably works.
   The normal install path is the one that does this: `install.ps1` always
   re-runs `install-service.ps1 -Protect` under UAC and registers the task with
   `-RunLevel Highest`; the script even notes that "an elevated daemon ignores
   an unelevated taskkill".

The honest limit remains: a determined candidate with admin rights can stop a
scheduled task, and a client cannot prove the absence of every possible helper.
But making PocketDesk stop when asked moves it from "defeats the control" to
"is covered by the control".

## 4. Principles for the fix

- **P1 — Visible by default, never stealthy.** Anything PocketDesk does to a
  machine must be enumerable by that machine: a process you can see, a Start
  Menu entry, a log, an uninstaller entry, a documented signature.
- **P1b — Closeable, and it stays closed.** No elevation on the default install
  (elevation becomes an explicit advanced option for controlling elevated
  windows), and no silent restart after the user or another program closes it.
- **P2 — Enforceable by the machine owner, not by the candidate.** A mode the
  candidate can switch off is security theatre. A policy an administrator sets
  (lab, invigilator, employer, parent) is real.
  Corollary: **do not** build "if HackerRank is open, disable myself". It is
  whack-a-mole, it produces false positives, and it looks like evasion
  engineering.
- **P3 — Provable to a third party.** Remote senses that can stand in for the
  candidate must be visibly marked (watermark, on-device banner), and the
  presence of PocketDesk must be documented for proctoring vendors to detect and
  block.
- **P4 — No evasion work, ever.** No anti-detection, no hooking, no kernel
  driver, no hiding from enumeration, no AMSI/EDR workarounds. Record this as a
  contribution rule.
- **P5 — Say it out loud.** Terms and a README section: not for proctored
  assessments, not for driving someone else's exam session.
- **P6 — Accept the limit.** Nothing PocketDesk ships can stop a determined
  cheater who controls both endpoints and can edit the binary (GPL). The goal is
  to remove the *deniable, effortless, generic* path, and to give institutions a
  real lever.

## 5. Work plan

### Phase 0 — Policy (docs only, this pass)
- README "Responsible use" section: not for exams, not for another person's
  machine or session.
- This document, linked from README and CONTEXT.
- `CONTRIBUTING.md` rule: no feature whose purpose is to avoid detection, no
  anti-forensics, no driver/hooking, no enumeration hiding.

### Phase 1 — Be closeable (the actual fix for the native clients)
1. **Default install runs unelevated** (`RunLevel Limited`, per-user token, no
   `Program Files` admin copy). Keep an explicit `--elevate`/`-Protected`
   install for people who need to drive elevated windows, with a clear warning
   that it makes PocketDesk uncloseable by ordinary apps.
2. **No silent restart.** If the daemon is stopped or killed, the task does not
   bring it back inside the session; the next start is a user action and
   `pocketdesk --status` says so. `RestartCount 3` is removed from the default task.
3. **Stop means stop.** A `pocketdesk stop` (the same request the installer sends to the
   loopback CLI port) ends the
4. Add a self-check the machine owner can run before an exam:
   `pocketdesk --status` reports elevated? restarting? auto-start? policy?

### Phase 1b — Visibility (small, high value)
1. No tray, no icon and no logon notice (owner ruling, 2026-11-26): the daemon starts at logon
   in the background and the local settings page is the only entry point. `install-service.ps1`
   and `install.ps1` stop calling the install "hidden"; `README` and `CONTEXT.md` name the
   named process, the settings page and the task.
2. `pocketdesk --status` prints the running daemon, task name, ports, and the
   data folder.
3. Write start/stop/policy events to the Windows Event Log (source
   `PocketDesk`), so a native integrity client can see them without guessing.
4. Rewrite the `EXCLUSIVE-FULLSCREEN.md` line and the `desktop_capture.js`
   header comment: keep the two helpers for *reliability* (a long-running
   capture process next to a long-running input process), drop the AMSI framing.
5. Accept the consequence: some antivirus products will now flag the daemon.
   That is correct behaviour for a remote-control tool, and it is the point.

### Phase 2 — Admin kill switch (the only control that actually works)
Machine policy, checked before any remote sense starts:

```
HKLM\SOFTWARE\PocketDesk\Policy
  AllowRemoteControl = 0   ; desktop_start, remote_input, kvm edge crossing
  AllowWebcam        = 0   ; PocketDesk Webcam
  AllowPhoneControl  = 0   ; adb_* drive-a-phone
  AllowClipboard     = 0   ; clipboard sync, file paste, shelf
```
plus `C:\ProgramData\PocketDesk\policy.json` for parity with the console
endpoint (which reads `%ProgramData%`). Behaviour: the daemon refuses the
feature, replies with a visible `disabled_by_policy` reason, and logs it. A
`pocketdesk policy` CLI lets the machine owner (admin) set and inspect it.
Ship a documented recipe for a lab/invigilator: set the policy before the exam,
verify with `pocketdesk --status`, leave the machine to the candidate.

Self-enforced "exam mode" stays out of scope for P2.

### Phase 3 — Marked remote senses
- **Virtual webcam**: off by default, and burn
  `PocketDesk Webcam — <phone name>` plus a UTC clock into every frame (an
  `ffmpeg drawtext` in the decode path, before the frames reach `vcam-host`),
  plus a line in the settings page and `pocketdesk --status` while it runs. Unstop SmartHire
  blocks virtual cameras and
  HackerRank tells candidates to uninstall virtual-camera software, so this
  feature cannot be an impersonation path; it should read as an ordinary
  virtual camera that proctoring is free to refuse.
- **Phone control over adb**: a persistent, non-dismissible "Controlled from
  <PC name>" notification on the phone while a remote input session is attached
  (the phone-to-phone path already shows a red Stop pill; mirror that).
- **Console endpoint**: decide between (a) drop from public builds, (b) keep it
  admin-only with its own policy key, an audit log line per input event, and a
  loud docs warning. Today it is `-Console` at install time with no visible
  state; that is not defensible for a public release.

### Phase 4 — Publication
- `docs/for-proctoring-vendors.md`: process names (`PocketDesk`,
  `PocketDeskConsole`), Scheduled Task name, service keys, install path,
  `PocketDesk.ini`, data folder, the `allow-capture` marker, ports (8765/8766
  and the console port), how to verify, and a contact. Tell them to block it.
- In `ALPHA-CAPTURE.md`: an explicit "do not use this handshake in proctoring,
  exam or DRM windows" warning.

### Phase 5 — Verification (acceptance)
1. With `AllowRemoteControl=0`, `desktop_start` and `remote_input` fail with a
   visible reason and the log shows the policy name; with `1` they work.
2. The daemon appears in Task Manager, in `Get-ScheduledTask`, in `pocketdesk --status`, and in
   Add/Remove Programs.
3. A Zoom/Meet test against the virtual camera shows the watermark.
4. `--status` lists task, ports and policy; uninstall leaves nothing behind.
5. No code path in the tree contains an anti-detection workaround (review
   checklist item, grep-able list in `CONTRIBUTING.md`).
6. **Native-client simulation**: a small unelevated checker in `daemon/test`
   enumerates processes, reads the scheduled task, and terminates every
   PocketDesk process and helper (as a lockdown client's Force Close All Apps
   would). After Phase 1 it succeeds: nothing of PocketDesk is left running,
   nothing comes back on its own, and the next start needs a user action. The
   same checker run against the current build must fail — that is the proof the
   gap was real.
7. With elevation opted in, `--status` says `elevated: yes` and the docs say
   plainly that a lockdown client cannot close it.

## 6. Decisions needed before Phase 1

1. **Unelevated default install** (elevation becomes opt-in) — yes? This is the
   one that decides whether a native proctoring client can close PocketDesk.
2. **No silent auto-restart** — yes?
3. Tray icon and logon notice - removed by owner ruling 2026-11-26: no tray, no icon, no notice,
   settings page only.
4. Console (SYSTEM / secure-desktop) endpoint — drop from public builds, or keep
   admin-only?
5. Virtual webcam — default off + watermark, or watermark only?
6. Kill-switch scope — remote control only, or all four keys?
7. Publish the vendor detection doc — yes/no.
8. Remove the "invisible to anti-cheat and antivirus" claim and AMSI framing —
   yes? (recommended: yes, unfiltered)

## 7. Non-goals

- No proctoring-app detection (fragile, false-positive prone, and it is the
  wrong shape for a control the candidate must not hold).
- No promise of exam integrity. PocketDesk cannot verify who is at the keyboard.
  Policy + a visible, blockable tool is the achievable bar.
