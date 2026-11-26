# PocketDesk: reference for proctoring and integrity vendors

PocketDesk is self-hosted remote control of the owner's own PC. The owner runs the daemon on that PC, pairs their own phone or browser with a token or QR code, then views the desktop and webcam and sends input. The connection is peer-to-peer and the project hosts no account and no directory of machines. This page lists what to look for, how to confirm it and how to remove it.

## Windows processes

| Name | What it is |
|---|---|
| `PocketDesk.exe` | The daemon: listener, desktop and webcam capture, input injection. Installed as a copy of `node.exe` (`daemon/scripts/install-service.ps1`), so Task Manager shows this name. |
| `PocketDeskLauncher.exe` | Launcher and tray in one executable. The logon task runs it with `--supervise`; it starts the daemon and shows the tray icon. No separate tray executable is built. |
| `PocketDeskConsole.exe` | Console-endpoint launcher. Installed only with `-Console`; it registers the SYSTEM task and starts node as `PocketDeskConsoleDaemon.exe`. |
| `PocketDeskConsoleDaemon.exe` | The node process behind the console endpoint on port 8766. Present only with `-Console`. |
| `powershell.exe` | Capture, input and clipboard helpers, generated into the helpers folder under `%USERPROFILE%\.pocketdesk`. PowerShell is also an ordinary system process; match the parent process and the helper path. |
| `ffmpeg.exe` | H.264 encoder for the desktop stream, normally in the ffmpeg folder under `%LOCALAPPDATA%\PocketDesk`. |

## Scheduled tasks (there is no Windows service)

PocketDesk installs no Windows service; autostart is scheduled tasks only.

| Task | Trigger and account | Notes |
|---|---|---|
| `PocketDesk` | At logon of the installing user. RunLevel Limited. | Default install. No restart policy, so a stop stays stopped. |
| `PocketDesk` (`-Protected`) | At logon of the installing user. RunLevel Highest. | Re-registers the same task name, not a second task. RestartCount 3, one minute apart, so a failed run is restarted. |
| `PocketDeskConsole` | At startup, as SYSTEM. RunLevel Highest. | Only with `-Console`. RestartCount 3, one minute apart. Runs `PocketDeskConsole.exe` on port 8766. |

## Registry, firewall and Event Log

| Artifact | Meaning |
|---|---|
| `HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PocketDesk` | Installed apps entry. Its `UninstallString` runs `uninstall.ps1`. |
| `HKCU:\Software\Microsoft\Windows\CurrentVersion\Run` value `PocketDesk` | Legacy autostart. The installer and the uninstaller both delete it; its presence means an old install or a manual entry. |
| `HKLM\SOFTWARE\PocketDesk\Policy` | Machine-owner policy. DWORDs `AllowRemoteControl`, `AllowWebcam`, `AllowPhoneControl`, `AllowClipboard`; `0` means off. An administrator sets these; no installer writes them and no shipped command sets them yet. |
| `C:\ProgramData\PocketDesk\policy.json` | The console endpoint's copy of the same policy. |
| `PocketDesk.ini` | Protected install only, next to the launcher under `$env:ProgramFiles\PocketDesk` in a folder named with the user's SID. Contains the daemon path. |
| `PocketDesk (daemon)` | Windows Firewall rule, protected install only. Inbound, any profile, program exactly the protected `PocketDesk.exe`. |
| Event Log source `PocketDesk` | Application log, ids 1000 start, 1001 stop, 1002 policy and 1003 refusal (`daemon/src/eventlog.js`). Only 1000 and 1001 have an emitter today, so 1002 and 1003 do not appear yet. |

## Install paths

| OS | Program | Autostart | Data |
|---|---|---|---|
| Windows | `%LOCALAPPDATA%\PocketDesk`: launcher, `PocketDesk.exe`, the `node` and `ffmpeg` folders, `app\daemon`, `uninstall.ps1`, and `pocketdesk.cmd` in a bin folder on PATH. Protected copy under `$env:ProgramFiles\PocketDesk`, one folder per user SID. | Scheduled tasks `PocketDesk` and, with `-Console`, `PocketDeskConsole`. | `%USERPROFILE%\.pocketdesk` |
| macOS | `~/.pocketdesk`, daemon in a daemon subfolder | LaunchAgent `com.pocketdesk.daemon.plist` in the `LaunchAgents` folder under the home folder, label `com.pocketdesk.daemon`. | `~/.pocketdesk` |
| Linux | `~/.pocketdesk`, daemon in a daemon subfolder | systemd user unit `pocketdesk.service` under `.config/systemd/user` in the home folder. | `~/.pocketdesk` |

## Default ports

| Port | Bind | Purpose |
|---|---|---|
| 8765 | LAN | Daemon, HTTPS and WSS. Configurable in `config.json` or `RH_PORT`. |
| 8775 | Loopback | Settings and pairing page. Always the daemon port plus 10. |
| 4679 | Loopback | CLI server for the pair, record and list commands. `RH_CLI_PORT` moves it. |
| 8766 | All interfaces (TLS) | Console endpoint, HTTPS. Only with `-Console`. |

## Data folder

State lives in `%USERPROFILE%\.pocketdesk` on Windows and `~/.pocketdesk` elsewhere; `RH_HOME` relocates it. The durable log is one file per UTC day in the `logs` folder, named daemon-YYYY-MM-DD.log: one JSON line per event, rotated at 5 MiB, five files kept, with tokens and the home path redacted (`daemon/src/logbook.js`). On Windows the scheduled task does not redirect stdout, so that file is the log. On macOS launchd also writes stdout to `daemon.log` in the data folder.

