using System;
using System.Diagnostics;
using System.ComponentModel;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

// Windowless launcher for the daemon. Four uses:
//   PocketDeskLauncher.exe             - a person opening the app: start the daemon if it is not
//                                        already running, then open the pairing page in the browser.
//   PocketDeskLauncher.exe --supervise - the logon autostart: hold the daemon as a child and exit with
//                                        its code, so Task Scheduler restarts a crash (non-zero) and
//                                        leaves a clean stop (zero) alone.
//   PocketDeskLauncher.exe --daemon    - start the daemon hidden in the background, then exit.
//   PocketDeskLauncher.exe --elevated  - internal: the copy that UAC elevated, which only starts the daemon.
// A normal install runs the daemon as you, from your own folder, so it can always be closed. Only an
// explicit -Protected install (marker written into the Program Files copy) elevates, and there UAC
// decides: No leaves it stopped. An elevated daemon reaches elevated windows such as Task Manager,
// and in exchange ordinary programs cannot stop it. The pairing page always opens unelevated.
// No tray, no icon and no window: the local settings page is the only entry point. The daemon is
// spawned detached and is stopped by `pocketdesk stop` (its loopback CLI), by Task Manager (end
// "PocketDesk.exe") or by the uninstaller. Nothing hides itself from the machine.
namespace PocketDeskLauncher
{
    internal static class Program
    {
        internal static readonly string DataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".pocketdesk");

        internal static string CertFile = "";

        internal static string ExeDir { get { return AppDomain.CurrentDomain.BaseDirectory; } }

        [STAThread]
        static void Main(string[] args)
        {
            bool autostart = Array.IndexOf(args, "--daemon") >= 0;
            string port = "8765", token = "";
            bool tls = false;
            LoadConfig(ref port, ref token, ref tls);

            if (Array.IndexOf(args, "--elevated") >= 0)
            {
                if (!DaemonRunning(port)) StartDaemonDetached();
                return;
            }

            if (Array.IndexOf(args, "--supervise") >= 0)
            {
                Supervise(port);
                return;
            }

            if (!DaemonRunning(port) && !StartDaemon()) return;

            if (!autostart) OpenPairingPage(port);
        }

        /** The logon autostart: run the daemon as a held child, wait, and exit with its own code. */
        static void Supervise(string port)
        {
            if (DaemonRunning(port)) return;
            var psi = BuildDaemonPsi();
            if (psi == null) Environment.Exit(1);
            Process daemon;
            try { daemon = Process.Start(psi); }
            catch { Environment.Exit(1); return; }
            if (daemon == null) { Environment.Exit(1); return; }
            // Job object we hold the only handle to: when this supervisor dies, for any reason, the
            // handle closes and Windows kills the daemon too. Ending the task never leaves the daemon
            // running beside a task that is about to restart it.
            IntPtr job = KillOnSupervisorExit(daemon);
            daemon.WaitForExit();
            if (job != IntPtr.Zero) CloseHandle(job);
            // The task's exit code is the daemon's: non-zero is a crash for RestartCount, zero a stop.
            Environment.Exit(daemon.ExitCode);
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll")]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
        [DllImport("kernel32.dll")]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);

        /** Puts the daemon in a kill-on-close job; IntPtr.Zero when the job cannot be set up. */
        static IntPtr KillOnSupervisorExit(Process daemon)
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return IntPtr.Zero;
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr p = Marshal.AllocHGlobal(len);
            try
            {
                Marshal.StructureToPtr(info, p, false);
                bool ok = SetInformationJobObject(job, 9, p, (uint)len) &&
                          AssignProcessToJobObject(job, daemon.Handle);
                if (!ok) { CloseHandle(job); return IntPtr.Zero; }
                return job;
            }
            finally { Marshal.FreeHGlobal(p); }
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        /** Waits for the daemon to bind, then opens its pairing page in the default browser. */
        internal static void OpenPairingPage(string port)
        {
            for (int i = 0; i < 40 && !DaemonRunning(port); i++) System.Threading.Thread.Sleep(100);
            string token = "", p = port; bool tls = false;
            LoadConfig(ref p, ref token, ref tls);
            // The URL carries the master token; a program squatting the port must not receive it. A
            // plaintext daemon cannot be told from a squatter, and only exists when TLS setup failed.
            if (tls && !IsOurDaemon(port)) return;
            // The loopback page (port + 10) opens without a certificate warning, once it proves it holds the token.
            int n;
            if (tls && int.TryParse(port, out n) && ProvesToken(n + 10, token)) { tls = false; port = (n + 10).ToString(); }
            string url = (tls ? "https" : "http") + "://localhost:" + port + "/pair?k=" + Uri.EscapeDataString(token);
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
        }

        /** True when the port answers a fresh nonce with the token's HMAC, which only the daemon can compute. */
        static bool ProvesToken(int port, string token)
        {
            try
            {
                string nonce = Guid.NewGuid().ToString("N");
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/prove?n=" + nonce);
                req.Timeout = 3000;
                string got;
                using (var res = req.GetResponse())
                using (var r = new StreamReader(res.GetResponseStream())) got = r.ReadToEnd();
                using (var h = new HMACSHA256(Encoding.UTF8.GetBytes(token)))
                    return got == BitConverter.ToString(h.ComputeHash(Encoding.UTF8.GetBytes(nonce))).Replace("-", "").ToLowerInvariant();
            }
            catch { return false; }
        }

