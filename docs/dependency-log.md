# Dependency log

One entry per pass, newest first. Each entry records what was run and what was
decided; an entry is never rewritten, a new one is appended.

## 2026-11-26

Commit checked: `aaa29f8` (`git rev-parse --short HEAD`). This entry lands in the
next commit, so it describes that commit's parent tree.

### Daemon (npm)

`cd daemon && npm outdated`

```
Package        Current  Wanted  Latest  Location                    Depended by
@number0/iroh    1.1.0   1.2.0   1.2.0  node_modules/@number0/iroh  daemon
ws              8.22.0  8.23.0  8.23.0  node_modules/ws             daemon
```

`npm audit --omit=dev`

```
found 0 vulnerabilities
```

So nothing a user install ships is currently flagged.

`npm audit`

```
glob  9.0.0 - 14.0.1
Severity: moderate
Glob: AbortSignal cancellation bypass allows post-timeout filesystem traversal
Depends on vulnerable versions of minimatch
fix available via `npm audit fix --force`
Will install c8@9.1.0, which is a breaking change

minimatch  7.0.0 - 11.0.0
Severity: moderate
minimatch has potential denial of service via globparts amplification
fix available via `npm audit fix --force`
Will install c8@9.1.0, which is a breaking change

4 moderate severity vulnerabilities
```

Both chains are dev-only: c8 > test-exclude > glob/minimatch. No runtime
package is affected.

### Native (Cargo)

`cd native && cargo update --dry-run`

```
    Updating crates.io index
     Locking 48 packages to highest Rust 1.97 compatible versions
      Adding windows-core v0.62.2 (available: v0.100.0)
```

The only crate the index would move is windows-core, within the pinned 0.62
line. The 0.100.0 line is not compatible with the `windows` 0.62 pin in
[workspace.dependencies], so nothing is proposed. The dry-run still wrote an
untracked native/Cargo.lock; it was removed after the check and is not
committed (the workspace keeps no lock file).

### Android (Gradle catalog)

Read-only read of app/gradle/libs.versions.toml: 18 version aliases, all pinned
to stable lines, matching docs/DEPENDENCIES.md. The Gradle
`:app:dependencies` resolve was not run in this pass because no Android version
was proposed, so there was nothing new to resolve. There is no Gradle versions
plugin installed.

### Decision

No bump in this pass.

- @number0/iroh 1.1.0 -> 1.2.0 and ws 8.22.0 -> 8.23.0 are held for the next
  release window, so they land with a version bump and a full suite run instead
  of on their own.
- The 4 moderate vulnerabilities are dev-only and the only suggested fix is
  c8@9.1.0, a breaking downgrade from c8 12. Deferred; revisit when c8 or
  test-exclude ships a fixed line.

### Suite

`cd daemon && node --test test/dependency-cadence.unit.test.mjs` -> ALL PASS

The full suite was not re-run for this pass, since no dependency changed.
Before this pass, the bastion, desktop, protocol-contract and readme-truth
tests were already failing; this entry does not attribute those to the pass.
