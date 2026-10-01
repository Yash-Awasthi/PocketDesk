using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;

// Windowless launcher for the hidden daemon. Two uses:
//   PocketDeskLauncher.exe            — a person opening the app: start the daemon if it is not
//                                       already running, then open the pairing page in the browser.
//   PocketDeskLauncher.exe --daemon   — the logon autostart: start the daemon hidden, then exit.
// The daemon is spawned detached, so it keeps running after this process exits and is stopped only
// from Task Manager (end "node.exe"). No tray icon, no window, no on-screen indicator.
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

            if (!DaemonRunning(port)) StartDaemonDetached();

            if (!autostart)
            {
                // Give a just-started daemon a moment to bind before the page loads.
                for (int i = 0; i < 40 && !DaemonRunning(port); i++) System.Threading.Thread.Sleep(100);
                LoadConfig(ref port, ref token, ref tls);
                string url = (tls ? "https" : "http") + "://localhost:" + port + "/pair?k=" + Uri.EscapeDataString(token);
                try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
            }
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
                var bundledNode = Path.Combine(ExeDir, "node", "node.exe");
                var psi = new ProcessStartInfo
                {
                    FileName = File.Exists(bundledNode) ? bundledNode : "node",
                    Arguments = "src\\index.js",
                    WorkingDirectory = DaemonDir(),
                    CreateNoWindow = true,
                    UseShellExecute = false,
                };
                var bundledFfmpeg = Path.Combine(ExeDir, "ffmpeg.exe");
                if (File.Exists(bundledFfmpeg)) psi.EnvironmentVariables["FFMPEG_PATH"] = bundledFfmpeg;
                // Not a child of this launcher: no stdin pipe, and never stop on stdin EOF, so the
                // daemon outlives this process and is ended only from Task Manager.
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
