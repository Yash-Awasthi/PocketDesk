# Step 6 — Verification

## Automatable — DONE

- Daemon suite: `cd daemon; npm.cmd test` → all 22 files pass.
- `daemon/test/desktop.test.mjs`: proves the helper scripts gain
  `FollowInput` (2 calls) only under `RH_CONSOLE`, and carry none without it.
- `daemon/test/tools-ui.test.mjs`: `doctor` reports `console_endpoint`, `ok`
  when the task is absent (Windows only).
- `app` `PairingTest`: a pair payload's `n` becomes the entry name
  (`.\gradlew.bat testDebugUnitTest` → BUILD SUCCESSFUL).
- Launcher compiles: `csc /target:exe /r:System.dll PocketDeskConsole.cs`
  (exit 0).
- `install.ps1`, `install-service.ps1`, `uninstall-service.ps1`: 0 parse errors.

## Manual — needs one elevated run on real hardware (cannot be done in-session)

1. `powershell -ExecutionPolicy Bypass -File daemon\scripts\install-service.ps1 -Console`
   elevated → task `PocketDeskConsole` registers, 8766 up
   (`https://localhost:8766/health`, `doctor` shows `console_endpoint` reachable).
2. Scan the "PC (console)" QR from `https://localhost:8766/pair` on the PC → a
   second entry appears in the app.
3. Open "PC (console)" on the phone; run any installer to raise a UAC prompt →
   the phone shows the dimmed secure desktop and can click **Yes**.
4. Lock the PC (Win+L) → the phone shows the lock screen and can type the
   password to unlock.
5. Reboot; before logging in → the phone reaches the logon screen through the
   console entry (proves before-login + iroh from the SYSTEM key).
6. On the **user** entry (8765), the same UAC prompt is invisible/uncontrollable
   → proves UAC stays intact for the user account; only the console token
   crosses it.
7. Elevated `uninstall-service.ps1` → task + 8766 process gone, token kept;
   `-Purge` also removes the token.

Known unknowns to watch on the first real run:
- AMSI may re-evaluate the capture/input helpers now that they carry
  `SetThreadDesktop`/`OpenInputDesktop`. If flagged, the bisect note in
  `desktop_capture.js` applies — the P/Invoke is desktop-switching, common in
  legit code, but confirm on the target.
- `CreateProcessAsUser` needs `SeAssignPrimaryTokenPrivilege` +
  `SeIncreaseQuotaPrivilege`; SYSTEM has both, but a locked-down machine policy
  could strip them — check `err` in the launcher's exception if the child never
  starts.

Record results in the commit body / CONTEXT.md, then delete this file.
