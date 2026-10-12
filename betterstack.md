# Better Stack: PocketDesk

Upgrade plan built from the code itself (`daemon/src`, `daemon/test`, `app/app/build.gradle.kts`, the Kotlin sources, installers and CI). Target versions were read from npm, nodejs.org, Google Maven, Maven Central and Gradle on 2026-10-12. "Newest" includes alpha/beta/RC builds; "Stable" is the newest final release.

## What the code actually uses

**Daemon (`daemon/`, ESM JavaScript, ~10k lines)**

- Almost everything is Node built-ins: `node:fs` (30 imports), `node:child_process` (19, about 50 spawn/exec call sites), `node:crypto` (TLS certs via `generateKeyPairSync` + `X509Certificate`, TOTP), `node:http(s)`, `node:net`.
- Three runtime packages: `ws` (WebSocket server), `ssh2` (bastion, SSH/SFTP client, VNC tunnel), `node-pty` (terminal sessions). `@number0/iroh` is optional and dynamically imported (`iroh_link.js`).
- ffmpeg is spawned for the H.264 desktop stream (`desktop_video.js`) and screen recording (`recorder.js`).
- State is JSON files written with `fs.writeFileSync`: 23 writes, only 4 `renameSync` calls, so most writes are not atomic.
- Tests already use `node:test` and run through a custom runner (`scripts/run-tests.js`).
- `engines.node` is `>=18` and `install.sh` accepts Node 18. Node 18 and 20 are both end-of-life.

**Android app (`app/`, Kotlin + Compose, ~7k lines)**

- 100% Compose. Navigation is a hand-rolled `rememberSaveable` `Screen` state in `MainActivity.kt`.
- OkHttp 4 WebSocket client (`WsClient.kt`, 1.1k lines) with custom TLS handling.
- `kotlinx.serialization.json` used as a JSON tree API (36 imports); the serialization compiler plugin is not applied.
- iroh-android 1.1.0 plus JNA 5.19.1 for 16 KB page-aligned native libs.
- Lifecycle is used directly only in `DesktopScreen.kt` (`LifecycleEventObserver`).

## Daemon upgrades

| Item | Current | Stable | Newest | Pick | Notes |
|---|---|---|---|---|---|
| Node.js runtime | `>=18` | 24.21.0 LTS (Krypton) | 26.11.1 Current | **26.x** (goes LTS this month), floor `>=24` | Raise `engines`, `install.sh` check and CI `node-version` together |
| `ws` | ^8.18.0 | 8.22.0 | 8.22.0 | **8.22.0** | Node has a built-in WebSocket client but no server, so `ws` stays |
| `ssh2` | ^1.17.0 | 1.17.0 | 1.17.0 | keep | Still the only full SSH2 server + client in JS |
| `node-pty` | ^1.0.0 | 1.1.0 | 1.2.0-beta.15 | **1.2.0-beta.15** | Update the `allowScripts` key (`node-pty@1.1.0`) to match, or install will skip its build |
| `@number0/iroh` | ^1.1.0 | 1.1.0 | 1.1.0 | keep | Already the latest; keep it in lockstep with `iroh-android` |

Code changes worth making once Node ≥ 24 is the floor:

- **Atomic state writes.** Replace bare `writeFileSync` on config and session files with write-to-temp + `renameSync` (the pattern already exists in 4 places), or move `session-store.js` and the registry onto built-in `node:sqlite` (no flag needed on current Node). A crash mid-write today can corrupt the store.
- **Native TypeScript.** Node 24+ runs `.ts` files directly (type stripping), with no build step. The daemon could migrate one module at a time (`protocol` types first, shared with `Protocol.kt` via the contract test) without adding a compiler.
- **Built-in test runner features.** `scripts/run-tests.js` spawns each file by hand. `node --test --test-isolation=process test/` does the same with parallelism and a TAP/JUnit reporter; keep the `RH_HOME` env through `--env-file` or the runner's `env` option.
- **Permission model.** `node --permission --allow-fs-read=… --allow-child-process` can fence the daemon. It spawns a lot of processes, so treat this as defence in depth for the plugin system (`plugins.js`), not a sandbox.
- `daemon/public/vendor/qrcode.min.js` (2.3k lines, vendored) has no version pin. Record its upstream version in a header, or generate the QR server-side with the `qrcode` package.

## Android upgrades

