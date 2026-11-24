# Reproducible release build

Two builds of one commit should give the same app. This page records what is
reproducible, what is not, and how to check it.

## Short version

| What you hash | Same across two builds? |
|---|---|
| `sha256sum app-release.apk` | **No** — the APK signing block carries a random salt |
| The zip content (`node app/scripts/apk-content-hash.mjs …`) | **Yes** |
| The unsigned bytes (everything except the signing block) | **Yes** |

So a release check compares the content fingerprint, not the file hash. Changing
`sha256sum` on its own is not a reproducibility failure.

## Measured

Two release builds on 2026-11-24 from the same working tree — one incremental,
one after `./gradlew clean` — with a throwaway key made for the test:

```
build 1 (incremental)  sha256 870fe1a7dbc0e566b5222171358e07adaad92e6809f1b61d190fc42eb7b973e8
build 2 (clean)        sha256 3a94e28486cdf0ebaa620e62d62f4dfd006045e419d2d9db2c24fcd348970e04
```

The file hash differs, so the difference was located rather than assumed:

```
# every zip entry, compared by name / size / CRC-32 / stored time
node app/scripts/apk-content-hash.mjs apk1.apk   -> d187d072a76e7749a72c435775e20237434eba421cd61be462205061d9928245  511 entries
node app/scripts/apk-content-hash.mjs apk3.apk   -> d187d072a76e7749a72c435775e20237434eba421cd61be462205061d9928245  511 entries

# everything except the APK signing block
unsigned content sha256 (both)                   -> a76d5286d2e8f571983f3aaa8e01cb8aca6bac9ff8f773824e7f3ca9170b7d3b
APK signing block start / length (both)          -> 12021512 / 12280
first differing byte                             -> 12022978 (inside the signing block)

apksigner verify --min-sdk-version 30 (both)     -> exit 0
certificate SHA-256 (both)                       -> 61bb67fbbc7c115b5e123280c118018d0b8e4b570185b702e3f1e90f381f565f
```

The first differing byte is inside the signing block, and the certificate in both
blocks is the same. That is expected: APK Signature Scheme v2/v3 signs a **salted**
digest and the 32-byte salt is random per signing run, so two signatures over
identical content never match. Nothing in the build is at fault.

## How to check a build

```bash
cd app
JAVA_HOME=/path/to/jdk21 ./gradlew clean assembleRelease
node scripts/apk-content-hash.mjs app/build/outputs/apk/release/app-release.apk
JAVA_HOME=/path/to/jdk21 ./gradlew clean assembleRelease
node scripts/apk-content-hash.mjs app/build/outputs/apk/release/app-release.apk
```

Same fingerprint twice means the build is reproducible. A different one means
something in the toolchain or the tree changed; compare the two runs' inputs
listed below before looking at the code.

## Inputs that are not pinned by the repository

These are the things that can still make two machines disagree:

- **JDK** — 21.0.12.1 (Temurin) was used. AGP 9.5 accepts 17 and up; a different
  JDK version can change R8 output.
- **Gradle** — pinned by `app/gradle/wrapper/gradle-wrapper.properties` (9.8.1).
- **Android SDK** — platform `android-37.2`, build-tools `37.0.0`. A different
  build-tools version changes zip alignment and therefore the whole file.
- **Dependency resolution** — versions are pinned in
  `app/gradle/libs.versions.toml`, but the artifacts themselves are fetched, not
  vendored. There is no Gradle dependency lockfile yet, so a re-published artifact
  would change the build silently.
- **Keystore** — signing is deterministic given the same key; the salt makes the
  signed bytes differ between runs even with an identical key.
- **Network and time** — the build reads the network; it does not read the clock
  (the APK records no build timestamp, and `META-INF/version-control-info.textproto`
  says `NO_SUPPORTED_VCS_FOUND`, so no commit hash is embedded either).

Gradle's build cache is off the list on purpose: the clean build above reused 24
cached tasks, and a fully cold cache produced the same content fingerprint.

## Related

- `app/scripts/apk-content-hash.mjs` — the fingerprint script.
- `plan.md` M1.4 — the subtask that asked for this.
