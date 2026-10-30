// SPDX-License-Identifier: GPL-3.0-or-later
// What this PC is playing (Windows' media sessions: Spotify, browsers, the Media Player), for the
// phone's Deck. A PowerShell helper prints the current session as one JSON line whenever asked.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
$M = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$P = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
$mgr = Await ($M::RequestAsync()) $M
while ($null -ne ([Console]::In.ReadLine())) {
  try {
    $s = $mgr.GetCurrentSession()
    if (-not $s) { '{}'; continue }
    $p = Await ($s.TryGetMediaPropertiesAsync()) $P
    $info = $s.GetPlaybackInfo()
    @{ title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle; app = $s.SourceAppUserModelId; playing = ($info.PlaybackStatus -eq 'Playing') } | ConvertTo-Json -Compress
  } catch { '{}' }
}
`;

export class PcMedia extends EventEmitter {
  constructor() {
    super();
    this.last = "";
    this.users = 0;
  }

  /** Polls while anyone watches; emits "change" with { title, artist, album, app, playing }. */
  watch(on) {
    this.users = Math.max(0, this.users + (on ? 1 : -1));
    if (this.users && !this.timer && process.platform === "win32") {
      this.proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      this.proc.stdin.on("error", () => {});
      let buf = "";
      this.proc.stdout.on("data", (d) => {
        buf += d;
        for (let i; (i = buf.indexOf("\n")) >= 0; ) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          // A session can read empty for a poll while it changes tracks; only a run of them means nothing plays.
          this.empty = line === "{}" ? (this.empty || 0) + 1 : 0;
          if (line === "{}" && this.empty < 3) continue;
          if (line && line !== this.last) {
            this.last = line;
            try { this.emit("change", JSON.parse(line)); } catch {}
          }
        }
      });
      this.proc.on("exit", () => { this.proc = null; });
      const ask = () => this.proc?.stdin.write("\n");
      ask();
      this.timer = setInterval(ask, 2000);
      this.timer.unref?.();
    } else if (!this.users && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      try { this.proc?.kill(); } catch {}
      this.last = "";
    }
  }
}
