using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace PocketDeskTray
{
    internal static class Program
    {
        [STAThread]
        static void Main()
        {
            // A second launch (Start Menu, desktop shortcut) asks the running tray to show the pairing page.
            bool first;
            using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\PocketDeskTrayShow", out first))
            {
                if (!first) { show.Set(); return; }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                var tray = new TrayContext();
                new Thread(() => { while (show.WaitOne()) tray.ShowPairing(); }) { IsBackground = true }.Start();
                Application.Run(tray);
            }
        }
    }

    internal class TrayContext : ApplicationContext
    {
        readonly NotifyIcon icon;
        readonly ToolStripMenuItem pauseItem;
        Process daemon;
        StreamWriter log;
        DateTime startedAt;
        int quickCrashes;
        SynchronizationContext ui;
        string port = "8765";
        string token = "";
        bool tlsEnabled;
        string fingerprint = "";
        string daemonDir;
        static readonly string DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".pocketdesk");
        static readonly string LogPath = Path.Combine(DataDir, "daemon.log");
        // The daemon checks for this file before every remote viewing session.
        static readonly string ApprovalFlag = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".pocketdesk", "ask-before-viewing");
        static readonly string RecordFlag = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".pocketdesk", "record-sessions");
        static readonly string Recordings = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".pocketdesk", "recordings");

        public TrayContext()
        {
            // On a fresh PC the daemon has not created it yet, and the log is opened before the daemon starts.
            try { Directory.CreateDirectory(DataDir); } catch { }
            LoadConfig();
            LoadDaemonDir();

            var menu = new ContextMenuStrip();
            ui = SynchronizationContext.Current;
            // Settings change (first run writes them; the port can be edited), so read them on every open.
            menu.Opening += (s, e) => LoadConfig();
            menu.Items.Add("Pair a phone...", null, (s, e) => OpenUrl(BaseUrl() + "/pair?k=" + Uri.EscapeDataString(token)));
            menu.Items.Add("Open web UI", null, (s, e) => OpenUrl(BaseUrl()));
            menu.Items.Add("Copy pairing info", null, (s, e) => CopyPairing());
            menu.Items.Add("Open daemon log", null, (s, e) => { try { Process.Start("notepad.exe", LogPath); } catch { } });
            var askItem = new ToolStripMenuItem("Ask before someone views this PC", null, (s, e) => ToggleFlag(ApprovalFlag));
            var recordItem = new ToolStripMenuItem("Record remote sessions", null, (s, e) => ToggleFlag(RecordFlag));
            menu.Opening += (s, e) => { askItem.Checked = File.Exists(ApprovalFlag); recordItem.Checked = File.Exists(RecordFlag); };
            menu.Items.Add(askItem);
            menu.Items.Add(recordItem);
            menu.Items.Add("Open recordings", null, (s, e) => { try { Directory.CreateDirectory(Recordings); Process.Start("explorer.exe", Recordings); } catch { } });
            menu.Items.Add(new ToolStripSeparator());
            pauseItem = new ToolStripMenuItem("Pause", null, (s, e) => { if (daemon != null) StopDaemon(); else StartDaemon(); });
            menu.Items.Add(pauseItem);
            menu.Items.Add("Exit (stop everything)", null, (s, e) => { StopDaemon(); icon.Visible = false; Application.Exit(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Uninstall PocketDesk", null, (s, e) => Uninstall());

            icon = new NotifyIcon
            {
                Text = "PocketDesk",
                ContextMenuStrip = menu,
                Visible = true,
            };
            SetRunning(false);
            StartDaemon();
        }

        void Uninstall()
        {
            var script = Path.Combine(ExeDir, "uninstall.ps1");
            if (!File.Exists(script)) { ShowBalloon("uninstall.ps1 not found next to the tray"); return; }
            // uninstall.ps1 kills this tray and deletes its folder, so it must not run from inside it.
            Process.Start(new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"")
            {
                WorkingDirectory = Path.GetTempPath(),
                UseShellExecute = false,
            });
        }

        void ToggleFlag(string flag)
        {
            try
            {
                if (File.Exists(flag)) File.Delete(flag);
                else File.WriteAllText(flag, "");
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

        void StartDaemon(bool keepLog = false)
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
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                var bundledFfmpeg = Path.Combine(ExeDir, "ffmpeg", "ffmpeg.exe");
                if (File.Exists(bundledFfmpeg)) psi.EnvironmentVariables["FFMPEG_PATH"] = bundledFfmpeg;
                // Closing stdin asks the daemon to stop its agents and helpers, then exit.
                psi.EnvironmentVariables["RH_STOP_ON_STDIN_EOF"] = "1";
                // Fresh log per start, except after a crash, whose reason must stay readable.
                // The previous run's writer still holds the file open; the next start could not open it otherwise.
                if (log != null) lock (log) log.Dispose();
                var w = log = new StreamWriter(LogPath, keepLog) { AutoFlush = true };
                daemon = Process.Start(psi);
                startedAt = DateTime.Now;
                var started = daemon;
                daemon.EnableRaisingEvents = true;
                daemon.Exited += (s, e) => ui.Post(_ => { if (daemon == started) OnCrash(); }, null);
                DataReceivedEventHandler write = (s, e) => { if (e.Data != null) lock (w) try { w.WriteLine(e.Data); } catch (ObjectDisposedException) { } };
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

        // StopDaemon clears the field first, so an exit that still finds it set was not asked for.
        void OnCrash()
        {
            daemon = null;
            SetRunning(false);
            quickCrashes = (DateTime.Now - startedAt).TotalSeconds < 60 ? quickCrashes + 1 : 1;
            if (quickCrashes >= 3)
            {
                ShowBalloon("PocketDesk keeps stopping. Right-click > Open daemon log to see why, then Resume.");
                return;
            }
            ShowBalloon("PocketDesk stopped unexpectedly; restarting");
            var t = new System.Windows.Forms.Timer { Interval = 3000 };
            t.Tick += (s, e) => { t.Dispose(); if (daemon == null) StartDaemon(true); };
            t.Start();
        }

        void StopDaemon()
        {
            if (daemon == null) return;
            var d = daemon;
            daemon = null;
            try
            {
                d.StandardInput.Close();
                // A daemon that does not finish in time is tree-killed so nothing it started is left behind.
                if (!d.WaitForExit(10000)) KillTree(d.Id);
                d.Dispose();
            }
            catch { }
            SetRunning(false);
            ShowBalloon("daemon stopped");
        }

        static void KillTree(int pid)
        {
            try
            {
                var p = Process.Start(new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F") { CreateNoWindow = true, UseShellExecute = false });
                p.WaitForExit(10000);
            }
            catch { }
        }

        void SetRunning(bool running)
        {
            if (icon != null) icon.Icon = MakeIcon(running ? Color.FromArgb(76, 175, 80) : Color.FromArgb(158, 158, 158));
            if (pauseItem != null) pauseItem.Text = running ? "Pause" : "Resume";
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

        public void ShowPairing()
        {
            LoadConfig();
            OpenUrl(BaseUrl() + "/pair?k=" + Uri.EscapeDataString(token));
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
