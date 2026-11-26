# Dependency maintenance

PocketDesk pins three sets of dependencies: the daemon npm packages, the native
Cargo crates and the Android Gradle version catalog. This page is the procedure
and the inventory. The result of every pass is written to
docs/dependency-log.md.

## Cadence

- Monthly: once a month, in the first working week. One person runs the pass
  and one other person reviews it.
- The runner executes every command in `Commands` below on a clean checkout and
  reads the output by hand. Nothing is auto-merged.
- A pass that changes any version must re-run the affected suites and record the
  result in docs/dependency-log.md before the change is merged.
- A pass that changes nothing still records the check: the log entry says what
  was run and that the decision was to keep everything.
- Security findings from `npm audit` are triaged in the same entry. A dev-only
  finding whose only fix is a breaking downgrade is recorded as deferred, with
  the reason.

## Inventory

Versions below are what is pinned in the manifests, not what npm or Gradle
resolved on a particular machine. npm resolves the caret ranges in
daemon/package-lock.json; the native workspace has no committed lock file, so
Cargo resolves on build.

### Daemon (npm)

| Dependency | Pinned in | Version |
| --- | --- | --- |
| node-pty | daemon/package.json | 1.1.0 |
| ssh2 | daemon/package.json | ^1.17.0 |
| ws | daemon/package.json | ^8.22.0 |
| @number0/iroh | daemon/package.json (optionalDependencies) | ^1.1.0 |
| @eslint/js | daemon/package.json (devDependencies) | ^10.0.1 |
| @types/node | daemon/package.json (devDependencies) | ^26.6.10 |
| c8 | daemon/package.json (devDependencies) | ^12.0.0 |
| eslint | daemon/package.json (devDependencies) | ^10.15.0 |
| globals | daemon/package.json (devDependencies) | ^17.14.0 |
| prettier | daemon/package.json (devDependencies) | ^3.10.1 |
| typescript | daemon/package.json (devDependencies) | ^5.9.3 |

The resolved tree is recorded in daemon/package-lock.json. node-pty is a native
module and is allow-listed for its install script in daemon/package.json.

`typescript` and `@types/node` are dev-only and exist for the JSDoc type check:
`npm run typecheck` runs `tsc --checkJs --noEmit` over `src/` (row 250, commit
`688ae36`), where TypeScript is the checker and `@types/node` supplies the Node API
typings it reads. Neither is loaded by the shipped daemon.

### Native (Cargo)

The workspace pins shared crates once in native/Cargo.toml. Member crates are
native/vcam/Cargo.toml, native/vcam-host/Cargo.toml and native/pad/Cargo.toml.
The helpers are Windows-only.

| Dependency | Pinned in | Version |
| --- | --- | --- |
| windows | native/Cargo.toml ([workspace.dependencies]) | 0.62 |
| windows-core | native/Cargo.toml ([workspace.dependencies]) | 0.62 |
| ab_glyph | native/vcam/Cargo.toml ([dependencies]) | 0.2 |
| libc | native/vcam/Cargo.toml ([target.'cfg(unix)'.dependencies]) | 0.2 |
| embed-resource | native/vcam/Cargo.toml ([build-dependencies]) | 3 |
| vigem-client | native/pad/Cargo.toml ([target.'cfg(windows)'.dependencies]) | 0.1 |
| pocketdesk-vcam | native/vcam-host/Cargo.toml ([dependencies], path = "../vcam") | path |

native/vcam-host/Cargo.toml also takes windows and windows-core from the
workspace table.

### Android (Gradle version catalog)

Every version alias in the `[versions]` block of app/gradle/libs.versions.toml.

