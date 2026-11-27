# Alpha capture: letting your own app be mirrored while PocketDesk watches

## Do not use this in proctoring, exam or DRM windows

This handshake must not be used in proctoring, exam or DRM windows. The marker is per-user and
unauthenticated, so anything running as that user can create it, and while it exists the window
lifts `WDA_EXCLUDEFROMCAPTURE` for the whole time any viewer is attached rather than for a single
capture. In a window where a candidate is being invigilated, or where a rights holder asked for
protection, deny the handshake and leave the marker absent: the app keeps its protection on and
PocketDesk shows the black or see-through frame that Windows intends.

## What the two symptoms mean

When a window is mirrored from the phone, one of these shows up instead of the picture:

| What you see | What Windows did |
|---|---|
| **Black** over the app, everything else fine | The window set `WDA_MONITOR` (or `WDA_EXCLUDEFROMCAPTURE`, which the GDI path renders black). |
| **See-through**: the app's area shows the desktop *behind* it | The window set `WDA_EXCLUDEFROMCAPTURE`; DXGI Desktop Duplication drops that window and hands over what is underneath. |

Both are the same OS feature (`SetWindowDisplayAffinity`), and both are correct behaviour: Windows
refuses to capture a window that asked not to be captured, for every capture API (DXGI, GDI,
Windows Graphics Capture). PocketDesk cannot and will not override it for an app that did not ask —
only the owning process may call `SetWindowDisplayAffinity` on its own window.

So the switch is on the app's side. This document is that contract.

## The handshake

While at least one PocketDesk viewer is attached, the daemon keeps a marker file:

```
%LOCALAPPDATA%\PocketDesk\allow-capture
```

* Created when the first viewer starts watching the desktop, and deleted when the last one stops.
* Content is informational JSON: `{"app":"PocketDesk","at":"<ISO time>"}`.
* Per user, not a secret, not authenticated: treat it as "the user is mirroring this PC right now".
* An alpha build of the restricted app polls for it (250–500 ms is plenty) and:

| Marker | App does |
|---|---|
| present | `SetWindowDisplayAffinity(hwnd, WDA_NONE)` — its window becomes capturable |
| gone | `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` — protection back on |

The protection therefore stays on for every normal minute, and is lifted only while the user is
deliberately mirroring from their own phone or browser. That is the point of gating it behind a
marker instead of shipping the app with `WDA_NONE`.

## C# (WinForms / WPF / Unity)

```csharp
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms; // for the timer; Unity: use a coroutine instead

static class CaptureHandshake {
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
    const uint WDA_NONE = 0x0, WDA_EXCLUDEFROMCAPTURE = 0x11;

    static readonly string Marker = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "PocketDesk", "allow-capture");
    static bool? applied;

    public static void Start(IntPtr hwnd, int everyMs = 400) {
        var t = new Timer { Interval = everyMs };
        t.Tick += (_, __) => {
            bool allowed = File.Exists(Marker);
            if (applied == allowed) return;      // no change, no call
            applied = allowed;
            SetWindowDisplayAffinity(hwnd, allowed ? WDA_NONE : WDA_EXCLUDEFROMCAPTURE);
        };
        t.Start();
    }
}
```

Call `CaptureHandshake.Start(this.Handle)` once after the window exists (`Handle` in WinForms/WPF,
`GetActiveWindow()` or the window handle from your renderer in Unity). The first poll applies the
protection; nothing else changes.

## C++ (Win32)

```cpp
#include <windows.h>

static bool gApplied = false, gAllowed = false;   // start "unknown" so the first poll applies

void PollCapturePolicy(HWND hwnd) {
    wchar_t path[MAX_PATH];
    if (!GetEnvironmentVariableW(L"LOCALAPPDATA", path, MAX_PATH)) return;
    std::wstring marker = std::wstring(path) + L"\\PocketDesk\\allow-capture";
    bool allowed = GetFileAttributesW(marker.c_str()) != INVALID_FILE_ATTRIBUTES;
    if (gApplied && allowed == gAllowed) return;
    gAllowed = allowed;
    gApplied = true;
    SetWindowDisplayAffinity(hwnd, allowed ? WDA_NONE : WDA_EXCLUDEFROMCAPTURE);
}
```

Call `PollCapturePolicy(hwnd)` from your existing message/tick loop (e.g. a `WM_TIMER` every 250 ms).

## Two things the handshake does not fix

1. **Exclusive fullscreen.** A game in true exclusive fullscreen (`IDXGISwapChain::SetFullscreenState(TRUE)`,
   Unity's `FullScreenMode.ExclusiveFullScreen`, or a fullscreen-mode swap chain) is not composited by
   DWM at all, so DXGI duplication and GDI both come back black no matter what the affinity says.
   Use borderless windowed fullscreen (`FullScreenMode.FullScreenWindow`, or a borderless `WS_POPUP`
   window sized to the monitor). PocketDesk's H.264 path is DXGI, so it needs a composited window.
2. **HDR / wide-colour content** can look washed out through a non-HDR capture path, which reads as a
   grey or over-bright mirror. Turn HDR off for that display while mirroring, or capture the SDR
   monitor.

## Verifying it

1. On the PC, connect a viewer (the app's Desktop tab, or the hub's Computers page) to this PC.
2. `%LOCALAPPDATA%\PocketDesk\allow-capture` exists while the viewer is attached:

   ```powershell
   Test-Path "$env:LOCALAPPDATA\PocketDesk\allow-capture"   # True while watching
   ```

3. Within half a second of the app's next poll the window is capturable and the mirror shows it.
4. Stop the viewer: the marker is deleted and the app restores `WDA_EXCLUDEFROMCAPTURE` on its next
   poll, so a stray screen recorder on the PC still cannot see it.

The daemon side of this is `DesktopController.setCaptureAllowed()` in `daemon/src/desktop_capture.js`;
it is called from `syncCursor()` in `daemon/src/handlers/remote.js` whenever the viewer count crosses
zero, and `DesktopController.protectedNow()` / the `capture_blocked` event report which focused window
is currently hiding itself.
