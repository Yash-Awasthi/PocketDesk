using System;
using System.Diagnostics;
using System.ComponentModel;
using System.IO;
using System.Net.Sockets;
using System.Security.Principal;

// Windowless launcher for the hidden daemon. Three uses:
//   PocketDeskLauncher.exe            — a person opening the app: start the daemon if it is not
//                                       already running, then open the pairing page in the browser.
//   PocketDeskLauncher.exe --daemon   — the logon autostart: start the daemon hidden, then exit.
//   PocketDeskLauncher.exe --elevated — internal: the copy that UAC elevated, which only starts the daemon.
// The daemon runs as administrator, so input reaches elevated windows such as Task Manager. Starting
// it shows the UAC prompt; No leaves it stopped. The pairing page always opens unelevated.
// The daemon is spawned detached, so it keeps running after this process exits and is stopped only
// from Task Manager (end "PocketDesk.exe") or by the uninstaller. No tray icon, no window, no on-screen indicator.
namespace PocketDeskLauncher
{
    internal static class Program
    {
        static readonly string DataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".pocketdesk");

        static string ExeDir { get { return AppDomain.CurrentDomain.BaseDirectory; } }

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

            if (!DaemonRunning(port) && !StartElevated()) return;

            if (!autostart)
            {
                // Give a just-started daemon a moment to bind before the page loads.
                for (int i = 0; i < 40 && !DaemonRunning(port); i++) System.Threading.Thread.Sleep(100);
                LoadConfig(ref port, ref token, ref tls);
                string url = (tls ? "https" : "http") + "://localhost:" + port + "/pair?k=" + Uri.EscapeDataString(token);
                try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
            }
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

        static void StartDaemonDetached()
        {
            try
            {
                // PocketDesk.exe is a copy of node.exe, so Task Manager lists the daemon by name.
                // Only binaries in this admin-only folder: the daemon runs elevated, and PATH is the user's to change.
                var named = Path.Combine(ExeDir, "PocketDesk.exe");
                if (!File.Exists(named)) return;
                var psi = new ProcessStartInfo
                {
                    FileName = named,
                    Arguments = "src\\index.js",
                    WorkingDirectory = DaemonDir(),
                    CreateNoWindow = true,
                    UseShellExecute = false,
                };
                // NODE_OPTIONS and friends come from the user's environment and would load code into the elevated node.
                var nodeVars = new System.Collections.Generic.List<string>();
                foreach (string k in psi.EnvironmentVariables.Keys) if (k.StartsWith("NODE_", StringComparison.OrdinalIgnoreCase)) nodeVars.Add(k);
                foreach (var k in nodeVars) psi.EnvironmentVariables.Remove(k);
                // Set even when missing, so the daemon falls back to JPEG instead of an ffmpeg found on PATH.
                psi.EnvironmentVariables["FFMPEG_PATH"] = Path.Combine(ExeDir, "ffmpeg", "ffmpeg.exe");
                // Not a child of this launcher: no stdin pipe, and never stop on stdin EOF, so the
                // daemon outlives this process.
                Process.Start(psi);
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