| Alias | Pinned in | Version |
| --- | --- | --- |
| agp | app/gradle/libs.versions.toml | 9.5.2 |
| kotlin | app/gradle/libs.versions.toml | 2.4.21 |
| composeBom | app/gradle/libs.versions.toml | 2026.11.01 |
| activity | app/gradle/libs.versions.toml | 1.13.0 |
| coreKtx | app/gradle/libs.versions.toml | 1.19.1 |
| lifecycle | app/gradle/libs.versions.toml | 2.11.1 |
| navigation3 | app/gradle/libs.versions.toml | 1.2.2 |
| okhttp | app/gradle/libs.versions.toml | 5.5.0 |
| coroutines | app/gradle/libs.versions.toml | 1.11.0 |
| serialization | app/gradle/libs.versions.toml | 1.13.0 |
| iroh | app/gradle/libs.versions.toml | 1.1.0 |
| jna | app/gradle/libs.versions.toml | 5.19.1 |
| codeScanner | app/gradle/libs.versions.toml | 16.1.0 |
| docScanner | app/gradle/libs.versions.toml | 16.0.0 |
| zxing | app/gradle/libs.versions.toml | 3.5.3 |
| junit | app/gradle/libs.versions.toml | 6.1.3 |
| androidxTestJunit | app/gradle/libs.versions.toml | 1.3.0 |
| androidxTestRunner | app/gradle/libs.versions.toml | 1.7.0 |

The catalog only carries stable lines; a pre-release entry must carry a
`# prerelease:` note on its line, as the comment at the top of the file says.

## Commands

Daemon, from the repo root:

```sh
cd daemon && npm outdated
npm audit --omit=dev
npm audit
```

`npm outdated` exits non-zero when anything is behind, so read the table rather
than the exit code. `npm audit --omit=dev` reports what a user install actually
ships; plain `npm audit` covers the dev tooling too.

Native, from the repo root:

```sh
cd native && cargo update --dry-run
```

`cargo-outdated` is not installed here, so `cargo update --dry-run` is the
available read-only check: it lists the crates that would move and the versions
it would pick. It needs the crates.io index, so a machine without network
records the failure as the result.

Android, from the repo root:

```sh
cd app && ./gradlew :app:dependencies --configuration releaseRuntimeClasspath --no-daemon
```

There is no Gradle versions plugin installed, so the versions themselves are
read from app/gradle/libs.versions.toml; the Gradle command only resolves the
release runtime classpath so the tree behind those aliases is visible.

## Recording

Every pass appends one entry to docs/dependency-log.md with:

- the date, and the commit that was checked (`git rev-parse --short HEAD`);
- each command that was run and its real result, pasted output included, or the
  real failure if it failed;
- the decision: bump to a named version, or keep everything, with the reason;
- the suite result for anything that was touched, or a plain statement that the
  full suite was not re-run and which tests were already failing.

The entry is committed with the change it describes, or on its own when nothing
changed. A log entry is never edited to match a later result; a new entry is
appended.

## Rollback

Each release ships three artifacts (daemon, APK, native helpers). They share one
version: `VERSION`, the `## x.y.z` section in CHANGELOG.md and the three
components move together, as docs/RELEASING.md describes. A tag must never
point at a tree whose `VERSION` differs. Never roll back one artifact to a
different release than the others.

### Daemon

Windows: re-run the installer with the older tag.

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Ref vX.Y.Z
```

install.ps1 downloads
github.com/Yash-Awasthi/PocketDesk/archive/refs/tags/<tag>.zip, copies the
daemon over the install, runs `npm ci --omit=dev` and restarts the service.
Settings, keys and paired phones in `%USERPROFILE%\.pocketdesk` are kept.

macOS and Linux: install.sh clones master and has no ref flag, so roll back in
the existing checkout and restart the service.

```sh
git -C <install>/app checkout vX.Y.Z
<install>/bin/pocketdesk stop
<install>/bin/pocketdesk start
```

On macOS the LaunchAgent restarts the daemon; on Linux it is the systemd user
unit. Re-run `npm install` in `<install>/app/daemon` if package.json differs
between the two tags.

### APK

Install the previous release's APK asset from its GitHub release. `versionCode`
is forward-only: daemon/test/android-ci.unit.test.mjs fails a rewind, so the
installer will not replace a newer build with an older one. A downgrade
therefore needs the current app uninstalled first, and uninstalling drops the
app's local data (paired hosts, settings). Re-pair after installing the older
APK.

### Native helpers

The webcam and controller helpers ship as PocketDesk-native-win-x64.zip, built
by the `native` job in .github/workflows/ci.yml from the same tag. To roll back,
download that asset from the tag you want and unpack it over
`<install>\app\native` (install.ps1 does this from the release it installs). Do
not mix a helper zip with another release: the helper and the daemon speak the
same local protocol, and a mismatch fails at runtime.
