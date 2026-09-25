/**
 * What the person at the PC sees of remote viewing: a small always-on-top bar naming
 * who is watching, with a Disconnect button, and an optional Allow / View only / Deny
 * prompt before a session starts. Windows-only; elsewhere every call is a no-op.
 */
import fs from "node:fs";
import path from "node:path";
import { PsHelper } from "./desktop_capture.js";
import { configDir } from "./config.js";

const IS_WIN = process.platform === "win32";

/** Present when the PC owner wants to approve each session; the tray menu toggles it. */
export const APPROVAL_FLAG = path.join(configDir, "ask-before-viewing");

// The window loop owns the main thread, so stdin is read on a worker thread and
// marshalled back with BeginInvoke.
const PRESENCE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public class RhBar : Form {
  [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr h, uint a);
  public Label Text1 = new Label();
  public Button Stop = new Button();
  public RhBar() {
    FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
    BackColor = Color.FromArgb(22, 27, 34); Padding = new Padding(10, 6, 6, 6); AutoSize = true; AutoSizeMode = AutoSizeMode.GrowAndShrink;
    var row = new FlowLayoutPanel { AutoSize = true, WrapContents = false, BackColor = BackColor };
    Text1.AutoSize = true; Text1.ForeColor = Color.White; Text1.Font = new Font("Segoe UI", 9.5f); Text1.Margin = new Padding(0, 6, 10, 0);
    Stop.Text = "Disconnect"; Stop.AutoSize = true; Stop.FlatStyle = FlatStyle.Flat; Stop.ForeColor = Color.White; Stop.BackColor = Color.FromArgb(218, 54, 51);
    row.Controls.Add(Text1); row.Controls.Add(Stop); Controls.Add(row);
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000088; return p; } }
  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    // Kept out of screen capture, so the bar never covers what the remote side sees.
    SetWindowDisplayAffinity(Handle, 0x11);
  }
  public void Place() {
    var wa = Screen.PrimaryScreen.WorkingArea;
    Location = new Point(wa.Left + (wa.Width - Width) / 2, wa.Top + 4);
  }
}

public static class RhPresence {
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  static Form owner; static RhBar bar;
  static readonly object outLock = new object();
  static readonly JavaScriptSerializer json = new JavaScriptSerializer();
  static void Out(object o) { lock (outLock) { Console.Out.WriteLine(json.Serialize(o)); Console.Out.Flush(); } }

  public static void Run() {
    Application.EnableVisualStyles();
    owner = new Form { ShowInTaskbar = false, Opacity = 0, FormBorderStyle = FormBorderStyle.None, Size = new Size(1, 1) };
    owner.Load += (s, e) => {
      owner.Hide();
      var t = new Thread(() => {
        string line;
        while ((line = Console.In.ReadLine()) != null) { var l = line; owner.BeginInvoke((Action)(() => Handle(l))); }
        owner.BeginInvoke((Action)(() => Application.Exit()));
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
    if (op == "ping") { Out(new Dictionary<string, object> { { "id", id }, { "ok", true } }); return; }
    if (op == "show") {
      if (bar == null) {
        bar = new RhBar();
        bar.Stop.Click += (s, e) => Out(new Dictionary<string, object> { { "event", "disconnect" } });
      }
      bar.Text1.Text = "\\u25CF  " + (string)cmd["text"];
      bar.Show(); bar.PerformLayout(); bar.Place();
      Out(new Dictionary<string, object> { { "id", id }, { "ok", true } });
      return;
    }
    if (op == "hide") {
      if (bar != null) bar.Hide();
      Out(new Dictionary<string, object> { { "id", id }, { "ok", true } });
      return;
    }
    if (op == "ask") { Ask(id, (string)cmd["text"], Convert.ToInt32(cmd["timeout"])); return; }
    Out(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", "unknown_op" } });
  }

  static void Ask(object id, string text, int timeout) {
    var f = new Form { Text = "PocketDesk", TopMost = true, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false,
      StartPosition = FormStartPosition.CenterScreen, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(14), ShowInTaskbar = true };
    var col = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false };
    var msg = new Label { Text = text, AutoSize = true, MaximumSize = new Size(420, 0), Font = new Font("Segoe UI", 10f), Margin = new Padding(0, 0, 0, 12) };
    var left = new Label { AutoSize = true, ForeColor = Color.Gray, Margin = new Padding(0, 0, 0, 10) };
    var row = new FlowLayoutPanel { AutoSize = true, WrapContents = false };
    string answer = null;
    Action<string> done = (a) => {
      if (answer != null) return;
      answer = a;
      Out(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "answer", a } });
      f.Close();
    };
    foreach (var pair in new[] { new[] { "Allow", "allow" }, new[] { "View only", "view" }, new[] { "Deny", "deny" } }) {
      var b = new Button { Text = pair[0], AutoSize = true, Margin = new Padding(0, 0, 8, 0) };
      var a = pair[1];
      b.Click += (s, e) => done(a);
      row.Controls.Add(b);
    }
    col.Controls.Add(msg); col.Controls.Add(left); col.Controls.Add(row); f.Controls.Add(col);
    int remaining = timeout;
    left.Text = "Denied automatically in " + remaining + " s";
    var timer = new System.Windows.Forms.Timer { Interval = 1000 };
    timer.Tick += (s, e) => { remaining--; left.Text = "Denied automatically in " + remaining + " s"; if (remaining <= 0) done("deny"); };
    f.FormClosed += (s, e) => { timer.Stop(); done("deny"); };
    timer.Start();
    // The helper is started hidden and Form.Show inherits that; SW_SHOW overrides it.
    f.Show(); ShowWindow(f.Handle, 5); f.Activate();
  }
}
'@
[RhPresence]::Run()
`;

export class DesktopPresence {
  constructor() {
    this.helper = new PsHelper("presence", PRESENCE_SCRIPT);
    this.helper.onEvent = (e) => { if (e.event === "disconnect") this.onDisconnect?.(); };
    this.shown = "";
  }

  get approvalRequired() {
    return fs.existsSync(APPROVAL_FLAG);
  }

  /** Resolves "allow", "view" or "deny"; no answer within timeoutSec denies. */
  async ask(text, timeoutSec = 30) {
    if (!IS_WIN) return "deny";
    await this.helper.ensure();
    const r = await this.helper.cmd({ op: "ask", text, timeout: timeoutSec }, (timeoutSec + 5) * 1000);
    return r?.ok ? r.answer : "deny";
  }

  /** viewers: [{ name, viewOnly }]; an empty list hides the bar. */
  async update(viewers) {
    if (!IS_WIN) return;
    const text = viewers.length
      ? viewers.map((v) => `${v.name} ${v.viewOnly ? "is viewing" : "is controlling"}`).join(" · ") + " this PC"
      : "";
    if (text === this.shown) return;
    this.shown = text;
    if (!text && !this.helper.proc) return;
    await this.helper.ensure();
    await this.helper.cmd(text ? { op: "show", text } : { op: "hide" }, 10000);
  }

  dispose() {
    this.helper.kill();
  }
}
