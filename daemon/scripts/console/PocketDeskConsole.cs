// Console launcher: keeps one daemon alive as SYSTEM in the active console
// session, relaunching it across logon / lock / session-switch transitions. A
// SYSTEM process in the console session is the only thing that may attach to
// Windows' secure desktop (UAC prompts, lock screen, the logon screen), which
// the ordinary user daemon cannot reach. Started by the PocketDeskConsole
// scheduled task (SYSTEM, at boot). Compiled with csc.exe, references System.dll.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace PocketDeskConsole
{
    internal static class Program
    {
        const uint TOKEN_DUPLICATE = 0x0002, TOKEN_QUERY = 0x0008,
            TOKEN_ASSIGN_PRIMARY = 0x0001, TOKEN_ADJUST_DEFAULT = 0x0080,
            TOKEN_ADJUST_SESSIONID = 0x0100;
        const uint MAXIMUM_ALLOWED = 0x02000000;
        const int TokenSessionId = 12;                       // TOKEN_INFORMATION_CLASS
        const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400, CREATE_NO_WINDOW = 0x08000000;
        const uint SecurityIdentification = 1;               // SECURITY_IMPERSONATION_LEVEL
        const uint TokenPrimary = 1;                         // TOKEN_TYPE
        const uint INVALID_SESSION = 0xFFFFFFFF;
        const uint WAIT_TIMEOUT = 0x00000102;

        [StructLayout(LayoutKind.Sequential)]
        struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFO {
            public int cb; public string lpReserved, lpDesktop, lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

        [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr tok);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr tok, uint access, ref SECURITY_ATTRIBUTES sa, uint level, uint type, out IntPtr dup);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr tok, int cls, ref uint val, int len);
        [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr tok, bool inherit);
        [DllImport("userenv.dll", SetLastError = true)] static extern bool DestroyEnvironmentBlock(IntPtr env);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CreateProcessAsUser(IntPtr tok, string app, string cmd,
            ref SECURITY_ATTRIBUTES pa, ref SECURITY_ATTRIBUTES ta, bool inherit, uint flags,
            IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

        static string ExeDir { get { return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'); } }

        // Only Administrators + SYSTEM can write here; anything this SYSTEM process executes must
        // live under it, or an unprivileged user could swap in code that then runs as SYSTEM.
        static string ProtectedRoot
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PocketDesk"); }
        }

        static bool Under(string root, string p)
        {
            try {
                string r = Path.GetFullPath(root).TrimEnd('\\') + "\\";
                return Path.GetFullPath(p).StartsWith(r, StringComparison.OrdinalIgnoreCase);
            } catch { return false; }
        }

        static string DaemonDir()
        {
            try {
                var ini = Path.Combine(ExeDir, "PocketDeskConsole.ini");
                if (File.Exists(ini)) return File.ReadAllText(ini).Trim().TrimEnd('\\');
            } catch { }
            return Path.Combine(ExeDir, "daemon");
        }

        static void Main()
        {
            string daemonDir = DaemonDir();
            string node = Path.Combine(ExeDir, "node", "node.exe");
            string ffmpeg = Path.Combine(ExeDir, "ffmpeg", "ffmpeg.exe");
            string consoleHome = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "PocketDesk", "console");

            // Refuse to spawn as SYSTEM from any path a non-admin could have written. Exit (task
            // shows failure) rather than launch attacker-controlled code. No bare-"node" PATH
            // fallback: the executable must be the ACL-locked copy.
            string root = ProtectedRoot;
            if (!Under(root, ExeDir) || !Under(root, node) || !Under(root, daemonDir)
                || !File.Exists(node) || !File.Exists(Path.Combine(daemonDir, "src", "index.js")))
                Environment.Exit(2);

            IntPtr child = IntPtr.Zero;
            uint childSess = INVALID_SESSION;
            AppDomain.CurrentDomain.ProcessExit += (s, e) => Kill(ref child);

            while (true)
            {
                uint sess = WTSGetActiveConsoleSessionId();
                bool alive = child != IntPtr.Zero && WaitForSingleObject(child, 0) == WAIT_TIMEOUT;
                if (sess == INVALID_SESSION) { Kill(ref child); Thread.Sleep(2000); continue; }
                if (alive && childSess == sess) { Thread.Sleep(2000); continue; }

                Kill(ref child);
                try { child = Launch(sess, node, daemonDir, consoleHome, ffmpeg); childSess = sess; }
                catch { child = IntPtr.Zero; }
                Thread.Sleep(2000);
            }
        }

        static void Kill(ref IntPtr h)
        {
            if (h == IntPtr.Zero) return;
            try { TerminateProcess(h, 0); } catch { }
            try { CloseHandle(h); } catch { }
            h = IntPtr.Zero;
        }

        static IntPtr Launch(uint sess, string node, string daemonDir, string consoleHome, string ffmpeg)
        {
            var sa = new SECURITY_ATTRIBUTES(); sa.nLength = Marshal.SizeOf(sa);
            IntPtr self;
            if (!OpenProcessToken(GetCurrentProcess(),
                    TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID,
                    out self))
                throw new Exception("OpenProcessToken " + Marshal.GetLastWin32Error());
            try
            {
                IntPtr dup;
                if (!DuplicateTokenEx(self, MAXIMUM_ALLOWED, ref sa, SecurityIdentification, TokenPrimary, out dup))
                    throw new Exception("DuplicateTokenEx " + Marshal.GetLastWin32Error());
                try
                {
                    uint s = sess;
                    if (!SetTokenInformation(dup, TokenSessionId, ref s, sizeof(uint)))
                        throw new Exception("SetTokenInformation " + Marshal.GetLastWin32Error());

                    IntPtr baseEnv;
                    if (!CreateEnvironmentBlock(out baseEnv, dup, false)) baseEnv = IntPtr.Zero;
                    IntPtr env = BuildEnv(baseEnv, consoleHome, ffmpeg);
                    try
                    {
                        var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si); si.lpDesktop = @"winsta0\default";
                        PROCESS_INFORMATION pi;
                        string cmd = "\"" + node + "\" src\\index.js";
                        bool ok = CreateProcessAsUser(dup, node, cmd, ref sa, ref sa, false,
                            CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, env, daemonDir, ref si, out pi);
                        int err = Marshal.GetLastWin32Error();
                        if (!ok) throw new Exception("CreateProcessAsUser " + err);
                        CloseHandle(pi.hThread);
                        return pi.hProcess;
                    }
                    finally
                    {
                        if (env != baseEnv) Marshal.FreeHGlobal(env);
                        if (baseEnv != IntPtr.Zero) DestroyEnvironmentBlock(baseEnv);
                    }
                }
                finally { CloseHandle(dup); }
            }
            finally { CloseHandle(self); }
        }

        // UTF-16, double-null-terminated env block = the session's base block plus our vars.
        static IntPtr BuildEnv(IntPtr baseBlock, string consoleHome, string ffmpeg)
        {
            var sb = new StringBuilder();
            if (baseBlock != IntPtr.Zero)
            {
                IntPtr p = baseBlock;
                while (true)
                {
                    string entry = Marshal.PtrToStringUni(p);
                    if (string.IsNullOrEmpty(entry)) break;
                    if (!StartsAny(entry, "RH_CONSOLE=", "RH_HOME=", "RH_PORT=", "RH_LABEL=", "NODE_ENV=", "FFMPEG_PATH="))
                        sb.Append(entry).Append('\0');
                    p = (IntPtr)((long)p + (entry.Length + 1) * 2);
                }
            }
            sb.Append("RH_CONSOLE=1\0");
            sb.Append("RH_HOME=").Append(consoleHome).Append('\0');
            sb.Append("RH_PORT=8766\0");
            sb.Append("RH_LABEL=PC (console)\0");
            sb.Append("NODE_ENV=production\0");
            if (File.Exists(ffmpeg)) sb.Append("FFMPEG_PATH=").Append(ffmpeg).Append('\0');
            sb.Append('\0');
            byte[] bytes = Encoding.Unicode.GetBytes(sb.ToString());
            IntPtr mem = Marshal.AllocHGlobal(bytes.Length);
            Marshal.Copy(bytes, 0, mem, bytes.Length);
            return mem;
        }

        static bool StartsAny(string s, params string[] pre)
        {
            foreach (var p in pre) if (s.StartsWith(p, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }
    }
}
