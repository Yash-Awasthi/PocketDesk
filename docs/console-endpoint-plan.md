# Console (secure-desktop) endpoint — implementation plan

Living document. Each task carries a checkbox; delete a task's block once it is
done and verified, so this file always shows only the work that remains. When
every block is gone, delete the file.

## Why this exists

The everyday daemon runs as the interactive user. Windows isolates the *secure
desktop* — UAC elevation prompts, the lock screen, and the pre-login logon
screen all live on the `Winlogon` desktop — behind User Interface Privilege
Isolation. A user-token process, even an elevated one, cannot draw from it or
inject input into it. Only a process running as `SYSTEM` in the active console
session may `OpenInputDesktop` / `SetThreadDesktop` onto `Winlogon` and act
there.

This is authorized remote administration of the owner's own PC (the AnyDesk-style
north star in `CONTEXT.md`). The design keeps UAC a real boundary for the user
account: the console power lives behind a **separate** endpoint with its own
admin-only token and its own pairing, never reachable from the user daemon or
from code running as the user.

## Architecture at a glance

- A second copy of the existing daemon runs as `SYSTEM` **in the active console
  session** (not session 0), on its own port (8766), with its own
  config/token/TLS/iroh key under `%ProgramData%\PocketDesk\console`,
  ACL'd to Administrators + SYSTEM only.
- A small C# launcher exe (`PocketDeskConsole.exe`), started by a
  `SYSTEM` scheduled task at boot, keeps that daemon alive in whichever session
  currently owns the console, relaunching it across logon / lock / fast-user-
  switch transitions.
- The daemon's capture and input PowerShell helpers, only under `RH_CONSOLE=1`,
  call `SetThreadDesktop(OpenInputDesktop(...))` before each op, so they follow
  the desktop that currently has input (default ↔ secure).
- Pairing reuses the existing loopback `/pair` page, served on 8766, labelled
  "PC (console)" via a new `n` field in the pair payload. The phone stores it as
  a second server entry; everything else on the phone already handles multiple
  entries, iroh fallback, and pinned fingerprints.

Security note kept on the record: because the console endpoint is the *full*
daemon as `SYSTEM` (the scope the owner chose for maximum reuse), anything
launched through it — agents, terminals, file browse, SSH — runs as `SYSTEM`.
It is gated only by its own admin-only token and separate pairing.

## Status of code already written (verify, do not rewrite)

These edits are in the working tree and unit-checked; the tasks below build on
them. Re-confirm them if the suite is red.

- `daemon/src/config.js` — under `RH_CONSOLE` on Windows, tightens the config
  dir ACL to `*S-1-5-32-544` (Administrators) and `*S-1-5-18` (SYSTEM) with
  `icacls ... /inheritance:r`, and refuses to start without TLS (its token opens
  a SYSTEM daemon, so plaintext is never acceptable).
- `daemon/src/server.js` — `buildPairPage` now emits `n: process.env.RH_LABEL`
  in the pair payload.
- `daemon/src/desktop_capture.js` — `IS_CONSOLE`-gated `DESK_MEMBERS`
  (`OpenInputDesktop`/`SetThreadDesktop`/`CloseDesktop` + `FollowInput`, one
  handle kept open at a time) injected into the `RHI` and `RHD` classes, and a
  `FollowInput()` call before the input op-chain and before `capture`. Verified:
  the three helper scripts are byte-identical to `HEAD` when `RH_CONSOLE` is
  unset; capture + cursor still work under `RH_CONSOLE=1`.
- `app/.../Pairing.kt` — pair payload's `n` becomes the entry name (host is the
  fallback).

---

## Task 1 — Console launcher exe `daemon/scripts/console/PocketDeskConsole.cs`

**Goal.** A plain Win32 console exe (no SCM service plumbing) that, run as
`SYSTEM`, keeps one console daemon alive in the interactive session and moves it
across session transitions.

**Compile.** With the same `csc.exe` the tray uses
(`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`), target
`/target:exe`, references `System.dll` only (no WinForms/Drawing needed).