| Path | Contents |
|---|---|
| `config.json` | Port, token, TLS settings, iroh settings. |
| `tls\` | Self-signed certificate and private key. |
| `iroh.key` | iroh endpoint secret key. |
| `helpers\` | Generated PowerShell capture and input helpers. |
| `recordings\` | Session recordings. |
| `logs` | Daily JSON logs and rotations. |

## The capture marker

`%LOCALAPPDATA%\PocketDesk\allow-capture` is a JSON file, `{"app":"PocketDesk","at":"<ISO time>"}`. It is created when the first viewer attaches and deleted when the last one stops. It is per user, unauthenticated and forgeable, so its presence is positive evidence that a viewer is attached but its absence is not proof that none is. It exists only on Windows.

The rule from [ALPHA-CAPTURE.md](ALPHA-CAPTURE.md): in a proctoring, exam or DRM window, do not opt in to the handshake and keep `WDA_EXCLUDEFROMCAPTURE` set. The marker is not a permission signal for such a window.

## Verify

```powershell
pocketdesk --status
```
Expected: the `ports:` line with `8765 daemon, 8775 loopback page, 4679 cli` and a `data:` line with the folder. The same output also carries `elevated:`, `auto-start:`, `restart policy:` and `running:`. From a checkout, run `cd daemon` then `node src/cli.js --status` for the same lines.

```powershell
schtasks /query /TN "PocketDesk" /fo LIST
schtasks /query /TN "PocketDeskConsole" /fo LIST
```
Expected: `PocketDesk` resolves when the daemon is installed, `PocketDeskConsole` only with `-Console`; each prints `TaskName` and `Status` (add `/v` for the full record).

```powershell
Get-NetTCPConnection -State Listen -LocalPort 8765,8775,4679,8766
```
Expected: listening rows for 8765, 8775 and 4679, plus 8766 on a console install.

```powershell
Get-Process PocketDesk, PocketDeskLauncher, PocketDeskConsole -ErrorAction SilentlyContinue
```
Expected: one or more rows while the daemon or tray runs; no output when neither is running.

```powershell
Test-Path "$env:LOCALAPPDATA\PocketDesk\allow-capture"
```
Expected: `True` only while at least one viewer is attached.

```powershell
wevtutil qe Application "/q:*[System[Provider[@Name='PocketDesk']]]" /c:5 /rd:true /f:text
```
Expected: up to five newest entries, normally ids 1000 and 1001.

```powershell
reg query "HKLM\SOFTWARE\PocketDesk\Policy"
```
Expected: the four DWORD values, or `ERROR: The system was unable to find the specified registry key or value.` when no policy is set.

```powershell
Get-ChildItem "$env:USERPROFILE\.pocketdesk\logs"
```
Expected: one daemon-YYYY-MM-DD.log file per day and its `.1` to `.4` rotations.

```bash
launchctl list | grep com.pocketdesk
```
Expected: on macOS, a line with `com.pocketdesk.daemon` and a PID while it is loaded.

```bash
systemctl --user status pocketdesk
```
Expected: on Linux, `Active: active (running)` with the daemon path.

## Block
1. Stop and disable autostart.
```powershell
schtasks /End /TN "PocketDesk"
schtasks /Change /TN "PocketDesk" /DISABLE
```

As administrator, the console task:
```powershell
schtasks /End /TN "PocketDeskConsole"
schtasks /Change /TN "PocketDeskConsole" /DISABLE
```
A `-Protected` task is configured to restart a failed run up to three times, one minute apart, so disable it as well as ending it.

2. Kill what remains.
```powershell
taskkill /T /F /IM PocketDesk.exe
taskkill /T /F /IM PocketDeskLauncher.exe
taskkill /T /F /IM PocketDeskConsole.exe
```
`/T` also takes the PowerShell and ffmpeg children. Run the second and third when those processes exist. A `-Protected` daemon and the SYSTEM console need an elevated shell.

3. Remove the firewall rule, if a protected install created it.
```powershell
Remove-NetFirewallRule -DisplayName "PocketDesk (daemon)"
```

4. Uninstall; add `-RemoveData` to delete `%USERPROFILE%\.pocketdesk` as well. Run one line, not both.
```powershell
& "$env:LOCALAPPDATA\PocketDesk\uninstall.ps1"
& "$env:LOCALAPPDATA\PocketDesk\uninstall.ps1" -RemoveData
```

5. Disable the OS autostart.
```bash
launchctl unload ~/Library/LaunchAgents/com.pocketdesk.daemon.plist
```

```bash
systemctl --user disable --now pocketdesk
```

## Current limits

- There is no Windows service. A check that only enumerates services misses both autostart paths.
- Desktop capture, input injection and the tray are not exercised by CI; see [SUPPORT-MATRIX.md](SUPPORT-MATRIX.md). First-response steps are in [RUNBOOK.md](RUNBOOK.md).
- Policy keys are read by `daemon/src/policy.js` and a refusal path exists, but enforcement in front of every remote sense is not shipped yet (plan M6.1 open). A `0` alone is not a guarantee; block with step 1 or step 4.
- The Android app `com.yasha.pocketdesk` connects only to a PC it has already paired with.
- The project hosts no cloud account and no relay for its own traffic. iroh relays see encrypted packets only.

## Contact
Detection gaps and corrections: https://github.com/Yash-Awasthi/PocketDesk/issues. Vulnerabilities, privately: https://github.com/Yash-Awasthi/PocketDesk/security/advisories/new. [SECURITY.md](../SECURITY.md) is the disclosure policy. There is no security email address.
