// PocketDesk menu-bar tray for macOS. macOS has no Task Manager, so this is how the daemon is
// seen and stopped: a status-bar item that starts the hidden daemon at login and offers Pair and
// Stop. Mirrors the Windows launcher. Compiled at install with:
//   swiftc -O PocketDeskTray.swift -o PocketDeskTray
import AppKit

// The control CLI is installed next to this binary and owns start/stop/status/pair.
let control = URL(fileURLToPath: CommandLine.arguments.first ?? "")
    .deletingLastPathComponent().appendingPathComponent("pocketdesk").path

@discardableResult
func run(_ verb: String) -> String {
    let p = Process()
    p.executableURL = URL(fileURLToPath: "/bin/bash")
    p.arguments = [control, verb]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do { try p.run() } catch { return "" }
    p.waitUntilExit()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

final class Tray: NSObject, NSApplicationDelegate {
    let item = NSStatusItem.init(withLength: NSStatusItem.variableLength)
    let statusLine = NSMenuItem(title: "PocketDesk", action: nil, keyEquivalent: "")

    func applicationDidFinishLaunching(_ note: Notification) {
        item.button?.title = "◆"
        item.button?.toolTip = "PocketDesk"
        let menu = NSMenu()
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "Pair a phone…", action: #selector(pair), keyEquivalent: "p").target = self
        menu.addItem(withTitle: "Open log", action: #selector(openLog), keyEquivalent: "l").target = self
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "Stop PocketDesk", action: #selector(stop), keyEquivalent: "s").target = self
        menu.addItem(withTitle: "Quit (keep running)", action: #selector(quit), keyEquivalent: "q").target = self
        menu.delegate = self
        item.menu = menu
        run("start")
        refresh()
    }

    func refresh() { statusLine.title = run("status").hasPrefix("running") ? "● Running" : "○ Stopped" }
    @objc func pair() { run("pair") }
    @objc func openLog() {
        let log = (NSHomeDirectory() as NSString).appendingPathComponent(".pocketdesk/daemon.log")
        NSWorkspace.shared.open(URL(fileURLToPath: log))
    }
    @objc func stop() { run("stop"); refresh() }
    @objc func quit() { NSApp.terminate(nil) }
}

extension Tray: NSMenuDelegate {
    func menuWillOpen(_ menu: NSMenu) { refresh() }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // menu-bar only: no Dock icon, no window
let tray = Tray()
app.delegate = tray
app.run()