**Layout it assumes** (same as the tray, `PocketDeskTray.cs`): a private
`node\node.exe` and `ffmpeg\ffmpeg.exe` sit next to the exe in the install dir;
the daemon lives at `<installDir>\app\daemon` (see `install.ps1` step 1). Read
the daemon dir from `PocketDeskConsole.ini` next to the exe, exactly like the
tray reads `PocketDeskTray.ini`, falling back to `<ExeDir>\app\daemon`.

**Main loop (single-threaded, no service callbacks):**

1. Resolve paths: `exeDir`, `daemonDir`, `node` (`exeDir\node\node.exe` if
   present else `"node"`), `ffmpeg` (`exeDir\ffmpeg\ffmpeg.exe` if present).
2. Loop forever with a ~2 s poll:
   - `uint sess = WTSGetActiveConsoleSessionId();` — `0xFFFFFFFF` means no
     console attached (RDP disconnected console): kill any child, wait, retry.
   - If a child is running and its session id still equals `sess` and it has not
     exited, sleep and continue.
   - Otherwise (no child / session changed / child exited): kill the old child
     if any, then **launch a new one in `sess`**.
3. Launch as SYSTEM into the target session:
   - `WTSQueryUserToken(sess, out hUserToken)` gets the interactive user's token
     **only after login**; at the logon screen it fails. So do not use it for
     identity — we want to stay SYSTEM. Instead:
     - `OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE|TOKEN_QUERY|TOKEN_ASSIGN_PRIMARY|TOKEN_ADJUST_DEFAULT|TOKEN_ADJUST_SESSIONID, out hSelf)`
     - `DuplicateTokenEx(hSelf, MAXIMUM_ALLOWED, ref sa, SecurityIdentification, TokenPrimary, out hDup)`
     - `SetTokenInformation(hDup, TokenSessionId, ref sess, sizeof(uint))` — moves
       the SYSTEM token into the console session (needs `SeTcbPrivilege`, which
       SYSTEM has).
   - Build the environment block with `CreateEnvironmentBlock(hDup)` and append
     our vars (see below). Pass `CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW |
     CREATE_NEW_CONSOLE`.
   - `STARTUPINFO.lpDesktop = "winsta0\\default"` so the child starts on the
     interactive window station (its helper threads switch to the secure desktop
     themselves via `FollowInput`).
   - `CreateProcessAsUser(hDup, node, "\"node\" src\\index.js", ..., daemonDir,
     ref si, out pi)`. Keep `pi.hProcess` as the child handle; close `hDup`,
     `hSelf`, the env block.
4. Child env vars to set: `RH_CONSOLE=1`,
   `RH_HOME=%ProgramData%\PocketDesk\console`, `RH_PORT=8766`,
   `RH_LABEL=PC (console)`, `NODE_ENV=production`,
   `FFMPEG_PATH=<exeDir>\ffmpeg\ffmpeg.exe` when present. (`RH_HOME` relocates all
   state via `config.js`; `RH_LABEL` names the pair entry.)
5. On its own exit (task stopped), kill the child.

**P/Invoke needed** (`user32`/`kernel32`/`advapi32`/`wtsapi32`/`userenv`):
`WTSGetActiveConsoleSessionId`, `OpenProcessToken`, `DuplicateTokenEx`,
`SetTokenInformation`, `CreateEnvironmentBlock`, `DestroyEnvironmentBlock`,
`CreateProcessAsUser`, `CloseHandle`, plus the `STARTUPINFO`,
`PROCESS_INFORMATION`, `SECURITY_ATTRIBUTES` structs and the
`TOKEN_INFORMATION_CLASS.TokenSessionId = 12` constant.

**Gotchas to honor in the code:**
- `CreateProcessAsUser` needs the process to hold `SeAssignPrimaryTokenPrivilege`
  and `SeIncreaseQuotaPrivilege`; SYSTEM has both.
