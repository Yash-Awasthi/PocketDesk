// SPDX-License-Identifier: GPL-3.0-or-later
// Windows toasts from the daemon itself, so the phone's notifications and calls show on the PC
// without the browser page open. One long-lived PowerShell reads a toast per line from stdin.
import { spawn } from "node:child_process";

// PowerShell's own app id: toasts need a registered one, and it is always there.
const APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
const SCRIPT = `
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $m = $line | ConvertFrom-Json
    $esc = { param($s) [Security.SecurityElement]::Escape([string]$s) }
    $scenario = if ($m.call) { ' scenario="incomingCall"' } else { '' }
    $x = New-Object Windows.Data.Xml.Dom.XmlDocument
    $x.LoadXml("<toast$scenario><visual><binding template='ToastGeneric'><text>$(& $esc $m.title)</text><text>$(& $esc $m.body)</text><text placement='attribution'>$(& $esc $m.app)</text></binding></visual></toast>")
    $t = [Windows.UI.Notifications.ToastNotification]::new($x)
    if ($m.tag) { $t.Tag = ([string]$m.tag).Substring(0, [Math]::Min(64, ([string]$m.tag).Length)); $t.Group = 'pocketdesk' }
    $n.Show($t)
  } catch {}
}
`;

let proc = null;
// What we showed lately, so this PC's notification forwarding never sends the phone its own back.
const shown = new Map();
export const ours = (title, body) => { const at = shown.get(`${title}${body}`); return !!at && Date.now() - at < 120_000; };

function shell() {
  if (proc) return proc;
  proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  proc.stdin.on("error", () => {});
  proc.on("exit", () => { proc = null; });
  return proc;
}

/** Shows a toast on this PC (Windows only); [tag] replaces an earlier toast with the same tag. */
export function toast({ title, body = "", app = "Phone", tag, call = false }) {
  if (process.platform !== "win32" || !title) return;
  shown.set(`${String(title).slice(0, 200)}${String(body).slice(0, 500)}`, Date.now());
  if (shown.size > 100) shown.delete(shown.keys().next().value);
  shell().stdin.write(JSON.stringify({ title: String(title).slice(0, 200), body: String(body).slice(0, 500), app: String(app).slice(0, 60), tag, call }) + "\n");
}
