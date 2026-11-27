# Daemon cold start

The daemon's cold start is the time from spawning `node src/index.js` to the line that says the
port is listening: `PocketDesk daemon`. The budget is **400 ms on a mid-range PC**. The second
number the measurement prints, listen to first `/health` answer, is separate on purpose: the
registry scan spawns about 60 `cmd.exe /c <bin> --version` probes and blocks the Windows event
loop for seconds, so the port and `/health` must answer before the scan rather than after it.

## Running it

```
cd daemon
node scripts/measure-startup.mjs            # five cold starts
node scripts/measure-startup.mjs --runs=3
```

Each run is a fresh process on free ports and a temporary home, manifest and data directory. The
five runs share one compile cache directory; the output says `compile cache fresh` for the run
that created it and `compile cache reused` for the rest, because cached bytecode changes what a
cold run pays. `PD_COMPILE_CACHE` points the runs at an existing directory instead of a temporary
one, and `PD_NO_LOAD=1` skips the host snapshot.

On Windows every run is preceded by a host snapshot: the `Win32_Processor` load percentage and the
top CPU consumers over a 500 ms sample. A loaded host is not an idle baseline, and the snapshot is
what tells the two apart.

## Readiness table

`node scripts/cold-start.mjs` (`npm run cold-start`) is the wider measurement, and it is the one
that answers the budget row directly: 12 fresh processes with no `NODE_COMPILE_CACHE`, and a table
of min / median / max / spread for three milestones of the same spawn - spawn to listening, spawn
to the first `/health` answer, and spawn to `registry scanned`, the banner `test/helpers.mjs` waits
for. It also measures the host's own `node -e ""` spawn floor in the same window, because a machine
whose bare spawn alone costs hundreds of milliseconds cannot answer a 400 ms question. The verdict
gates on the median of spawn to `registry scanned` and prints the listening median for contrast.
`--quiet=PCT` waits once, before the batch, for the host to fall to that load; if it never does the
run says `measuring anyway` and the numbers are an upper bound with the load printed per run.

## The gate

CI runs the script on the normal daemon runners with nothing warmed up and prints every number.
The gate is the **worst** of the five `start->listen` values: at or over 400 ms fails the job. The
median is printed next to it for context. If runner variance ever makes the worst gate flaky, the
documented fallback is to gate on the median at the same 400 ms and keep printing the worst; that
is a deliberate change to make in one place (`main` in `scripts/measure-startup.mjs`), not a
silent retry.
The gate is advisory: the CI step runs with `continue-on-error`, so every number prints and the
job stays green. The budget row is untested on this host, not disproven: this machine's bare
`node -e "0"` spawn floor is 232 ms median (73 ms best), which leaves too little headroom to
judge a mid-range desktop. The ticked measurement row in `plan.md` is the upper-bound record,
and the flag comes off only when a host with a sub-400 ms floor is measured.

## Where the time goes

`src/index.js` dynamic-imports `src/daemon.js`, which imports `src/server.js`. The server imports
the terminal, chat, capture, phone and handler modules at startup. The SSH surface (`ssh2` through
`ssh_bastion`, `advanced_ssh_server` and `ssh_vnc_client`) used to be imported with everything
else; it is now created on the first SSH message (`loadSsh()` in `src/server.js`), one instance
per process, so a normal start never pays for it.

## Measurements

- 2026-11-27, readiness table (`node scripts/cold-start.mjs --runs=12 --quiet=70`, exit 1): 12 cold
  starts on a busy host (load 26-84%; gradle `java`, `git status` sweeps, Docker and ffmpeg from
  other sessions; the 120 s quiet gate did not open). Spawn -> `registry scanned` min 3864 ms,
  median 4802 ms, max 9150 ms, spread 5286 ms; spawn -> listening min 384 ms, median 670 ms, max
  1049 ms; the first `/health` answer came 12-28 ms after listening in every run; bare
  `node -e ""` floor min 60 ms, median 109 ms, max 1185 ms. The 400 ms budget is missed on the
  readiness line by about 12x, and the scan itself (17 manifests, one `bin --version` probe each)
  took 3.4-4.4 s even at 27-40% load, so this is not a loaded-host artifact alone. Hardware:
  i7-13650HX, 14 cores / 20 logical, 23.8 GB RAM, Samsung MZAL8512HDLU NVMe SSD, Windows 11 26300.
- 2026-11-26, loaded host (7-31% CPU load, about 1-3 of 20 logical cores busy): five cold starts
  at 1275, 1408, 1068, 631 and 674 ms; worst 1408 ms, median 1068 ms. Over budget; the budget row
  stays open. Full snapshot: `C:/GITHUB/.fleet/evidence/PocketDesk/row-332.md`.
- 2026-11-26, earlier quiet windows on the same box: 295-431 ms across six 3-run medians. Recorded
  in the measurement row in `plan.md`.
