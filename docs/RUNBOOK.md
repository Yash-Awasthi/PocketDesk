# Runbook

The first commands below assume you are in the daemon checkout, so run `cd daemon` first. On an installed PC the program is in `%LOCALAPPDATA%\PocketDesk\app\daemon`, and the log is `%USERPROFILE%\.pocketdesk\daemon.log` (docs/SETUP-PC.md, "Where things live").

## Daemon will not start

Symptom: nothing answers on the CLI port and the daemon is not in Task Manager.

First command:

```powershell
node src/index.js --status
```

On this machine that prints:

```
elevated: yes — ordinary programs cannot stop the daemon
auto-start: yes — scheduled task 'PocketDesk' (HighestAvailable)
restart policy: 3 restarts, 1 min apart
ports: 8765 daemon, 8775 loopback page, 4679 cli
data: C:\Users\Yash\.pocketdesk
running: no
```

`running: no` means no daemon process; `auto-start` says whether the scheduled task is installed; `ports` gives the three ports to probe. Next, run `schtasks /query /TN "PocketDesk" /fo LIST` (verified `Status: Ready`) and `Get-Content "$env:USERPROFILE\.pocketdesk\daemon.log" -Tail 40`. This machine has no log file, so that command exits with `Cannot find path 'C:\Users\Yash\.pocketdesk\daemon.log' because it does not exist.` A missing log means the daemon has not written a start since install. See [SETUP-PC.md](SETUP-PC.md#troubleshooting).

## Phone cannot pair

Symptom: the app cannot scan or reach the pairing page.

First command:

```powershell
node src/index.js pair
```

With the daemon down that prints `pocketdesk: PocketDesk is not running on this PC (no answer on port 4679)`. The CLI could not reach the daemon loopback port, so pairing has nothing to talk to; fix the daemon first (section 1). Once the daemon runs, the same command draws the pairing QR/link (daemon/src/cli.js:156-170). Next, at daemon start the log should carry an `iroh <id>` line (daemon/src/server.js:942); open the log and connect once on the PC's Wi-Fi. See [SETUP-PC.md](SETUP-PC.md#pair-a-phone) and [SETUP-PC.md](SETUP-PC.md#troubleshooting).

## Stream black

Symptom: the phone shows a black desktop or still frames.

First command:

```powershell
Get-Content "$env:USERPROFILE\.pocketdesk\daemon.log" -Tail 200 | Select-String "no frames|falling back|iroh"
```

On this machine that exits with `Cannot find path 'C:\Users\Yash\.pocketdesk\daemon.log' because it does not exist.` If the log is missing, no daemon start has written one yet, so start the daemon first. Once it exists, three strings matter, all from daemon/src/server.js: `[pocketdesk] no frames for 6s while watching; restarting the encoder` (line 674), `[pocketdesk] that screen cannot be grabbed here; falling back to all screens` (line 601), and `  video     link too slow, preset -> <preset>` (line 756). An encoder restart, one display falling back, or a weak link. Next, run `Get-Command ffmpeg` (verified: `C:\Users\Yash\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.1-full_build\bin\ffmpeg.exe`); when ffmpeg is missing the Desktop header shows no fps figure and the daemon falls back to still frames (docs/SETUP-PC.md:243). See [SETUP-PC.md](SETUP-PC.md#troubleshooting) and [EXCLUSIVE-FULLSCREEN.md](EXCLUSIVE-FULLSCREEN.md).

## PTY dead

Symptom: a terminal session opens but no shell answers.

First command:

```powershell
node --input-type=module -e "import('node-pty').then(m=>console.log('spawn:',typeof m.spawn))"
```

That prints `spawn: function`. node-pty loads and exports `spawn`; anything else (a rejection or not `function`) means the native module did not build and no terminal can start. Next, run `node src/index.js list` to see whether the session still exists, and reinstall dependencies if the import failed. See [SETUP-PC.md](SETUP-PC.md#running-from-a-checkout-development).

## Task missing

Symptom: a desktop session or terminal that was on the phone is gone.

First command:

```powershell
node src/index.js list
```

With the daemon down that prints `pocketdesk: PocketDesk is not running on this PC (no answer on port 4679)`. That line means the daemon itself is down (section 1). When the daemon runs, `list` prints the sessions it still holds; a terminal that is absent is no longer held by the daemon, because it is a live process and not a saved record. Next, confirm with `node src/index.js --status`, then read the log tail. See [SETUP-PC.md](SETUP-PC.md#troubleshooting).

## Policy refused

Symptom: a remote sense is refused with a policy reason.

First command:

```powershell
reg query "HKLM\SOFTWARE\PocketDesk\Policy" /v AllowRemoteControl
```

That prints `ERROR: The system was unable to find the specified registry key or value.` This build has no machine-owner policy store, so that refusal cannot occur yet (plan item M6.1 is open; the spec is docs/INTEGRITY.md around line 216). When it lands, the same query is the first check, and a refusal writes a line in daemon.log naming the key and Application event 1003 (docs/SETUP-PC.md "Windows Event Log"). See [INTEGRITY.md](INTEGRITY.md) and [SETUP-PC.md](SETUP-PC.md#windows-event-log).

## Relay down

Symptom: the phone cannot reach the PC from outside its network.

First command:

```powershell
Get-Content "$env:USERPROFILE\.pocketdesk\daemon.log" -Tail 40
```

On this machine that exits with `Cannot find path 'C:\Users\Yash\.pocketdesk\daemon.log' because it does not exist.` A missing log means the daemon has not started; start it and read the startup block. The iroh lines are in daemon/src/server.js: `  iroh      <endpoint id>` (line 942) on success, `  iroh      unavailable (optional @number0/iroh not installed)` (line 938), `  iroh      failed to start: <msg>` (line 943), and per connection `  iroh      <8 chars> relayed|direct, rtt N ms` (line 931). These tell you whether iroh started at all, and whether a phone is relayed or direct. Next, check `iroh.enabled` and `iroh.relays` in `%USERPROFILE%\.pocketdesk\config.json` (docs/RELAY.md). See [RELAY.md](RELAY.md) and [SETUP-PC.md](SETUP-PC.md#troubleshooting).
