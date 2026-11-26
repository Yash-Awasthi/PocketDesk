# Releasing PocketDesk

`VERSION` at the repo root is the single source of the release version. The
daemon reads it through `daemon/src/version.js`, the APK carries the same string
as `versionName`, and the native workspace takes its version from
`native/Cargo.toml`.

## Steps

1. Bump `VERSION` (for example `0.11.0` to `0.12.0`).
2. Set the same string in `app/app/build.gradle.kts` as `versionName`, and add
   one to `versionCode`. A build number is never reused or rewound;
   `daemon/test/android-ci.unit.test.mjs` reads the build file from history and
   fails when it goes backwards or when the file does not carry the newest one.
3. Set `version` under `[workspace.package]` in `native/Cargo.toml` to the same
   string. The helper crates inherit it.
4. Add a `## x.y.z` section to `CHANGELOG.md`, newest first, with at least one
   `- ` line. Headings must be semver, unique and strictly descending.
5. Run the release check and the normal suites:

   ```sh
   cd daemon && node --test test/release-version.unit.test.mjs
   cd daemon && npm test
   ```

6. Commit, tag `vX.Y.Z`, and build every artifact (daemon, APK, native helpers)
   from that tag. A tag must never point at a tree whose `VERSION` differs.

## SBOM

Every push builds a CycloneDX BOM for each artefact and uploads both as the `sbom`
workflow artefact:

- `daemon/sbom/daemon.cdx.json` comes from `daemon/package-lock.json` with
  `--omit dev`, so it lists exactly what a user installs. The committed copy is
  checked against the lock file by `daemon/test/supply-chain.unit.test.mjs`;
  regenerate it with the command in that workflow after a dependency bump.
- `app/app/build/reports/pocketdesk-apk-sbom.json` comes from the Gradle
  `releaseRuntimeClasspath`, so it lists the libraries the APK actually ships,
  not test or debug jars.

A release attaches those two files next to the binaries and the checksums it
publishes.

## Source offer (GPL-3.0-or-later)

PocketDesk is distributed under the GNU GPL, version 3 or later, so every binary
it publishes carries its corresponding source. The offer is the tag itself:

- Every artefact of a release (daemon, APK, native helpers, checksums) is built
  from the tag `vX.Y.Z`, and nothing is published from a working tree that
  differs from that tag.
- The corresponding source is the tree that tag names, at
  `https://github.com/Yash-Awasthi/PocketDesk/archive/refs/tags/vX.Y.Z.tar.gz`,
  and the release notes link it next to each binary.
- A downstream build that patches the tag publishes the patch as a further tag
  and links that tag's archive with the binary. A binary whose source is not
  reachable this way is not a release.
- `LICENSE` (GPL-3.0) and `NOTICE` (copyright, adapted projects, bundled
  components) travel with the source and the binaries; the per-dependency
  inventory is `docs/LICENCES.md`.
- The release check in step 5 fails when `VERSION`, `versionName` and the
  native workspace version disagree, so a mis-tagged source cannot be published
  beside a binary.

`daemon/package.json` is private npm tooling metadata (`"private": true`) and is
never published to a registry, so its `version` field is not the product
version. The shipped daemon version is `VERSION`, printed by
`pocketdesk --version`.
