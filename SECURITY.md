# Security policy

PocketDesk is self-hosted: you run the daemon and pair your own phone. This page
says how to report a problem, which versions get fixes, and what to expect back.

## Reporting a vulnerability

Use the GitHub private security advisory form:

https://github.com/Yash-Awasthi/PocketDesk/security/advisories/new

That form is the only disclosure path. This repository has no security email
address. Do not open a public issue, pull request or discussion for a
vulnerability; an advisory stays private until a fix ships.

Do not paste a pairing token, a certificate or private key, or a copy of a
config file into a report. Redact tokens and paths. A screenshot of the pairing
screen, a log line or a stack trace is usually enough to start.

## Supported versions

Fixes land on the current release line (0.11.x and later). Older tags are
unsupported: they predate the changelog and the current install defaults, and
they will not receive patches. If you run an older tag, update before
reporting.

## Response times

- Acknowledgement of a report within 3 working days.
- A triage decision within 10 working days: severity, and whether the outcome
  is a fix or a documented mitigation.
- No bug bounty. There is no payment for reports; credit in the advisory is
  offered if you want it.

These are targets, not a contract, and the clock starts at the advisory.
## Scope

In scope: the Windows daemon, the Android app, the install and uninstall
scripts, and the native helpers.

PocketDesk is designed to be visible to the machine it runs on: a tray icon,
Windows Event Log entries, and a status command that reports what is running.
It is not to be used in proctored exams. See [docs/INTEGRITY.md](docs/INTEGRITY.md)
for why the current defaults make that possible and what is being changed, and
[docs/ALPHA-CAPTURE.md](docs/ALPHA-CAPTURE.md) for the capture-consent contract.

There is no cloud service behind PocketDesk. Nothing is hosted by the project,
so there is no account, server or backend to report against; the daemon, the
app and the pairing between them are the whole attack surface.