- Redirecting the child's stdio across `CreateProcessAsUser` is fragile; instead
  let the child log itself. Add `RH_LOG=%ProgramData%\PocketDesk\console\daemon.log`
  only if we also teach the daemon to honor it — otherwise skip logging in v1 and
  rely on `doctor`.
- When `WTSGetActiveConsoleSessionId()` returns `0xFFFFFFFF` (no console), do not
  spawn; the logon screen still reports a valid session, so this only happens for
  a headless/RDP-detached console.

**Done when:** the file compiles with `csc.exe` cleanly (checked in Task 4's
install step). Runtime behavior is manual (Task 6).

---

## Task 2 — Scheduled task registration in `daemon/scripts/install-service.ps1`

Add a `-Console` switch. Keep the existing tray path untouched; `-Console` is a
separate, admin-only branch.

**Steps in the `-Console` branch:**

1. **Require elevation.** `([Security.Principal.WindowsPrincipal]
   [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
   [Security.Principal.WindowsBuiltinRole]::Administrator)` — throw a clear error
   if false (the caller, `install.ps1`, will relaunch elevated).
2. **Compile the launcher.** Reuse the `$csc` path already defined in this file;
   `& $csc /nologo /target:exe /out:$consoleExe /r:System.dll $consoleSrc`
   where `$consoleSrc = Join-Path $PSScriptRoot "console\PocketDeskConsole.cs"`
   and `$consoleExe = Join-Path $InstallDir "PocketDeskConsole.exe"`.
   Rebuild only when the source is newer, mirroring the tray's `$needBuild`.
3. **Write `PocketDeskConsole.ini`** next to the exe = the daemon dir (same
   `Set-Content` the tray path uses for its ini).
4. **Create the SYSTEM config dir** `$consoleHome =
   Join-Path $env:ProgramData "PocketDesk\console"`,
   `New-Item -ItemType Directory -Force`, then lock it down:
   `icacls $consoleHome /inheritance:r /grant "*S-1-5-32-544:(OI)(CI)F" /grant "*S-1-5-18:(OI)(CI)F"`
   (the daemon re-applies this on start too, but set it before the token file
   can appear).
5. **Register the task** (stop/replace any prior one first):
   ```
   $action  = New-ScheduledTaskAction -Execute $consoleExe
   $trigger = New-ScheduledTaskTrigger -AtStartup
   $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
   $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
   Register-ScheduledTask -TaskName "PocketDeskConsole" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
   ```
   Then `Start-ScheduledTask -TaskName "PocketDeskConsole"` unless `-NoStart`.
   (If `ScheduledTasks` cmdlets are ever unavailable, the `schtasks.exe /create
   /RU SYSTEM /RL HIGHEST /SC ONSTART` equivalent is the fallback — but prefer
   the cmdlets.)
6. **Open the pair page** (unless `-NoStart`): poll up to 60 s for
   `$consoleHome\config.json` and port 8766 listening (copy the wait loop from
   `install.ps1` step 6), then `Start-Process "https://localhost:8766/pair"`.
   Print the token path for manual pairing if the browser cannot open.

**Done when:** running the branch elevated on the real PC registers the task,
the daemon comes up on 8766, and `/pair` shows a "PC (console)" QR. (Manual,
Task 6.)

---

## Task 3 — Teardown in `daemon/scripts/uninstall-service.ps1`

Extend the existing script (it already removes the tray Run key and an old
scheduled task). Add:

- `Stop-ScheduledTask -TaskName "PocketDeskConsole" -ErrorAction SilentlyContinue`
- `Unregister-ScheduledTask -TaskName "PocketDeskConsole" -Confirm:$false -ErrorAction SilentlyContinue`
- Kill a stray `PocketDeskConsole.exe` and any console daemon it spawned
  (match node processes whose command line contains the console `RH_HOME`).
- Leave `%ProgramData%\PocketDesk\console` **in place by default** (holds the
  paired token — deleting it silently unpairs the phone). Only remove it when a
  new `-Purge` switch is passed. Document that in the script header.

**Done when:** the task and processes are gone after an elevated run; the token
survives unless `-Purge`.

---

## Task 4 — `install.ps1` wiring (root installer)

