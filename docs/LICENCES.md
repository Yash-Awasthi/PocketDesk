# Licences of shipped dependencies

PocketDesk itself is GPL-3.0-or-later: `LICENSE` is the licence text and `NOTICE`
records the copyright, the adapted projects and the components bundled into the
Windows helpers. This page is the per-dependency inventory behind that notice.

Every row says how the licence was established. Rows reading "not verified here"
are not an assertion: no local manifest, registry cache or vendor directory in
this tree states them, so a release must confirm them where it builds.

`daemon/test/gpl-compliance.unit.test.mjs` re-reads the npm table and every
manifest name on each run; the Gradle columns are re-derived from the local
Gradle cache when one is present.

## Daemon (npm)

Licence strings are the `license` field of each installed package, so they are
what the shipped tree actually declares.

| Package | Licence | Pinned in |
| --- | --- | --- |
| `node-pty` | MIT | `daemon/package.json` 1.1.0 |
| `ssh2` | MIT | `daemon/package.json` ^1.17.0 |
| `ws` | MIT | `daemon/package.json` ^8.22.0 |
| `@number0/iroh` | MIT OR Apache-2.0 | `daemon/package.json` ^1.1.0 |
| `@axe-core/playwright` | MPL-2.0 | `daemon/package.json` ^4.14.1 |
| `@playwright/test` | Apache-2.0 | `daemon/package.json` ^1.65.1 |
| `@eslint/js` | MIT | `daemon/package.json` ^10.0.1 |
| `@types/node` | MIT | `daemon/package.json` ^26.6.10 |
| `c8` | ISC | `daemon/package.json` ^12.0.0 |
| `eslint` | MIT | `daemon/package.json` ^10.15.0 |
| `globals` | MIT | `daemon/package.json` ^17.14.0 |
| `prettier` | MIT | `daemon/package.json` ^3.10.1 |
| `typescript` | Apache-2.0 | `daemon/package.json` ^5.9.3 |

## Native helpers (Cargo)

The native workspace has no committed lock file and no vendor directory, so the
crate licences below are not verified from this tree. Our own crates inherit
`license = "GPL-3.0-or-later"` from `native/Cargo.toml`.

| Crate | Version | Licence |
| --- | --- | --- |
| `windows` | 0.62 | not verified here |
| `windows-core` | 0.62 | not verified here |
| `ab_glyph` | 0.2 | not verified here |
| `libc` | 0.2 | not verified here |
| `embed-resource` | 3 (build) | not verified here |
| `vigem-client` | 0.1 | not verified here; `NOTICE` records MIT |
| `pocketdesk-vcam` | path, this tree | GPL-3.0-or-later |
| `pocketdesk-vcam-host` | this tree | GPL-3.0-or-later |
| `pocketdesk-pad` | this tree | GPL-3.0-or-later |

## Android (Gradle)

Licences come from the resolved POM in the local Gradle cache. ML Kit is
distributed under Google's ML Kit terms rather than an open-source licence;
JNA is LGPL-2.1-or-later, which the GPL permits for a dynamically linked library.

