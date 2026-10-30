// SPDX-License-Identifier: GPL-3.0-or-later
// Shared mouse and keyboard, this PC's side: low-level hooks watch the pointer push past one edge of
// the screen; from then on every move, click, wheel and key is swallowed here and written to stdout
// for the daemon to send to the other computer, until it says the pointer came back (or Scroll Lock).
// Design after TwinDesk's windows-helper/src/Capture.cs (GPL-3.0). Built by the daemon with the
// C# compiler that ships with Windows, so C# 5 only.
//
// stdin, one per line:  side <left|right|top|bottom> | off | home <along 0-1> | ping
// stdout, JSON lines:   {"ev":"cross","along":f} {"ev":"m","dx":i,"dy":i} {"ev":"b","b":"left","d":1}
//                       {"ev":"w","v":i,"h":i} {"ev":"k","vk":i,"d":1} {"ev":"home"}
using System;
using System.Collections.Concurrent;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class PocketDeskKvm
{
    delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

    [StructLayout(LayoutKind.Sequential)] struct MouseLL { public int x, y; public uint data, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KeyLL { public uint vk, scan, flags, time; public IntPtr extra; }

    const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
    const uint INJECTED_MOUSE = 1, INJECTED_KEY = 0x10;
    const int PUSHES = 3, PUSH_MS = 350, DEADMAN_MS = 3000;

    static HookProc mouseProc = MouseHook, keyProc = KeyHook; // fields, so the GC keeps them
    static IntPtr mouseHook, keyHook;
    static readonly BlockingCollection<string> output = new BlockingCollection<string>();
    static SynchronizationContext ui;
    static volatile string side; // null: off
    static volatile bool away;
    static Point park;
    static int pushes;
    static DateTime pushAt, lastPing = DateTime.UtcNow, lastCross = DateTime.MinValue;

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        using (var form = new Form())
        {
            var h = form.Handle; // a window, so the context below posts to this thread's message loop
            ui = new WindowsFormsSynchronizationContext();
            SynchronizationContext.SetSynchronizationContext(ui);
            IntPtr mod = GetModuleHandle(null);
            mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, mod, 0);
            keyHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyProc, mod, 0);
            if (mouseHook == IntPtr.Zero || keyHook == IntPtr.Zero) { Console.Error.WriteLine("hooks refused"); return; }
            new Thread(Writer) { IsBackground = true }.Start();
            new Thread(Reader) { IsBackground = true }.Start();
            var timer = new System.Windows.Forms.Timer { Interval = 500 };
            // Nobody answering while away (daemon gone, link stuck) must never leave this PC without input.
            timer.Tick += delegate { if (away && (DateTime.UtcNow - lastPing).TotalMilliseconds > DEADMAN_MS) Home(0.5, true); };
            timer.Start();
            Application.Run();
            UnhookWindowsHookEx(mouseHook);
            UnhookWindowsHookEx(keyHook);
        }
    }

    static void Writer()
    {
        var stdout = Console.Out;
        foreach (var line in output.GetConsumingEnumerable()) { stdout.WriteLine(line); stdout.Flush(); }
    }

    static void Reader()
    {
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            var parts = line.Trim().Split(' ');
            lastPing = DateTime.UtcNow;
            switch (parts[0])
            {
                case "side": side = parts.Length > 1 ? parts[1] : null; break;
                case "off": side = null; ui.Post(delegate { if (away) Home(0.5, false); }, null); break;
                case "home":
                    double along;
                    if (!double.TryParse(parts.Length > 1 ? parts[1] : "0.5", System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out along)) along = 0.5;
                    ui.Post(delegate { if (away) Home(along, false); }, null);
                    break;
            }
        }
        ui.Post(delegate { if (away) Home(0.5, false); Application.ExitThread(); }, null);
    }

    static void Emit(string json) { output.Add(json); }

    /** Back on this PC at [along] of the crossing edge, a little inside it. */
    static void Home(double along, bool self)
    {
        away = false;
        lastCross = DateTime.UtcNow;
        Rectangle v = SystemInformation.VirtualScreen;
        along = Math.Max(0, Math.Min(1, along));
        int x = v.Left + (int)(along * (v.Width - 1)), y = v.Top + (int)(along * (v.Height - 1));
        switch (side)
        {
            case "left": SetCursorPos(v.Left + 40, y); break;
            case "top": SetCursorPos(x, v.Top + 40); break;
            case "bottom": SetCursorPos(x, v.Bottom - 41); break;
            default: SetCursorPos(v.Right - 41, y); break;
        }
        if (self) Emit("{\"ev\":\"home\"}");
    }

    static void Cross(double along)
    {
        away = true;
        lastPing = DateTime.UtcNow;
        lastCross = DateTime.UtcNow;
        Rectangle p = Screen.PrimaryScreen.Bounds;
        park = new Point(p.Left + p.Width / 2, p.Top + p.Height / 2);
        SetCursorPos(park.X, park.Y);
        Emit("{\"ev\":\"cross\",\"along\":" + along.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture) + "}");
    }

    static IntPtr MouseHook(int code, IntPtr w, IntPtr l)
    {
        if (code < 0) return CallNextHookEx(mouseHook, code, w, l);
        var m = (MouseLL)Marshal.PtrToStructure(l, typeof(MouseLL));
        if ((m.flags & INJECTED_MOUSE) != 0) return CallNextHookEx(mouseHook, code, w, l);
        int msg = w.ToInt32();
        if (away)
        {
            switch (msg)
            {
                case 0x200: Emit("{\"ev\":\"m\",\"dx\":" + (m.x - park.X) + ",\"dy\":" + (m.y - park.Y) + "}"); break;
                case 0x201: Emit("{\"ev\":\"b\",\"b\":\"left\",\"d\":1}"); break;
                case 0x202: Emit("{\"ev\":\"b\",\"b\":\"left\",\"d\":0}"); break;
                case 0x204: Emit("{\"ev\":\"b\",\"b\":\"right\",\"d\":1}"); break;
                case 0x205: Emit("{\"ev\":\"b\",\"b\":\"right\",\"d\":0}"); break;
                case 0x207: Emit("{\"ev\":\"b\",\"b\":\"middle\",\"d\":1}"); break;
                case 0x208: Emit("{\"ev\":\"b\",\"b\":\"middle\",\"d\":0}"); break;
                case 0x20A: Emit("{\"ev\":\"w\",\"v\":" + (short)(m.data >> 16) + ",\"h\":0}"); break;
                case 0x20E: Emit("{\"ev\":\"w\",\"v\":0,\"h\":" + (short)(m.data >> 16) + "}"); break;
            }
            return (IntPtr)1;
        }
        string s = side;
        // A push: the pointer already on the edge, still moving outward, no button held (not a drag).
        if (s != null && msg == 0x200 && (DateTime.UtcNow - lastCross).TotalMilliseconds > 400
            && GetAsyncKeyState(0x01) >= 0 && GetAsyncKeyState(0x02) >= 0)
        {
            Rectangle v = SystemInformation.VirtualScreen;
            bool edge = s == "right" ? m.x >= v.Right - 1 : s == "left" ? m.x <= v.Left : s == "top" ? m.y <= v.Top : m.y >= v.Bottom - 1;
            if (!edge) pushes = 0;
            else
            {
                var now = DateTime.UtcNow;
                pushes = (now - pushAt).TotalMilliseconds < PUSH_MS ? pushes + 1 : 1;
                pushAt = now;
                if (pushes >= PUSHES)
                {
                    pushes = 0;
                    double along = s == "left" || s == "right" ? (m.y - v.Top) / (double)Math.Max(1, v.Height - 1) : (m.x - v.Left) / (double)Math.Max(1, v.Width - 1);
                    ui.Post(delegate { Cross(along); }, null);
                }
            }
        }
        return CallNextHookEx(mouseHook, code, w, l);
    }

    static IntPtr KeyHook(int code, IntPtr w, IntPtr l)
    {
        if (code < 0 || !away) return CallNextHookEx(keyHook, code, w, l);
        var k = (KeyLL)Marshal.PtrToStructure(l, typeof(KeyLL));
        if ((k.flags & INJECTED_KEY) != 0) return CallNextHookEx(keyHook, code, w, l);
        int msg = w.ToInt32();
        bool down = msg == 0x100 || msg == 0x104;
        // Scroll Lock always brings the pointer home, and never goes over.
        if (k.vk == 0x91) { if (down) ui.Post(delegate { Home(0.5, true); }, null); return (IntPtr)1; }
        Emit("{\"ev\":\"k\",\"vk\":" + k.vk + ",\"d\":" + (down ? 1 : 0) + "}");
        return (IntPtr)1;
    }
}