| Item | Current | Stable | Newest | Pick |
|---|---|---|---|---|
| Gradle wrapper | 9.3.1 | 9.8.1 | 9.8.1 | **9.8.1** |
| Android Gradle Plugin | 8.13.1 | 9.4.1 | 9.5.0-alpha09 | **9.5.0-alpha09** (fallback 9.4.1) |
| Kotlin + Compose compiler plugin | 2.1.20 | 2.4.21 | 2.5.0-Beta1 | **2.5.0-Beta1** (fallback 2.4.21) |
| JDK | 17 | 25 LTS | 27 | **25** for the build, bytecode target 21 |
| compileSdk / targetSdk | 36 / 36 | 37 | 37 | **37 / 37** |
| Compose BOM | 2024.09.02 | 2026.09.00 | 2026.10.00 (`compose-bom-alpha`) | **2026.10.00 alpha** (Material 3 1.5.0-beta01) |
| `activity-compose` | 1.9.2 | 1.13.0 | 1.14.0-alpha03 | **1.14.0-alpha03** |
| `core-ktx` | 1.13.1 | 1.19.1 | 1.19.1 | **1.19.1** |
| `lifecycle-runtime-ktx` | 2.8.6 | 2.11.0 | 2.12.0-alpha04 | **2.12.0-alpha04** + `lifecycle-runtime-compose` |
| OkHttp | 4.12.0 | 5.5.0 | 5.5.0 | **5.5.0** |
| kotlinx-coroutines | 1.9.0 | 1.11.0 | 1.11.0 | **1.11.0** |
| kotlinx-serialization-json | 1.7.3 | 1.11.0 | 1.12.0-RC | **1.12.0-RC** |
| iroh-android | 1.1.0 | 1.1.0 | 1.1.0 | keep |
| JNA | 5.19.1 | 5.19.1 | 5.19.1 | keep |
| Unit tests | JUnit 4.13.2 | JUnit Jupiter 6.1.3 | 6.1.3 | **JUnit 6** |
| Navigation | hand-rolled `Screen` state | Navigation 3 1.2.0 | 1.3.0-alpha02 | **Navigation 3** |

Notes tied to this code:

- **AGP 9** compiles Kotlin itself. Drop `org.jetbrains.kotlin.android` from both build files, and replace `kotlinOptions { jvmTarget = "17" }` with `kotlin { compilerOptions { jvmTarget = JvmTarget.JVM_21 } }`.
- **OkHttp 5** keeps the `okhttp3` package, so `WsClient.kt` compiles mostly unchanged. Check the custom TLS paths (`sslSocketFactory` / trust manager) against the 5.x API, and use the new `okhttp-bom` so the version is declared once.
- **Navigation 3** fits the existing design. `MainActivity` already keeps a sealed `Screen` in saveable state. Nav3 turns that into a back stack (`rememberNavBackStack`) with real back handling and per-screen saved state, replacing the custom `ScreenSaver`.
- `DesktopScreen.kt` wires `LifecycleEventObserver` by hand. `LifecycleResumeEffect` / `LifecycleStartEffect` from `lifecycle-runtime-compose` do the same with less code.
- Move every coordinate into `gradle/libs.versions.toml`. Today versions are inline strings in two build files, and Ping already uses a catalog.
- Enable `org.gradle.configuration-cache=true` and `org.gradle.caching=true` in `app/gradle.properties`.

## CI (`.github/workflows/ci.yml`)

| Action | Current | Latest |
|---|---|---|
| `actions/checkout` | v4 | v7.0.1 |
| `actions/setup-node` | v4, Node 22 | v7.1.0, Node 26 (plus 24 in a matrix while 24 is the floor) |
| `actions/setup-java` | v4, JDK 17 | v6.0.1, JDK 25 |
| `actions/upload-artifact` | v4 | v7.0.2 |

Add `gradle/actions/setup-gradle@v6` for build caching; the Android job currently has none.

## Order of work

1. Raise the Node floor to 24 (`engines`, `install.sh`, `install.ps1` already pulls current LTS) and move CI to Node 24 + 26.
2. Make JSON state writes atomic, or move them to `node:sqlite`.
3. Bump `ws` and `node-pty` (update `allowScripts`); run `npm test`.
4. Android: version catalog, then Gradle 9.8.1 + JDK 25 + AGP 9 + Kotlin 2.5.
5. Compose BOM, activity, lifecycle, core-ktx, coroutines, serialization.
6. OkHttp 5 and a manual test of TLS pairing plus the iroh fallback path.
7. Navigation 3, then targetSdk 37.

Each step should leave `npm test` and `./gradlew lintDebug testDebugUnitTest assembleDebug` green.