| Alias | Module | Version | Licence |
| --- | --- | --- | --- |
| `compose-bom` | `androidx.compose:compose-bom` | 2026.11.01 | The Apache Software License, Version 2.0 |
| `compose-material3` | `androidx.compose.material3:material3` | 1.5.0 | The Apache Software License, Version 2.0 |
| `compose-material-icons-core` | `androidx.compose.material:material-icons-core` | 1.7.8 | The Apache Software License, Version 2.0 |
| `compose-ui` | `androidx.compose.ui:ui` | 1.13.0 | The Apache Software License, Version 2.0 |
| `activity-compose` | `androidx.activity:activity-compose` | 1.13.0 | The Apache Software License, Version 2.0 |
| `core-ktx` | `androidx.core:core-ktx` | 1.19.1 | The Apache Software License, Version 2.0 |
| `lifecycle-runtime-compose` | `androidx.lifecycle:lifecycle-runtime-compose` | 2.12.0-alpha04 | The Apache Software License, Version 2.0 |
| `navigation3-runtime` | `androidx.navigation3:navigation3-runtime` | 1.3.0-alpha02 | The Apache Software License, Version 2.0 |
| `navigation3-ui` | `androidx.navigation3:navigation3-ui` | 1.3.0-alpha02 | The Apache Software License, Version 2.0 |
| `okhttp-bom` | `com.squareup.okhttp3:okhttp-bom` | 5.5.0 | The Apache Software License, Version 2.0 |
| `okhttp` | `com.squareup.okhttp3:okhttp` | 5.5.0 | The Apache Software License, Version 2.0 |
| `iroh-android` | `computer.iroh:iroh-android` | 1.2.0 | MIT |
| `code-scanner` | `com.google.android.gms:play-services-code-scanner` | 16.1.0 | ML Kit Terms of Service |
| `doc-scanner` | `com.google.android.gms:play-services-mlkit-document-scanner` | 16.0.0 | ML Kit Terms of Service |
| `jna` | `net.java.dev.jna:jna` | 5.19.1 | LGPL-2.1-or-later |
| `zxing-core` | `com.google.zxing:core` | 3.5.3 | not resolved in the local Gradle cache (NOTICE records Apache-2.0) |
| `kotlinx-coroutines-android` | `org.jetbrains.kotlinx:kotlinx-coroutines-android` | 1.11.0 | Apache-2.0 |
| `kotlinx-serialization-json` | `org.jetbrains.kotlinx:kotlinx-serialization-json` | 1.13.0 | Apache-2.0 |
| `junit-bom` | `org.junit:junit-bom` | 6.1.3 | Eclipse Public License v2.0 |
| `junit-jupiter` | `org.junit.jupiter:junit-jupiter` | 6.1.3 | Eclipse Public License v2.0 |
| `junit-platform-launcher` | `org.junit.platform:junit-platform-launcher` | 6.1.3 | Eclipse Public License v2.0 |
| `androidx-test-junit` | `androidx.test.ext:junit` | 1.3.0 | The Apache Software License, Version 2.0 |
| `androidx-test-runner` | `androidx.test:runner` | 1.7.0 | The Apache Software License, Version 2.0 |
| `androidx-test-core` | `androidx.test:core` | 1.7.0 | The Apache Software License, Version 2.0 |
| `okhttp-tls` | `com.squareup.okhttp3:okhttp-tls` | 5.5.0 | The Apache Software License, Version 2.0 |
| `compose-ui-test-junit4` | `androidx.compose.ui:ui-test-junit4` | 1.13.0 | The Apache Software License, Version 2.0 |
| `compose-ui-test-manifest` | `androidx.compose.ui:ui-test-manifest` | 1.13.0 | The Apache Software License, Version 2.0 |
| `junit4` | `junit:junit` | 4.13.2 | Eclipse Public License 1.0 |
| `junit-vintage-engine` | `org.junit.vintage:junit-vintage-engine` | 6.1.3 | Eclipse Public License v2.0 |
| `robolectric` | `org.robolectric:robolectric` | 4.18.1 | The MIT License |
| `roborazzi` | `io.github.takahirom.roborazzi:roborazzi` | 1.79.0 | Apache-2.0 |
| `roborazzi-compose` | `io.github.takahirom.roborazzi:roborazzi-compose` | 1.79.0 | Apache-2.0 |
| `benchmark-macro-junit4` | `androidx.benchmark:benchmark-macro-junit4` | 1.5.0 | The Apache Software License, Version 2.0 |
| `benchmark-junit4` | `androidx.benchmark:benchmark-junit4` | 1.5.0 | The Apache Software License, Version 2.0 |
| `uiautomator` | `androidx.test.uiautomator:uiautomator` | 2.4.1 | The Apache Software License, Version 2.0 |

## Bundled and adapted third-party work

`NOTICE` is the authoritative list for code that is not a package dependency:
NectarLink (GPL-3.0-or-later, CC BY 4.0), TwinDesk (GPL-3.0), the Figtree font
(SIL OFL 1.1, `native/vcam/assets/OFL-Figtree.txt`), ZXing (Apache-2.0), the
scrcpy UHID descriptor (Apache-2.0), and the scrcpy-server binary fetched at run
time under Apache-2.0 with a pinned SHA-256.

## Releasing

`docs/RELEASING.md` states the source offer: every artefact of a release is
built from the `vX.Y.Z` tag, and that tag's tree is the corresponding source.
