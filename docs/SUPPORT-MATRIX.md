# Support matrix

PocketDesk supports the platforms below. CI runs the hidden daemon test suite on Windows, macOS and Linux, builds the Android app, and builds the Windows native helpers. CI runners are servers and emulators, so desktop capture, input injection, autostart and the native drivers are checked by hand as noted in the last column.

| Platform | Minimum supported | What CI proves | Not proven by CI |
|---|---|---|---|
| Windows 10/11 | Windows 10 or 11, x64. The virtual camera needs Windows 11. | Daemon test suite on windows-latest; native helpers build and test on windows-latest. | Desktop capture, SendInput, ConPTY, tray and the Task Scheduler task are not exercised on a real desktop. Native helpers are Windows only: the virtual camera needs Windows 11 Media Foundation and the pad needs the ViGEmBus driver. Check with `pocketdesk --status`. |
| macOS 12+ | macOS 12 (Monterey) or newer. | Daemon test suite on macos-latest. | Screen Recording and Accessibility permissions, ScreenCaptureKit capture and the LaunchAgent are not exercised. The installer is not notarized. Check with `sw_vers -productVersion` and `pocketdesk --status`. |
| Linux X11 | A Linux desktop with X11/Xorg. Wayland is not supported for screen capture. | Daemon test suite on ubuntu-latest. | X11 capture, xdotool input, the systemd user service and the Wayland warning are not exercised on a desktop. Check with `echo $XDG_SESSION_TYPE` and `pocketdesk --status`. |
| Android 11+ (API 30) | Android 11 (API 30) or newer. | lintDebug, testDebugUnitTest, assembleDebug, a signed release APK on non-PR runs, and connectedDebugAndroidTest on API 30 and API 37 emulators. | Physical-device camera, QR scanning and real network conditions are not exercised. Check with `adb shell getprop ro.build.version.sdk`. |

## Android note

Android 8-10 are not supported because `minSdk` is 30. The earlier Android 8 target is not met. Lowering `minSdk` is a separate change and needs its own test pass.
