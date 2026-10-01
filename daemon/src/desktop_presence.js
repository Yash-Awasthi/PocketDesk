/**
 * Privacy mode: blanks the PC's monitors and swallows its local keyboard and mouse while a
 * remote viewer works, so the person at the PC does not fight the remote pointer. Three quick
 * Esc presses at the PC end it. Windows-only; elsewhere every call is a no-op.
 */
import { PsHelper } from "./desktop_capture.js";

const IS_WIN = process.platform === "win32";

// The window loop owns the main thread, so stdin is read on a worker thread and
// marshalled back with BeginInvoke.
// Blanks the PC's own monitors and ignores its own keyboard and mouse while a remote
// viewer works. The cover is kept out of capture and the hooks pass injected input, so
// the viewer's picture and control are unaffected. Three quick Esc presses at the PC end it.
const PRIVACY_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public class RhCover : Form {
  [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr h, uint a);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
  public RhCover(Rectangle b) {
    FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; BackColor = Color.Black;
    StartPosition = FormStartPosition.Manual; Bounds = b;
    var l = new Label { Text = "This PC is in use remotely. Press Esc three times to take back control.", ForeColor = Color.FromArgb(110, 110, 110), AutoSize = true, Font = new Font("Segoe UI", 13f) };
    Controls.Add(l);
    l.Location = new Point((b.Width - l.PreferredWidth) / 2, (b.Height - l.PreferredHeight) / 2);
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  // Topmost, click-through, tool window, layered, never activated.
  protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x080800A8; return p; } }
  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    SetLayeredWindowAttributes(Handle, 0, 255, 2);
    SetWindowDisplayAffinity(Handle, 0x11);
  }
}

public static class RhPrivacy {
  delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc p, IntPtr mod, uint tid);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int c, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);
  static Form owner;
  static List<RhCover> covers = new List<RhCover>();
  static HookProc kbProc = Kb, msProc = Ms;
  static IntPtr kbHook = IntPtr.Zero, msHook = IntPtr.Zero;
  static List<int> escapes = new List<int>();
  static System.Windows.Forms.Timer raise;
  static readonly object outLock = new object();
  static readonly JavaScriptSerializer json = new JavaScriptSerializer();
  static void Out(object o) { lock (outLock) { Console.Out.WriteLine(json.Serialize(o)); Console.Out.Flush(); } }

  // KBDLLHOOKSTRUCT.flags at 8 (LLKHF_INJECTED 0x10); MSLLHOOKSTRUCT.flags at 12 (LLMHF_INJECTED 0x1).
  static IntPtr Kb(int c, IntPtr w, IntPtr l) {
    if (c >= 0 && (Marshal.ReadInt32(l, 8) & 0x10) == 0) {
      if (Marshal.ReadInt32(l) == 0x1B && (int)w == 0x100) {
        int now = Environment.TickCount;
        escapes.Add(now);
        escapes.RemoveAll(t => now - t > 2000);
        if (escapes.Count >= 3) { owner.BeginInvoke((Action)(() => { Off(); Out(new Dictionary<string, object> { { "event", "released" } }); })); }
      }
      return (IntPtr)1;
    }
    return CallNextHookEx(kbHook, c, w, l);
  }
  static IntPtr Ms(int c, IntPtr w, IntPtr l) {
    if (c >= 0 && (Marshal.ReadInt32(l, 12) & 1) == 0) return (IntPtr)1;
    return CallNextHookEx(msHook, c, w, l);
  }

  static void On() {
    if (covers.Count > 0) return;
    foreach (var s in Screen.AllScreens) { var f = new RhCover(s.Bounds); f.Show(); covers.Add(f); }
    var mod = GetModuleHandle(null);
    kbHook = SetWindowsHookEx(13, kbProc, mod, 0);
    msHook = SetWindowsHookEx(14, msProc, mod, 0);
    escapes.Clear();
    // Another topmost window can rise above the cover; put it back on top.
    raise = new System.Windows.Forms.Timer { Interval = 1000 };
    raise.Tick += (s, e) => { foreach (var f in covers) { f.TopMost = false; f.TopMost = true; } };
    raise.Start();
  }

  static void Off() {
    if (raise != null) { raise.Stop(); raise = null; }
    if (kbHook != IntPtr.Zero) { UnhookWindowsHookEx(kbHook); kbHook = IntPtr.Zero; }
    if (msHook != IntPtr.Zero) { UnhookWindowsHookEx(msHook); msHook = IntPtr.Zero; }
    foreach (var f in covers) f.Close();
    covers.Clear();
  }

  public static void Run() {
    Application.EnableVisualStyles();
    owner = new Form { ShowInTaskbar = false, Opacity = 0, FormBorderStyle = FormBorderStyle.None, Size = new Size(1, 1) };
    owner.Load += (s, e) => {
      owner.Hide();
      var t = new Thread(() => {
        string line;
        while ((line = Console.In.ReadLine()) != null) { var ln = line; owner.BeginInvoke((Action)(() => Handle(ln))); }
        owner.BeginInvoke((Action)(() => { Off(); Application.Exit(); }));
      });
      t.IsBackground = true; t.Start();
    };
    Application.Run(owner);
  }

  static void Handle(string line) {
    Dictionary<string, object> cmd;
    try { cmd = json.Deserialize<Dictionary<string, object>>(line); } catch { return; }
    object id = cmd.ContainsKey("id") ? cmd["id"] : null;
    string op = cmd.ContainsKey("op") ? (string)cmd["op"] : "";
    if (op == "on") On(); else if (op == "off") Off();
    else if (op != "ping") { Out(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", "unknown_op" } }); return; }
    Out(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "on", covers.Count > 0 }, { "hooked", kbHook != IntPtr.Zero && msHook != IntPtr.Zero } });
  }
}
'@
[RhPrivacy]::Run()
`;

export class DesktopPresence {
  constructor() {
    this.privacyHelper = new PsHelper("privacy", PRIVACY_SCRIPT);
    this.privacyHelper.onEvent = (e) => {
      if (e.event !== "released") return;
      this.privacyOn = false;
      this.onPrivacyChange?.(false);
    };
    this.privacyOn = false;
  }

  /** Blank the PC's monitors and ignore its local input; resolves { ok, on, error? }. */
  async setPrivacy(on) {
    if (!IS_WIN) return { ok: false, on: false, error: "privacy mode needs Windows" };
    if (!on && !this.privacyHelper.proc) return { ok: true, on: false };
    await this.privacyHelper.ensure();
    const r = await this.privacyHelper.cmd({ op: on ? "on" : "off" }, 10000);
    if (r.ok && on && !r.hooked) {
      await this.privacyHelper.cmd({ op: "off" }, 10000);
      return { ok: false, on: false, error: "could not take over the PC's keyboard and mouse" };
    }
    this.privacyOn = Boolean(r.ok && r.on);
    this.onPrivacyChange?.(this.privacyOn);
    return { ok: Boolean(r.ok), on: this.privacyOn, ...(r.ok ? {} : { error: r.error }) };
  }

  dispose() {
    this.privacyHelper.kill();
  }
}
