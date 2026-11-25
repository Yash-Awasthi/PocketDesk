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

`daemon/package.json` is private npm tooling metadata (`"private": true`) and is
never published to a registry, so its `version` field is not the product
version. The shipped daemon version is `VERSION`, printed by
`pocketdesk --version`.
