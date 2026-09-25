using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace PocketDeskTray
{
    internal static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayContext());
        }
    }

    internal class TrayContext : ApplicationContext
    {
        readonly NotifyIcon icon;
        readonly ToolStripMenuItem startItem;
        readonly ToolStripMenuItem stopItem;
        Process daemon;
        string port = "8765";
        string token = "";
        bool tlsEnabled;
        string fingerprint = "";
        string daemonDir;
        static readonly string LogPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".pocketdesk", "daemon.log");
        // The daemon checks for this file before every remote viewing session.
        static readonly string ApprovalFlag = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".pocketdesk", "ask-before-viewing");

        public TrayContext()
        {
            LoadConfig();
            LoadDaemonDir();

            var menu = new ContextMenuStrip();
            // Settings change (first run writes them; the port can be edited), so read them on every open.
            menu.Opening += (s, e) => LoadConfig();
            menu.Items.Add("Pair a phone...", null, (s, e) => OpenUrl(BaseUrl() + "/pair"));
            menu.Items.Add("Open web UI", null, (s, e) => OpenUrl(BaseUrl()));
            menu.Items.Add("Copy pairing info", null, (s, e) => CopyPairing());
            menu.Items.Add("Open daemon log", null, (s, e) => { try { Process.Start("notepad.exe", LogPath); } catch { } });
            var askItem = new ToolStripMenuItem("Ask before someone views this PC", null, (s, e) => ToggleApproval());
            menu.Opening += (s, e) => askItem.Checked = File.Exists(ApprovalFlag);
            menu.Items.Add(askItem);
            menu.Items.Add(new ToolStripSeparator());
            startItem = new ToolStripMenuItem("Start daemon", null, (s, e) => StartDaemon());
            stopItem = new ToolStripMenuItem("Stop daemon", null, (s, e) => StopDaemon());
            menu.Items.Add(startItem);
            menu.Items.Add(stopItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Exit", null, (s, e) => { StopDaemon(); icon.Visible = false; Application.Exit(); });

            icon = new NotifyIcon
            {
                Text = "PocketDesk",
                ContextMenuStrip = menu,
                Visible = true,
            };
            SetRunning(false);
            StartDaemon();
        }

        void ToggleApproval()
        {
            try
            {
                if (File.Exists(ApprovalFlag)) File.Delete(ApprovalFlag);
                else File.WriteAllText(ApprovalFlag, "");
            }
            catch (Exception ex) { MessageBox.Show("Could not change the setting: " + ex.Message, "PocketDesk"); }
        }

        string ExeDir
        {
            get { return AppDomain.CurrentDomain.BaseDirectory; }
        }

        void LoadDaemonDir()
        {
            daemonDir = ExeDir.TrimEnd('\\');
            try
            {
                var ini = Path.Combine(ExeDir, "PocketDeskTray.ini");
                if (File.Exists(ini)) daemonDir = File.ReadAllText(ini).Trim().TrimEnd('\\');
            }
            catch { }
        }

        void LoadConfig()
        {
            try
            {
                var cfgPath = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    ".pocketdesk", "config.json");
                var json = File.ReadAllText(cfgPath);
                port = ExtractString(json, "port") ?? port;
                token = ExtractString(json, "token") ?? "";
                tlsEnabled = json.Contains("\"enabled\": true") || json.Contains("\"enabled\":true");
                var fpPath = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    ".pocketdesk", "tls", "fingerprint.txt");
                if (File.Exists(fpPath)) fingerprint = File.ReadAllText(fpPath).Trim();
            }
            catch { }
        }

        string ExtractString(string json, string key)
        {
            var idx = json.IndexOf("\"" + key + "\"");
            if (idx < 0) return null;
            var colon = json.IndexOf(':', idx);
            if (colon < 0) return null;
            var start = json.IndexOfAny(new[] { '"', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9' }, colon);
            if (start < 0) return null;
            if (json[start] == '"')
            {
                var end = json.IndexOf('"', start + 1);
                return json.Substring(start + 1, end - start - 1);
            }
            var numEnd = start;
            while (numEnd < json.Length && char.IsDigit(json[numEnd])) numEnd++;
            return json.Substring(start, numEnd - start);
        }

        void StartDaemon()
        {
            if (daemon != null && !daemon.HasExited) return;
            try
            {
                // install.ps1 puts a private node and ffmpeg next to the tray; a checkout uses PATH.
                var bundledNode = Path.Combine(ExeDir, "node", "node.exe");
                var psi = new ProcessStartInfo
                {
                    FileName = File.Exists(bundledNode) ? bundledNode : "node",
                    Arguments = "src\\index.js",
                    WorkingDirectory = daemonDir,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                var bundledFfmpeg = Path.Combine(ExeDir, "ffmpeg", "ffmpeg.exe");
                if (File.Exists(bundledFfmpeg)) psi.EnvironmentVariables["FFMPEG_PATH"] = bundledFfmpeg;
                // Fresh log per start; the daemon's banner and connection lines land here.
                var log = new StreamWriter(LogPath, false) { AutoFlush = true };
                daemon = Process.Start(psi);
                DataReceivedEventHandler write = (s, e) => { if (e.Data != null) lock (log) log.WriteLine(e.Data); };
                daemon.OutputDataReceived += write;
                daemon.ErrorDataReceived += write;
                daemon.BeginOutputReadLine();
                daemon.BeginErrorReadLine();
                ShowBalloon("daemon started");
            }
            catch (Exception ex)
            {
                ShowBalloon("failed to start daemon: " + ex.Message);
            }
            SetRunning(daemon != null && !daemon.HasExited);
        }

        void StopDaemon()
        {
            if (daemon == null) return;
            try
            {
                if (!daemon.HasExited) daemon.Kill();
                daemon.Dispose();
            }
            catch { }
            daemon = null;
            SetRunning(false);
        }

        void SetRunning(bool running)
        {
            if (icon != null) icon.Icon = MakeIcon(running ? Color.FromArgb(76, 175, 80) : Color.FromArgb(158, 158, 158));
            if (startItem != null) startItem.Enabled = !running;
            if (stopItem != null) stopItem.Enabled = running;
        }

        void ShowBalloon(string message)
        {
            icon.BalloonTipTitle = "PocketDesk";
            icon.BalloonTipText = message;
            icon.ShowBalloonTip(2000);
        }

        Icon MakeIcon(Color color)
        {
            using (var bmp = new Bitmap(16, 16))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.Clear(Color.Transparent);
                    using (var b = new SolidBrush(color)) g.FillEllipse(b, 2, 2, 12, 12);
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }

        string BaseUrl()
        {
            return (tlsEnabled ? "https" : "http") + "://localhost:" + port;
        }

        void OpenUrl(string url)
        {
            try { Process.Start(url); } catch { }
        }

        void CopyPairing()
        {
            var host = Environment.MachineName;
            var scheme = tlsEnabled ? "wss" : "ws";
            var text = "host: " + host + "\r\nurl: " + scheme + "://" + host + ":" + port + "/ws\r\ntoken: " + token;
            if (fingerprint.Length > 0) text += "\r\ncert sha-256: " + fingerprint;
            Clipboard.SetText(text);
            ShowBalloon("pairing info copied");
        }
    }
}