        /** True for the opt-in -Protected install, whose every binary sits in an admin-only folder. */
        static bool IsProtectedInstall { get { return File.Exists(Path.Combine(ExeDir, "PocketDesk.ini")); } }

        /** Starts the daemon: as you for a normal install, through UAC for a -Protected one. */
        static bool StartDaemon()
        {
            if (!IsProtectedInstall) { StartDaemonDetached(); return true; }
            return StartElevated();
        }

        static bool IsElevated()
        {
            using (var id = WindowsIdentity.GetCurrent())
                return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
        }

        /** Starts the daemon as administrator; false when UAC was declined or could not run. */
        static bool StartElevated()
        {
            if (IsElevated()) { StartDaemonDetached(); return true; }
            try
            {
                var p = Process.Start(new ProcessStartInfo(Path.Combine(ExeDir, "PocketDeskLauncher.exe"), "--elevated")
                {
                    UseShellExecute = true,
                    Verb = "runas",
                });
                if (p != null) p.WaitForExit();
                return true;
            }
            catch (Win32Exception) { return false; } // 1223: the user chose No
        }

        static bool DaemonRunning(string port)
        {
            int p;
            if (!int.TryParse(port, out p)) return false;
            try
            {
                using (var c = new TcpClient())
                {
                    var r = c.BeginConnect("127.0.0.1", p, null, null);
                    bool ok = r.AsyncWaitHandle.WaitOne(300) && c.Connected;
                    if (ok) c.EndConnect(r);
                    return ok;
                }
            }
            catch { return false; }
        }

        /** True when the listener on the port presents this install's own certificate. */
        static bool IsOurDaemon(string port)
        {
            try
            {
                string want = new X509Certificate2(CertFile).GetCertHashString();
                using (var c = new TcpClient("127.0.0.1", int.Parse(port)))
                using (var s = new SslStream(c.GetStream(), false, (o, cert, chain, errors) => cert != null && new X509Certificate2(cert).GetCertHashString() == want))
                {
                    s.AuthenticateAsClient("localhost", null, SslProtocols.Tls12, false);
                    return true;
                }
            }
            catch { return false; }
        }

        static string DaemonDir()
        {
            var dir = ExeDir.TrimEnd('\\');
            try
            {
                var ini = Path.Combine(ExeDir, "PocketDesk.ini");
                if (File.Exists(ini)) dir = File.ReadAllText(ini).Trim().TrimEnd('\\');
            }
            catch { }
            return dir;
        }

        /** The elevated daemon's launch settings, or null when its exe is missing. */
        static ProcessStartInfo BuildDaemonPsi()
        {
            // PocketDesk.exe is a copy of node.exe, so Task Manager lists the daemon by name. Only
            // binaries in this admin-only folder: the daemon runs elevated, and PATH is the user's to change.
            var named = Path.Combine(ExeDir, "PocketDesk.exe");
            if (!File.Exists(named)) return null;
            var psi = new ProcessStartInfo
            {
                FileName = named,
                Arguments = "src\\index.js",
                WorkingDirectory = DaemonDir(),
                CreateNoWindow = true,
                UseShellExecute = false,
            };
            // NODE_* come from the user's environment and would load code into the elevated node.
            var nodeVars = new System.Collections.Generic.List<string>();
            foreach (string k in psi.EnvironmentVariables.Keys) if (k.StartsWith("NODE_", StringComparison.OrdinalIgnoreCase)) nodeVars.Add(k);
            foreach (var k in nodeVars) psi.EnvironmentVariables.Remove(k);
            // Set only for a -Protected install, which snapshots ffmpeg beside the daemon. A normal
            // install may rely on ffmpeg from PATH, where the daemon looks when this is unset.
            var ff = Path.Combine(ExeDir, "ffmpeg", "ffmpeg.exe");
            if (File.Exists(ff)) psi.EnvironmentVariables["FFMPEG_PATH"] = ff;
            return psi;
        }

        static void StartDaemonDetached()
        {
            try
            {
                var psi = BuildDaemonPsi();
                // Not a child of this launcher: no stdin pipe, and never stop on stdin EOF, so the
                // daemon outlives this process.
                if (psi != null) Process.Start(psi);
            }
            catch { }
        }

        static void LoadConfig(ref string port, ref string token, ref bool tls)
        {
            try
            {
                var json = File.ReadAllText(Path.Combine(DataDir, "config.json"));
                port = ExtractString(json, "port") ?? port;
                token = ExtractString(json, "token") ?? token;
                tls = json.Contains("\"enabled\": true") || json.Contains("\"enabled\":true");
                CertFile = (ExtractString(json, "cert") ?? Path.Combine(DataDir, "tls", "cert.pem")).Replace("\\\\", "\\");
            }
            catch { }
        }

        // Minimal reader so the launcher needs no JSON library: handles "key": "value" and "key": 1234.
        static string ExtractString(string json, string key)
        {
            var marker = "\"" + key + "\"";
            int i = json.IndexOf(marker);
            if (i < 0) return null;
            int c = json.IndexOf(':', i + marker.Length);
            if (c < 0) return null;
            int j = c + 1;
            while (j < json.Length && (json[j] == ' ' || json[j] == '\t')) j++;
            if (j < json.Length && json[j] == '"')
            {
                int end = json.IndexOf('"', j + 1);
                if (end < 0) return null;
                return json.Substring(j + 1, end - j - 1);
            }
            int numEnd = j;
            while (numEnd < json.Length && (char.IsDigit(json[numEnd]))) numEnd++;
            return numEnd > j ? json.Substring(j, numEnd - j) : null;
        }
    }
}
