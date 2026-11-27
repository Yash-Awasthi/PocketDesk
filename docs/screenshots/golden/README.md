# Golden screenshots of the five screens

Roborazzi runs on the JVM through Robolectric with the iroh actual shimmed out, so golden screenshots need no phone or emulator; 347, 352 and 458 are screenshot-provable the same way.

| PNG | Screen | Composed as |
| --- | --- | --- |
| `connect.png` | Connect | `ConnectScreen(WsClient(), onConnected = {})` |
| `sessions.png` | Sessions | `SessionsScreen(WsClient(), openTerminal = {})` |
| `chat.png` | Chat | `ChatScreen(WsClient(), openTerminal = {})` |
| `ssh.png` | SSH | `SshScreen(WsClient(), onClose = {})` |
| `deck.png` | Deck | `DeckScreen(WsClient(), onClose = {})` |

Each screen gets an unconnected `WsClient`: the state a phone draws before it reaches a PC.

## Running it

```sh
cd app
./gradlew :app:verifyGoldens              # compares, never writes
./gradlew :app:testDebugUnitTest          # same: verify is the default
./gradlew :app:recordGoldens -Pgolden.record=true   # opt in to rewriting the PNGs
```

A diff fails with the PNG name, for example
`golden screenshots/ssh.png differs from docs/screenshots/golden/ssh.png`.
Verify mode never touches the checked-in file; it writes the rejected render under
`app/app/build/outputs/roborazzi/`.

Goldens are captured on Windows. Robolectric's native graphics can rasterise text
differently on another OS, so the harness is not wired into the Linux CI job yet; a
Linux golden set would be a second directory, not a looser comparison.

## The pinned configuration

`@Config(sdk = [34], qualifiers = "en-rUS-w412dp-h915dp-port-notnight-xxhdpi")`,
`@GraphicsMode(NATIVE)`, `Locale.US`, `TimeZone` UTC, and a plain light
`MaterialTheme` around each screen. Changing any of these changes every image.
None of the five screens prints a clock in the captured state, so the clock is not
pinned further.

## Why there is an iroh shim

`src/main/.../IrohLink.kt` imports `computer.iroh` and loads `libiroh_ffi.so`. The
screens reach it through `WsClient`, and the manifest's `RhApp.onCreate` calls
`IrohLink.Node.init`, so a host-side run died with
`UnsatisfiedLinkError: no iroh_ffi in java.library.path`.

`app/app/src/test/java/com/yasha/pocketdesk/IrohLink.kt` is the same fully-qualified
name in the test source set, so the unit-test class path puts it ahead of the real
one. It keeps the exact surface `WsClient` and `RhApp` use and does nothing: no native
library, no endpoint, no dial. The device actual is unchanged. Android has one target,
so `expect`/`actual` cannot express this directly; the two source sets are the two
actuals, and the test file must be kept in step with `src/main/.../IrohLink.kt`.
