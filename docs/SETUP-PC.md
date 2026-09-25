# Setting up the PC

PocketDesk has two parts: the **daemon** on your PC and the **app** on your Android phone.
This page covers the PC. It takes one command and one QR scan.

## Install (Windows 10/11)

Open PowerShell (no admin needed) and run:

```powershell
irm https://raw.githubusercontent.com/Yash-Awasthi/PocketDesk/master/install.ps1 | iex
```

When it finishes, the pairing page opens in your browser. In the app, tap **+** and scan the QR code.
That's all: the PC now starts PocketDesk at every logon, and the phone reaches it from any network.

What the installer does, with nothing installed beforehand:

1. Downloads the latest release of the daemon.
2. Downloads a private copy of Node.js and of ffmpeg (for the fast H.264 desktop stream).
   Nothing is added to your PATH and no other program is affected.
3. Installs the daemon's dependencies.
4. Installs the tray icon and registers it to start at logon.
5. Starts everything and opens the pairing page.

The first install downloads about 150 MB and takes a few minutes. Your browser may warn that the
pairing page's certificate is not trusted; that is expected, because the daemon makes its own
certificate. Choose **Advanced**, then **Continue to localhost**.

## Pair a phone

- **At home:** scan the QR from the pairing page (tray icon > **Pair a phone...**).
- **Later, from anywhere:** the same saved PC works on any network. The app uses your Wi-Fi when the
  phone is on the PC's network and connects over iroh (direct or through a relay) otherwise.
- **Another phone:** open the pairing page again and scan it with that phone.

## Daily use: the tray icon

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

Run the install command again. It replaces the program and keeps your settings, keys and paired phones.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PocketDesk\uninstall.ps1"
```

Or run `uninstall.ps1` from a checkout. It removes the tray, the autostart and the program files.
Your settings and paired phones stay in `%USERPROFILE%\.pocketdesk`; add `-RemoveData` to delete them too.

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

While anyone views the desktop, a bar at the top of the PC screen names them and has a
**Disconnect** button. The bar is kept out of the stream, so it never covers what they see.

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
| The phone can't connect from outside | Open the daemon log: an `iroh <id>` line should appear at start. Check that the phone's entry shows "anywhere" (pair again if not). |
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
