# Console endpoint — build steps

Authorized remote administration of the owner's own PC (the AnyDesk-style goal
in `CONTEXT.md`). Gives the phone a second, `SYSTEM`-level entry, "PC (console)",
that reaches the secure desktop — UAC prompts, the lock screen, and the
pre-login logon screen — which the ordinary user daemon cannot touch.

One file per step. Delete a step's file the moment it is done and verified;
when the folder is empty the feature has shipped. The high-level rationale and
architecture live in `docs/console-endpoint-plan.md`.

| Step | File | State |
|------|------|-------|
| 1 launcher exe | — | done |
| 2 install `-Console` | — | done |
| 3 uninstall | — | done |
| 4 root installer | — | done |
| 5 doctor check | — | done |
| 6 | `60-verification.md` | automatable done; **manual hardware run pending** |
| 7 docs | — | done (SETUP-PC.md, CONTEXT.md) |

Steps 1–5, the automatable tests, and the docs have shipped in the working tree.
All that remains is the manual hardware run in `60-verification.md`.

## Invariants every step must preserve

- The **user daemon (port 8765) is never changed in behavior.** All console
  code is gated behind `RH_CONSOLE=1` / `RH_LABEL` / `RH_HOME`, or lives in new
  files. The three PowerShell helper scripts must stay byte-identical to `HEAD`
  when `RH_CONSOLE` is unset (there is a check for this — keep it green).
- The console token is a `SYSTEM` credential. It never crosses the wire in
  plaintext (TLS is mandatory for the console daemon) and its folder is readable
  only by Administrators + SYSTEM.
- Ports: **8765** user daemon, **8766** console daemon. Two tokens, two TLS
  certs, two iroh keys, two `RH_HOME` dirs.
