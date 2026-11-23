using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

// The tray icon is the one place the running install shows itself: what it is, how to open it, how to
// stop it and how to remove it. It lives as long as the daemon it was started with, so the icon never
// claims PocketDesk is running after it stopped.
namespace PocketDeskLauncher
{
    internal sealed class Tray : ApplicationContext
    {
        readonly NotifyIcon icon;
        readonly string port;
        readonly Process daemon;
        readonly Timer poll = new Timer();

        public Tray(string port, Process daemon)
        {
            this.port = port;
            this.daemon = daemon;

            var menu = new ContextMenuStrip();
            menu.Items.Add("Open PocketDesk", null, (s, e) => Program.OpenPairingPage(port));
            menu.Items.Add("Stop PocketDesk", null, (s, e) => Stop());
            menu.Items.Add("Uninstall PocketDesk…", null, (s, e) => { Stop(); Program.RunUninstaller(); Exit(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Remote access is on") { Enabled = false });

            Icon appIcon;
            try { appIcon = Icon.ExtractAssociatedIcon(Path.Combine(Program.ExeDir, "PocketDesk.exe")) ?? SystemIcons.Application; }
            catch { appIcon = SystemIcons.Application; }

            icon = new NotifyIcon
            {
                Icon = appIcon,
                Text = "PocketDesk — your PC can be reached from your phone",
                ContextMenuStrip = menu,
                Visible = true,
            };
            icon.DoubleClick += (s, e) => Program.OpenPairingPage(port);

            // One notice per install, at the first logon after it: the user is told it is running, once.
            var notice = Path.Combine(Program.DataDir, "tray-notified");
            if (!File.Exists(notice))
            {
                icon.ShowBalloonTip(10000, "PocketDesk is running",
                    "Your PC can be reached from your phone. Right-click this icon to open or stop it.", ToolTipIcon.Info);
                try { File.WriteAllText(notice, DateTime.UtcNow.ToString("o")); } catch { }
            }

            poll.Interval = 1000;
            poll.Tick += (s, e) => { if (daemon != null && daemon.HasExited) Exit(); };
            poll.Start();
        }

        /** A stop from the tray is the same stop as `pocketdesk stop`: nothing restarts it. */
        void Stop()
        {
            if (!Program.RequestStop(port)) return;
            Exit();
        }

        void Exit()
        {
            poll.Stop();
            icon.Visible = false;
            icon.Dispose();
            ExitThread();
        }
    }
}