The root `install.ps1` runs unelevated today. Add an **optional** console step so
a user can opt in:

- After the tray install (step 5), if the caller passed `-Console`, relaunch just
  the console branch elevated:
  `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-ExecutionPolicy','Bypass','-File',"$daemon\scripts\install-service.ps1",'-Console','-DaemonDir',$daemon,'-InstallDir',$InstallDir`.
- Do **not** make console the default: most users only need the user daemon.
  Mention the flag in the closing help text.

**Done when:** `irm ... | iex` still works with no console; `install.ps1 -Source .
-Console` triggers one UAC prompt and sets the console endpoint up.

---

## Task 5 — `doctor` check in `daemon/src/doctor.js`

Add one check, styled like the existing `wake_on_lan` block:

- Query the task: `schtasks /query /TN PocketDeskConsole /fo LIST` via the
  existing `tryExec`. `ok` when it exists and its state is not "Disabled".
- If present, also probe the port: a loopback `https` GET of
  `https://127.0.0.1:8766/health` (accept the self-signed cert:
  `rejectUnauthorized:false`) with a 2 s timeout; report reachable / not.
- `name: "console_endpoint"`, detail naming the state and port, hint pointing at
  `install-service.ps1 -Console` when absent. Skip the check entirely off
  Windows.

**Done when:** `doctor` returns the new check; a unit test drives it with the
task absent (the common case on CI) and asserts shape, not truth.

---

## Task 6 — Verification

**Automatable now (do before commit):**

- `cd daemon; npm.cmd test` stays green. Add/keep:
  - a test that `buildPairPage`/pair payload carries `n` when `RH_LABEL` is set
    and omits it otherwise (extend an existing pairing/protocol test rather than
    a new file if one fits);
  - the byte-identity check already run manually — fold it into
    `daemon/test/desktop.test.mjs` (import `DesktopController` twice, once with
    `RH_CONSOLE` set via a child `process.env` shim, assert identical without it
    and containing `FollowInput` with it). Note: `IS_CONSOLE` is read at module
    load, so drive it with a subprocess (`node -e`) that sets the env, capturing
    a boolean, not by mutating `process.env` after import.
- `cd app; .\gradlew.bat testDebugUnitTest` — add a `PairingTest.kt` case: a
  payload with `n` yields an entry named by it; without `n`, the host.

**Manual (needs one elevated run on real hardware — cannot be done in-session):**

1. `powershell -ExecutionPolicy Bypass -File daemon\scripts\install-service.ps1 -Console`
   elevated. Confirm the task registers and 8766 comes up (`doctor`,
   `https://localhost:8766/health`).
2. Scan the "PC (console)" QR from `/pair` on the PC; a second entry appears in
   the app.
3. From the phone, open "PC (console)"; trigger a UAC prompt on the PC (run any
   installer). Confirm the phone shows the dimmed secure desktop and can click
   "Yes".
4. Lock the PC (Win+L); confirm the phone shows the lock screen and can type the
   password to unlock.
5. Reboot; before logging in, confirm the phone reaches the logon screen through
   the console entry (proves before-login + iroh from the SYSTEM key).
6. Confirm the **user** daemon (8765) still cannot approve UAC — the prompt is
   invisible/uncontrollable there — proving UAC stays intact for the user
   account and only the console token crosses it.
7. Uninstall: elevated `uninstall-service.ps1`; confirm the task and processes
   are gone and the paired token survives (re-open the app entry works) unless
   `-Purge`.

---

## Task 7 — Docs and context

- `docs/SETUP-PC.md`: a "Console access (lock screen / UAC / before login)"
  section — what it is, the one-line elevated install, the second phone entry,
  and the security trade-off in plain terms.
- `CONTEXT.md`: add the console endpoint to the state section (new module, ports
  8765 user / 8766 console, the `RH_CONSOLE`/`RH_LABEL`/`RH_HOME` envs, the
  scheduled-task launcher) so the next session inherits it.

**Done when:** both read correctly and match the shipped behavior.
