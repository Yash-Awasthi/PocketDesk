# True exclusive fullscreen: what can be captured, and what PocketDesk does

## The problem, in one paragraph

An app in **true exclusive fullscreen** asks the GPU for exclusive ownership of the display
(`IDXGISwapChain::SetFullscreenState(TRUE)` with a mode switch, or the legacy D3D9/OpenGL/Vulkan
equivalent). DWM steps out of the way and the app’s frames go straight to the scanout hardware. From
that moment there is **no composed desktop surface to read**: Desktop Duplication returns
`DXGI_ERROR_ACCESS_LOST`, GDI `CopyFromScreen` and `BitBlt` return black, and Windows Graphics Capture
— which asks DWM for a window’s composed visual — gets nothing. This is the documented behaviour of
the OS, not a permissions problem: running as Administrator or SYSTEM changes nothing, because the
data was never in a place a user-mode API can read.

## The four ways to get those pixels (researched)

| Path | Works on true exclusive? | Why / why not |
|---|---|---|
| **Desktop Duplication** (`IDXGIOutputDuplication`, what `ddagrab` uses) | **No** | Microsoft: `AcquireNextFrame` returns `DXGI_ERROR_ACCESS_LOST` while "a different type of image is displayed … other full-screen application"; the duplication must be recreated, and until the app releases the display there is nothing to duplicate. |
| **GDI / `BitBlt` / `CopyFromScreen`** (the JPEG fallback) | **No** | Reads the composed desktop, which is suspended. |
| **Windows Graphics Capture** (WinRT, per window or per monitor) | **No** for true exclusive | WGC lives inside the DWM composition pipeline: "when a game runs in Exclusive Fullscreen, it may present frames directly to the display and bypass the normal desktop composition flow … there may be no composed desktop surface available for WGC to capture" (Microsoft Q&A). It does work for borderless and for eFSE. |
| **NVIDIA NVFBC** (driver-level framebuffer capture) | Used to | Deprecated by NVIDIA on Windows 10+ ("last supported Windows 10 version is 1803, build 17134"); not usable on current drivers. |
| **A kernel mirror driver** (an IddCx/mirror display driver owned by PocketDesk) | **Yes** | It sits below the compositor, so it sees the scanout. Needs a Microsoft-signed kernel driver per architecture, WHQL/attestation signing and a driver install — not something an installed app can ship. |
| **In-process API hooking** ("game capture": inject a DLL and hook `IDXGISwapChain::Present`, `wglSwapBuffers` or `vkQueuePresentKHR`, then share the back buffer) | **Yes** | The hook runs inside the game, at the moment it presents, before the image bypasses anything. This is how OBS’s Game Capture source works. Costs: a per-API hook, DLL injection into another process, antivirus false positives and anti-cheat bans, and it must be per game. |

So, in user mode, **there are exactly two working answers: a signed kernel driver, or hooking the
game process.** PocketDesk deliberately ships neither: it is an installed remote-desktop app,
visible to the machine it runs on and blockable by its owner, with no driver, no process hooking
and no attempt to look like something it is not (see [INTEGRITY.md](INTEGRITY.md)). Every other
route is the OS saying no.

## What PocketDesk does instead — implemented

1. **Detects it precisely.** The capture helper calls `SHQueryUserNotificationState`:
   `QUNS_RUNNING_D3D_FULL_SCREEN` (3) means a D3D app owns the display. `fullscreenNow()` exposes
   `{ d3d, state, title, pid, w, h }` to the daemon.
2. **Never freezes.** The stall watchdog notices that no frame arrived for 6 s, asks whether a true
   exclusive app is in front, and answers in three ways:
   - a **`desktop_notice`** naming the window and saying exactly why it is black (with the fix below);
   - the stream **switches to all screens** through GDI, so every other monitor stays live and the
     game’s own screen is the only dark area — instead of a frozen picture of nothing;
   - the encoder is **retried every 400 ms**, and when `QUNS` reports the game has let go, the
     stream switches back to the screen the viewer picked and re-sends a keyframe. Recovery is
     instant, not "reconnect to fix it".
3. **Turns the game into something capturable.** A game only takes the display exclusively if it is
   allowed to: when Windows **fullscreen optimizations** are on for that executable it is presented
   as an emulated exclusive (eFSE, an independent flip the compositor still owns) and Desktop
   Duplication captures it normally. Windows stores a per-exe "Disable fullscreen optimizations"
   flag; the helper clears it:

   ```powershell
   # look: what is running, and which titles asked to bypass the compositor
   powershell -ExecutionPolicy Bypass -File daemon\scripts\fullscreen-capture.ps1
   # fix one title (game closed, then start it again)
   powershell -ExecutionPolicy Bypass -File daemon\scripts\fullscreen-capture.ps1 -Exe "C:\Games\Riddle\game.exe" -EnableOptimizations
   # undo
   powershell -ExecutionPolicy Bypass -File daemon\scripts\fullscreen-capture.ps1 -Exe "C:\Games\Riddle\game.exe" -DisableOptimizations
   ```

   The other one-line fix is the game’s own setting: **borderless / windowed fullscreen**.

4. **Knocks a title out of exclusive in place**, for games that honour the standard toggle:

   ```powershell
   powershell -ExecutionPolicy Bypass -File daemon\scripts\fullscreen-capture.ps1 -ToWindowed
   ```

   It sends Alt+Enter to the exclusive app, re-reads `SHQueryUserNotificationState` and reports
   whether the display came back to the compositor. When it did, the mirror picks the game up within
   a second (the 400 ms retry). When the title ignores the key, nothing else changes.

## How to check what you have

With the game open, on the PC:

```powershell
powershell -ExecutionPolicy Bypass -File daemon\scripts\fullscreen-capture.ps1
```

- `state 2` → composed fullscreen: the mirror shows it.
- `state 3` → true exclusive: the mirror shows everything except that screen, and says so.

## Honest limits

- The game’s own pixels in true exclusive mode are **not mirrored**, and cannot be without a signed
  kernel driver or in-process hooking. What PocketDesk guarantees is that this never leaves you with
  a dead or frozen mirror: you get the rest of the desktop, a precise reason, and the stream snaps
  back the moment the game releases the display.
- Modern D3D11/D3D12 titles that call themselves "fullscreen" usually go through eFSE, which is
  captured; the hard cases are D3D9, OpenGL (Minecraft Java, osu!), Vulkan titles, and any title
  where fullscreen optimizations were disabled. Windows 11 24H2 also made the duplication fall over
  for those more aggressively (OBS tracks this in issue #14021).
- HDR on that display can still wash out through an SDR encode; turn HDR off while mirroring.

## References

- `IDXGIOutputDuplication::AcquireNextFrame` return values — <https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutputduplication-acquirenextframe>
- WGC and exclusive fullscreen (Microsoft Q&A, 2026) — <https://learn.microsoft.com/en-us/answers/questions/5791521/wgc-capturing-exclusive-fullscreen-games-apps>
- WGC vs DDA limits, "DDA can capture full screen games that take ownership of the monitor" — <https://github.com/robmikh/Win32CaptureSample/issues/46>
- NVFBC deprecation on Windows 10+ — <https://developer.nvidia.com/capture-sdk>
- OBS display capture freezing on 24H2 exclusive fullscreen — <https://github.com/obsproject/obs-studio/issues/14021>
- Capture techniques compared (game-process hooking reaches exclusive fullscreen) — <https://ryanzh.me/en/blog/pc-window-capture>
