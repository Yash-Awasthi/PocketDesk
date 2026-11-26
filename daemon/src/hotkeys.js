// SPDX-License-Identifier: GPL-3.0-or-later
// Ctrl+Alt+C and Ctrl+Alt+V anywhere on this Windows PC. C copies the files selected in the File
// Explorer window in front (else the files on the clipboard) to the phone; V pastes the files the
// phone sent with "Copy to PC" into the app in front. Idea from TwinDesk (GPL-3.0).
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PDHK {
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] public static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
Add-Type -AssemblyName System.Windows.Forms
# MOD_CONTROL | MOD_ALT | MOD_NOREPEAT
$ok1 = [PDHK]::RegisterHotKey([IntPtr]::Zero, 1, 0x4003, 0x43)
$ok2 = [PDHK]::RegisterHotKey([IntPtr]::Zero, 2, 0x4003, 0x56)
[Console]::Out.WriteLine((@{ ready = $true; copy = $ok1; paste = $ok2 } | ConvertTo-Json -Compress))
$shell = New-Object -ComObject Shell.Application
$m = New-Object PDHK+MSG
while ([PDHK]::GetMessage([ref]$m, [IntPtr]::Zero, 0, 0) -gt 0) {
  if ($m.message -ne 0x0312) { continue }
  if ($m.wParam.ToInt32() -eq 2) { [Console]::Out.WriteLine('{"op":"paste"}'); continue }
  $files = @()
  try {
    $fg = [PDHK]::GetForegroundWindow().ToInt64()
    foreach ($w in $shell.Windows()) {
      if ($w.HWND -eq $fg) { $files = @($w.Document.SelectedItems() | ForEach-Object { $_.Path }); if ($files.Count) { break } }
    }
  } catch {}
  if (-not $files.Count) { try { $files = @([System.Windows.Forms.Clipboard]::GetFileDropList()) } catch {} }
  [Console]::Out.WriteLine((@{ op = 'copy'; files = @($files) } | ConvertTo-Json -Compress))
}
`;

export class Hotkeys extends EventEmitter {
  get supported() {
    return process.platform === "win32";
  }

  start() {
    if (!this.supported || this.proc) return;
    // Hotkey messages go to the thread that registered them, so the helper keeps one STA thread.
    const enc = Buffer.from(SCRIPT, "utf16le").toString("base64");
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", enc], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = p;
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.ready) {
          this.status = { copy: !!m.copy, paste: !!m.paste };
          this.emit("ready", this.status);
        } else if (m.op === "copy")
          this.emit(
            "copy",
            (Array.isArray(m.files) ? m.files : [m.files]).filter((f) => typeof f === "string" && f),
          );
        else if (m.op === "paste") this.emit("paste");
      }
    });
    p.on("exit", () => {
      if (this.proc === p) this.proc = null;
    });
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
  }
}
