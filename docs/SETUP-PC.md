# Setting up the PC

PocketDesk has two parts: the **daemon** on your PC and the **app** on your Android phone.
This page covers the PC. It takes one download (or one command) and one QR scan.

## Install (Windows 10/11)

Download **PocketDesk-Install.exe** from the
[latest release](https://github.com/Yash-Awasthi/PocketDesk/releases/latest) and double-click it.
No admin rights are needed. The file is not code-signed, so Windows SmartScreen may say it protected
your PC: choose **More info**, then **Run anyway**. A console window shows the progress.

The setup file only wraps `install.ps1`; you can run that directly from PowerShell instead:

```powershell
irm https://raw.githubusercontent.com/Yash-Awasthi/PocketDesk/master/install.ps1 | iex
```

When it finishes, the pairing page opens in your browser. In the app, tap **+** and scan the QR code.
That's all: the PC now starts PocketDesk at every logon, and the phone reaches it from any network.

What the installer does, with nothing installed beforehand:

1. Downloads the latest release of the daemon.
2. Uses Node.js 20 or newer and ffmpeg (for the fast H.264 desktop stream) if they are already on
   your PATH. Whatever is missing is downloaded as a private copy; nothing is added to your PATH and
   no other program is affected. Console access always uses a private Node.js.
3. Installs the daemon's dependencies.
4. Installs the tray icon, registers it to start at logon, and adds a **PocketDesk** shortcut to
   the Start Menu and the desktop.
5. Starts everything and opens the pairing page.

The first install downloads up to about 150 MB (much less when Node.js and ffmpeg are already there). Your browser may warn that the
pairing page's certificate is not trusted; that is expected, because the daemon makes its own
certificate. Choose **Advanced**, then **Continue to localhost**.

## Pair a phone

- **At home:** scan the QR from the pairing page (tray icon > **Pair a phone...**).
- **Later, from anywhere:** the same saved PC works on any network. The app uses your Wi-Fi when the
  phone is on the PC's network and connects over iroh (direct or through a relay) otherwise.
- **Another phone:** open the pairing page again and scan it with that phone.

## Console access: lock screen, UAC and before login

The everyday connection runs as you, so it cannot reach Windows' secure desktop:
User Account Control prompts, the lock screen, and the sign-in screen before
anyone logs in. Reaching those needs a process running as the system account in
the console session. Console access adds exactly that, as a **separate** phone
entry named "PC (console)", so ordinary use never gains those rights by accident.

Install it by re-running the installer elevated (right-click PowerShell > **Run
as administrator**), which adds one more step to the normal install:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Source . -Console
```

From an existing install you can add just this part:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PocketDesk\app\daemon\scripts\install-service.ps1" -Console
```

It registers a system scheduled task that starts at boot (so it is reachable
before login), then opens a second pairing page at `https://localhost:8766/pair?k=<token>`, where the token is the
one in `%ProgramData%\PocketDesk\console\config.json` (readable by administrators only).
Scan that QR to add the "PC (console)" entry. Use that entry when you need the
lock screen, a UAC prompt, or the machine before you have signed in; use the
normal entry for everything else.

The console pairing token works once: after a phone pairs, it is replaced and that phone
keeps its own token. To pair another phone, open the pairing page again (with the new token
from `config.json`). Every action taken through the console entry is written to
`%ProgramData%\PocketDesk\console\console-audit.log`, readable by administrators only.

What to understand before turning it on: the console entry runs with full system
rights, so anything done through it — including approving a UAC prompt — has
those rights. It has its own token that only administrators can read, on its own
port (8766), separate from the everyday connection. Keeping it separate is the
point: it means the everyday connection, and any program running as you, cannot
silently approve UAC on your behalf. Remove it any time (see Uninstall).

## Daily use: the tray icon

The **PocketDesk** shortcut in the Start Menu or on the desktop starts the tray if it is not
running. If it already runs, the shortcut opens the pairing page instead.

A dot in the notification area shows the daemon's state: **green** running, **grey** stopped.
Right-click it for:

| Menu item | What it does |
|---|---|
| Pair a phone... | Opens the QR page to pair a phone. |
| Open web UI | The browser dashboard: sessions, schedules, prompt queue, usage, devices. |
| Copy pairing info | Copies the address and token, for pairing by hand. |
| Open daemon log | The daemon's output, including how each phone connected (`direct` or `relayed`). |
| Ask before someone views this PC | Each desktop session, snapshot or input first shows Allow / View only / Deny on the PC; no answer in 30 s denies. |
| Record remote sessions | Records the screen while anyone watches (MP4) and every terminal session (asciicast). |
| Open recordings | The folder with recordings and `sessions.log`, which lists every viewer, approval and file sent. |
| Start / Stop daemon | Starts or stops the daemon without closing the tray. |
| Exit | Stops the daemon and closes the tray until the next logon. |

## Update

Run the setup file or the install command again. It replaces the program and keeps your settings, keys
and paired phones.

## Uninstall

Any of these:

- Double-click **PocketDesk-Uninstall.exe** from the [latest release](https://github.com/Yash-Awasthi/PocketDesk/releases/latest).
- **Settings > Apps > Installed apps**, find **PocketDesk**, then **Uninstall**.
- Right-click the tray icon, then **Uninstall PocketDesk**.
- From PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PocketDesk\uninstall.ps1"
```

Or run `uninstall.ps1` from a checkout. It stops every PocketDesk process (the daemon, which runs as `PocketDesk.exe`, and all its helpers),
then removes the autostart, the shortcuts and the program files.
Your settings and paired phones stay in `%USERPROFILE%\.pocketdesk`; add `-RemoveData` to delete them too.

If you installed console access, the uninstall asks for administrator rights once so it can also remove
the system task. The console pairing token in `%ProgramData%\PocketDesk` is kept unless you pass
`-RemoveData` (or run `install-service.ps1 -Console`'s counterpart, `uninstall-service.ps1 -Purge`).

## Where things live

| Path | Contents |
|---|---|
| `%LOCALAPPDATA%\PocketDesk` | The program: `app\daemon`, `node`, `ffmpeg`, the tray and `uninstall.ps1`. |
| `%USERPROFILE%\.pocketdesk\config.json` | Settings: port, token, TLS, iroh. |
| `%USERPROFILE%\.pocketdesk\iroh.key` | This PC's iroh identity. Keep it: paired phones find the PC by it. |
| `%USERPROFILE%\.pocketdesk\tls\` | The daemon's certificate. |
| `%USERPROFILE%\.pocketdesk\daemon.log` | Output of the last daemon start. |
| `%USERPROFILE%\.pocketdesk\recordings\` | Session recordings and `sessions.log`. |
| `%USERPROFILE%\Downloads\PocketDesk\` | Files sent from a phone or browser into a desktop session. |
| `%ProgramData%\PocketDesk\bin\` | Console endpoint's launcher, its own copy of Node and the daemon, run as the system account. Write-locked to administrators. Present only with console access. |
| `%ProgramData%\PocketDesk\console\` | Console endpoint's own config, token and iroh key (system-only; port 8766). Present only with console access. |

While anyone views the desktop, a bar at the top of the PC screen names them and has a
**Disconnect** button, and a red frame runs around every monitor. Both are kept out of the stream,
so they never cover what the phone sees.

With **Ask before someone views this PC** on, the Allow / View only / Deny buttons stay disabled for
the first 1.5 seconds, so a key you were already typing cannot answer the prompt.

## Two-factor pairing

On the phone: **Tools > Two-factor pairing > Set up**. Add the key to an authenticator app
(Google Authenticator, Aegis, 1Password and so on), enter the 6-digit code, and tap **Turn on**.
From then on, pairing a new device with the QR also asks for a current code. Phones that are already
paired keep working without one. Turning it off needs a code as well.

## Power

**Tools > PC power** on the phone, or the Desktop screen's ⋮ menu: lock, sign out, sleep, restart or
shut down. Restart and shut down wait 5 seconds. After a restart the phone reconnects once
PocketDesk runs again, which is after you sign in (or at boot with console access).

## Waking the PC

The phone remembers the PC's network adapters after each connection and shows **Wake** next to
it. Wake-on-LAN only works from the same network as the PC, and only if Windows lets the adapter
wake it: Device Manager > the network adapter > Power Management > "Allow this device to wake the
computer" and "Only allow a magic packet". A wired port usually also needs Wake-on-LAN enabled in
the BIOS. The browser's **Doctor** reports whether any adapter is allowed to wake the PC.

## Settings

Edit `%USERPROFILE%\.pocketdesk\config.json`, then **Stop** and **Start** the daemon from the tray.

| Setting | Default | Meaning |
|---|---|---|
| `port` | 8765 | Port for the LAN connection and the pairing page. |
| `token` | random | Master pairing token. Phones get their own token when they pair. |
| `tls.enabled` | true when a certificate could be made | Encrypts LAN connections. |
| `iroh.enabled` | true | Reach the PC from any network. |
| `iroh.relays` | `[]` (n0's public relays) | Your own relay URLs; see [RELAY.md](RELAY.md). |

## Troubleshooting

| Problem | What to check |
|---|---|
| The phone can't connect from outside | Open the daemon log: an `iroh <id>` line should appear at start. Connect once on the PC's Wi-Fi: the PC sends its iroh address and the phone's entry then shows "anywhere". On mobile data the Desktop status line shows `iroh relayed` or `direct`. |
| The desktop is slow or shows still frames | The Desktop header shows no fps figure when ffmpeg is missing and the daemon falls back to still frames. Run the install command again to restore it. |
| The desktop freezes on mobile data | The log shows `relayed` and `video link too slow` lines: the link is weak and quality drops automatically. A relay near you helps ([RELAY.md](RELAY.md)). |
| Windows asks whether Node.js may use the network | Allow it on private networks, so phones on the same Wi-Fi connect directly. |
| The tray icon is grey | Right-click it > **Start daemon**, then open the daemon log for the error. |
| Antivirus flags the desktop helper | The daemon sends mouse and keyboard input on your behalf; allow it in your antivirus. |

## Running from a checkout (development)

```powershell
git clone https://github.com/Yash-Awasthi/PocketDesk.git
cd PocketDesk
powershell -ExecutionPolicy Bypass -File install.ps1 -Source .
```

This installs the checkout's daemon instead of a release. To run the daemon directly instead, with
Node.js and ffmpeg on your PATH: `cd daemon; npm install; npm start`.

macOS and Linux: `curl -fsSL https://raw.githubusercontent.com/Yash-Awasthi/PocketDesk/master/install.sh | bash`,
then `npm start` in the daemon folder (no tray; H.264 desktop capture is Windows only).
