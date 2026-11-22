// clippy - minimalistic keystroke recorder (native Windows, no runtime).
//
// A low-level keyboard hook rebuilds what is typed, with backspace, Enter and Tab applied.
// Ctrl+C writes clippy_capture.json (overwritten: the latest snapshot with the foreground
// window, the system clipboard and the typed buffer) and appends one line to
// clippy_history.json (a session log: every capture is added, never dropped or rewritten).
// That recovers text from apps whose Ctrl+C never reaches the Windows clipboard, such as a game
// with its own clipboard. No paste is captured.
//
// Visible, named process and Scheduled Task, not hidden.
//
//   clippy                  run the recorder (what the task launches)
//   clippy --dir <folder>   store capture/history there (default: %LOCALAPPDATA%\PocketDesk\clippy,
//                           or the absolute path in clippy_dir.txt beside the exe)
//   clippy --install        register the on-demand elevated task "Clippy" (one UAC prompt)
//   clippy --uninstall      remove the task
//   clippy --capture        write one snapshot now (same as pressing Ctrl+C)
//   clippy --start | --stop | --open | --history | --clear
// Keys while recording: Ctrl+Shift+Q stop, Ctrl+Shift+X clear the buffer, Ctrl+C capture.
using System;
using System.Text;
using System.IO;
using System.Threading;
using System.Diagnostics;
using System.Reflection;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Windows.Forms;

class Clippy
{
    const int WH_KEYBOARD_LL = 13, WM_KEYDOWN = 0x0100, WM_SYSKEYDOWN = 0x0104;
    const int VK_BACK = 0x08, VK_TAB = 0x09, VK_RETURN = 0x0D, VK_SHIFT = 0x10,
              VK_CONTROL = 0x11, VK_MENU = 0x12, VK_CAPITAL = 0x14,
              VK_LSHIFT = 0xA0, VK_RSHIFT = 0xA1;
    // LLKHF_INJECTED: keys PocketDesk or another program synthesise are not what the user typed.
    const uint LLKHF_INJECTED = 0x10;
    const string TASK = "Clippy";
    const string CAPTURE = "clippy_capture.json";
    const string HISTORY = "clippy_history.json";
    const string DIR_FILE = "clippy_dir.txt";

    delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public uint msg; public IntPtr w, l; public uint time; public int x, y; }

    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc cb, IntPtr mod, uint th);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] static extern short GetKeyState(int vk);
    [DllImport("user32.dll")] static extern int ToUnicodeEx(uint vk, uint scan, byte[] kb, StringBuilder buff, int size, uint flags, IntPtr layout);
    [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);

    static readonly StringBuilder buf = new StringBuilder();
    static readonly object bufLock = new object();
    static readonly HookProc proc = Hook;   // keep delegate alive
    static IntPtr hook;
    static string DIR;
    static string CAP_FILE, HIST_FILE;
    // A held-down Ctrl+C repeats WM_KEYDOWN; one press is one capture.
    static int lastCapture;
    static string ExePath { get { return Assembly.GetExecutingAssembly().Location; } }

    static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    /**
     * Replaces [path] in one step, so a reader never sees half a snapshot. File.Replace keeps the
     * old file's identity (and works on NTFS); Copy covers a filesystem that refuses it.
     */
    static void WriteAtomic(string path, string body)
    {
        string tmp = path + ".tmp";
        File.WriteAllText(tmp, body, new UTF8Encoding(false));
        try
        {
            if (File.Exists(path)) { File.Replace(tmp, path, null); return; }
            File.Move(tmp, path);
        }
        catch
        {
            File.Copy(tmp, path, true);
            try { File.Delete(tmp); } catch { }
        }
    }

    /** History is append-only: opened for append, shared so the daemon can read while it grows. */
    static void AppendLine(string path, string line)
    {
        using (var fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
        using (var w = new StreamWriter(fs, new UTF8Encoding(false)))
            w.Write(line + "\n");
    }

    static string Json(string s)
    {
        var b = new StringBuilder("\"");
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': b.Append("\\\""); break;
                case '\\': b.Append("\\\\"); break;
                case '\n': b.Append("\\n"); break;
                case '\r': b.Append("\\r"); break;
                case '\t': b.Append("\\t"); break;
                default:
                    if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
                    else b.Append(c);
                    break;
            }
        }
        return b.Append('"').ToString();
    }

    static string Xml(string s)
    {
        return s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
    }

    static string WindowTitle()
    {
        try
        {
            IntPtr h = GetForegroundWindow();
            int n = GetWindowTextLength(h);
            var sb = new StringBuilder(Math.Max(256, n + 1));
            GetWindowText(h, sb, sb.Capacity);
            return sb.ToString();
        }
        catch { return ""; }
    }

    static string Clip()
    {
        // Another app may hold the clipboard open for a moment; try a few times.
        for (int i = 0; i < 5; i++)
        {
            try { if (Clipboard.ContainsText()) return Clipboard.GetText(); return ""; }
            catch { Thread.Sleep(40); }
        }
        return "";
    }

    // Ctrl+C: the foreground window, the system clipboard and the typed buffer since the last
    // capture. The buffer is what saves apps with a private clipboard. The capture file is
    // replaced atomically; the history file only ever grows (one JSON object per line).
    static void SaveCopy()
    {
        try
        {
            int now = Environment.TickCount;
            if (now - lastCapture < 400) return;
            lastCapture = now;

            string typed;
            lock (bufLock)
            {
                typed = buf.ToString();
                if (typed.Length > 0) buf.Clear();
            }
            string clip = Clip();
            string win = WindowTitle();
            string at = DateTime.Now.ToString("o");
            string entry = "{\"at\":" + Json(at) + ",\"window\":" + Json(win) + ",\"text\":" + Json(clip) + ",\"typed\":" + Json(typed) + "}";

            WriteAtomic(CAP_FILE, entry + "\n");
            AppendLine(HIST_FILE, entry);
        }
        catch { /* the clipboard/history is best effort */ }
    }

    static void TypeChar(int vk, uint scan, bool ctrl, bool alt, bool shift)
    {
        var kb = new byte[256];
        if (shift) { kb[VK_SHIFT] = 0x80; kb[VK_LSHIFT] = 0x80; kb[VK_RSHIFT] = 0x80; }
        // Caps Lock is a toggle, not a held key: GetKeyState reports the light, GetAsyncKeyState the press.
        if ((GetKeyState(VK_CAPITAL) & 0x01) != 0) kb[VK_CAPITAL] = 0x01;
        // AltGr arrives as Ctrl+Alt; ToUnicodeEx needs both to pick the right character.
        if (ctrl) kb[VK_CONTROL] = 0x80;
        if (alt) kb[VK_MENU] = 0x80;
        var sb = new StringBuilder(8);
        int n = ToUnicodeEx((uint)vk, scan, kb, sb, sb.Capacity, 0, GetKeyboardLayout(0));
        if (n > 0)
        {
            string s = sb.ToString(0, n);
            // A dead key (n < 0) is left to the next key press, so nothing is appended for it.
            if (s.Length > 0 && s != "\0") lock (bufLock) buf.Append(s);
        }
    }

    static IntPtr Hook(int code, IntPtr w, IntPtr l)
    {
        int m = (int)w;
        if (code >= 0 && (m == WM_KEYDOWN || m == WM_SYSKEYDOWN))
        {
            var k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(KBDLLHOOKSTRUCT));
            // PocketDesk pastes by synthesising Ctrl+V; recording that would corrupt the buffer.
            if ((k.flags & LLKHF_INJECTED) != 0) return CallNextHookEx(hook, code, w, l);

            int vk = (int)k.vkCode;
            bool ctrl = Down(VK_CONTROL), alt = Down(VK_MENU), shift = Down(VK_SHIFT);

            if (ctrl && shift && vk == 'Q') { UnhookWindowsHookEx(hook); Environment.Exit(0); }
            if (ctrl && shift && vk == 'X') { lock (bufLock) buf.Clear(); return CallNextHookEx(hook, code, w, l); }
            if (ctrl && !alt && vk == 'C') { SaveCopy(); return CallNextHookEx(hook, code, w, l); }
            // Ctrl+Alt is AltGr on most layouts, so it types. Every other Ctrl combo is a shortcut
            // (no paste is recorded, so Ctrl+V only ever passes through).
            if (ctrl && !alt) return CallNextHookEx(hook, code, w, l);
            if (vk == VK_BACK) { lock (bufLock) { if (buf.Length > 0) buf.Remove(buf.Length - 1, 1); } return CallNextHookEx(hook, code, w, l); }
            if (vk == VK_RETURN) { lock (bufLock) buf.Append('\n'); return CallNextHookEx(hook, code, w, l); }
            if (vk == VK_TAB) { lock (bufLock) buf.Append('\t'); return CallNextHookEx(hook, code, w, l); }
            if (vk == VK_SHIFT || vk == VK_CONTROL || vk == VK_MENU || vk == VK_CAPITAL) return CallNextHookEx(hook, code, w, l);

            TypeChar(vk, k.scanCode, ctrl, alt, shift);
        }
        return CallNextHookEx(hook, code, w, l);
    }

    static bool Writable(string dir)
    {
        try
        {
            if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
            string probe = Path.Combine(dir, ".clippy_write_test");
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
            return true;
        }
        catch { return false; }
    }

    static string ResolveDir()
    {
        try
        {
            string cfg = Path.Combine(Path.GetDirectoryName(ExePath), DIR_FILE);
            if (File.Exists(cfg))
            {
                string p = File.ReadAllText(cfg).Trim();
                if (p.Length > 0 && Path.IsPathRooted(p)) return p;
            }
        }
        catch { }
        // One data folder per user, whatever copy of clippy is running (a checkout, or the installed
        // app): capture and history never land inside a program folder or a git worktree.
        string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        if (local != null)
        {
            string perUser = Path.Combine(local, "PocketDesk", "clippy");
            if (Writable(perUser)) return perUser;
        }
        string beside = Path.GetDirectoryName(ExePath);
        // An install under Program Files cannot write beside the exe.
        if (Writable(beside)) return beside;
        return Path.Combine(local != null ? local : Path.GetTempPath(), "PocketDesk", "clippy");
    }

    static void Run()
    {
        bool once;
        using (var mx = new Mutex(true, "Clippy_singleton", out once))
        {
            if (!once) return;   // already running
            if (!Directory.Exists(DIR)) Directory.CreateDirectory(DIR);
            CAP_FILE = Path.Combine(DIR, CAPTURE);
            HIST_FILE = Path.Combine(DIR, HISTORY);
            hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
            GC.KeepAlive(mx);
        }
    }

    static bool IsAdmin()
    {
        try { return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator); }
        catch { return false; }
    }

    static int Schtasks(string args, bool show)
    {
        var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "schtasks.exe"), args)
        { UseShellExecute = false, CreateNoWindow = !show, WindowStyle = show ? ProcessWindowStyle.Normal : ProcessWindowStyle.Hidden };
        var p = Process.Start(psi); p.WaitForExit(); return p.ExitCode;
    }

    static bool Elevate(string verbArg)
    {
        if (IsAdmin()) return false;
        try { Process.Start(new ProcessStartInfo(ExePath, verbArg) { UseShellExecute = true, Verb = "runas" }); } catch { }
        return true;
    }

    static void Install()
    {
        if (Elevate("--install --dir \"" + DIR + "\"")) return;
        string me = WindowsIdentity.GetCurrent().Name;
        string xml =
"<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n" +
"<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n" +
"  <RegistrationInfo><Description>Clippy keystroke recorder for PocketDesk</Description></RegistrationInfo>\n" +
"  <Triggers />\n" +
"  <Principals><Principal id=\"Author\">\n" +
"    <UserId>" + Xml(me) + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel>\n" +
"  </Principal></Principals>\n" +
"  <Settings>\n" +
"    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n" +
"    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n" +
"    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n" +
"    <AllowHardTerminate>true</AllowHardTerminate>\n" +
"    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled>\n" +
"  </Settings>\n" +
"  <Actions Context=\"Author\"><Exec><Command>\"" + Xml(ExePath) + "\"</Command><Arguments>--dir \"" + Xml(DIR) + "\"</Arguments></Exec></Actions>\n" +
"</Task>\n";
        string tmp = Path.Combine(Path.GetTempPath(), "clippy_task.xml");
        File.WriteAllText(tmp, xml, Encoding.Unicode);
        int rc = Schtasks("/Create /TN " + TASK + " /XML \"" + tmp + "\" /F", false);
        try { File.Delete(tmp); } catch { }
        MessageBox.Show(rc == 0 ? "Clippy installed. Start it from PocketDesk or: clippy --start"
                                : "Install failed (code " + rc + ").", "clippy");
    }

    static void Uninstall()
    {
        if (Elevate("--uninstall")) return;
        Schtasks("/End /TN " + TASK, false);
        int rc = Schtasks("/Delete /TN " + TASK + " /F", false);
        MessageBox.Show(rc == 0 ? "Clippy uninstalled." : "Uninstall failed (code " + rc + ").", "clippy");
    }

    static void OpenFile(string file)
    {
        try
        {
            if (!File.Exists(file)) File.WriteAllText(file, "");
            Process.Start(new ProcessStartInfo(file) { UseShellExecute = true });
        }
        catch { }
    }

    static void Clear()
    {
        try { WriteAtomic(CAP_FILE, ""); } catch { }
        try { File.WriteAllText(HIST_FILE, ""); } catch { }
        lock (bufLock) buf.Clear();
    }

    [STAThread]
    static void Main(string[] args)
    {
        DIR = ResolveDir();
        var rest = new System.Collections.Generic.List<string>();
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i].TrimStart('-', '/').ToLowerInvariant();
            if ((a == "dir" || a == "out") && i + 1 < args.Length) { DIR = args[++i]; continue; }
            rest.Add(args[i]);
        }
        CAP_FILE = Path.Combine(DIR, CAPTURE);
        HIST_FILE = Path.Combine(DIR, HISTORY);
        string cmd = rest.Count > 0 ? rest[0].TrimStart('-', '/').ToLowerInvariant() : "";
        switch (cmd)
        {
            case "install": Install(); break;
            case "uninstall": Uninstall(); break;
            case "start": Schtasks("/Run /TN " + TASK, false); break;
            case "stop": Schtasks("/End /TN " + TASK, false); break;
            case "capture": SaveCopy(); break;
            case "open": OpenFile(CAP_FILE); break;
            case "history": OpenFile(HIST_FILE); break;
            case "clear": Clear(); break;
            default: Run(); break;
        }
    }
}
