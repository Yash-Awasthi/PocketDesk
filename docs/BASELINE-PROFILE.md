# Baseline profile and macrobenchmarks

The Android app's cold start and chat scroll are measured, not asserted. This page is the flow, the
device requirements and the meaning of each number. There are no numbers in it yet: a profile and a
benchmark report both need a device, and none was attached when the module was added.

## One command

From `app/`, with an arm64 device attached and the app linked to a PocketDesk PC:

```
./gradlew :benchmark:generateBaselineProfile
```

That runs the generator test in `:benchmark`, walks the app's screens on the device and writes
`app/src/main/baseline-prof.txt`. The file is a source file, not a build output, so the regenerated
profile is a reviewable diff; commit it with the change that caused it. `:benchmark` forwards the
task to `:app:generateBaselineProfile`, which the AndroidX baseline-profile plugin creates on the
app because the app owns the profile it consumes. The plugin normally writes into
`src/<variant>/generated/baselineProfiles`; this project sets `baselineProfileOutputDir` so the file
lands in `src/main` and therefore applies to every variant, the benchmark one included.

Then measure:

```
./gradlew :benchmark:connectedBenchmarkReleaseAndroidTest
```

Or one class at a time:

```
./gradlew :benchmark:connectedBenchmarkReleaseAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.yasha.pocketdesk.benchmark.StartupBenchmark
./gradlew :benchmark:connectedBenchmarkReleaseAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.yasha.pocketdesk.benchmark.ScrollBenchmark
```

Compiling the module needs no device:

```
./gradlew :benchmark:assembleBenchmarkRelease
```

The generator and both benchmarks share one test APK, so each run is pinned by
`androidx.benchmark.enabledRules`: the module defaults to `macrobenchmark`, and the generation task
switches it to `baselineprofile`. Neither run executes the other's tests.

## What each benchmark reports

`StartupBenchmark` uses `StartupTimingMetric` for a cold launch to the sessions list. Two variants
run the same journey: `CompilationMode.None` and
`CompilationMode.Partial(baselineProfileMode = BaselineProfileMode.Require)`. The report is time to
initial display in milliseconds for each iteration plus the aggregate; the difference between the
two variants is the profile's effect. `Require` makes the profiled variant fail on an APK with no
packaged profile instead of silently measuring an unprofiled build. The sessions-list header is
awaited inside the measured block, so an unlinked device fails with a message instead of reporting
the Connect screen as a sessions start. The app does not call `reportFullyDrawn`, so the metric has
no separate time-to-full-display value.

`ScrollBenchmark` uses `FrameTimingMetric` over an open chat conversation: fixed swipe distance,
fixed swipe count, five iterations. The report is frame duration (`frameDurationCpuMs`) at P50, P90,
P95 and P99 plus frame overruns, in milliseconds. Repeatability comes from the fixed swipes and a
host conversation seeded with at least 200 messages; the benchmark itself cannot fabricate the
transcript, because the transcript is replayed by the PC daemon.

`BaselineProfileGenerator` reports no number. It records the screens it visits and produces the
profile file. On a device that is not linked to a PC it can only record the Connect screen; that
profile is valid but thin, and the flow above assumes a linked PC.

## Device requirements

- A physical device, `arm64-v8a`. Release and benchmark builds carry only the arm64 native
  libraries (iroh is ~14 MB per ABI), so an x86_64 emulator cannot install the benchmark target.
- Android 11 (API 30) or newer; the app's `minSdk` is 30 and the benchmark module matches it.
- USB debugging enabled; the device visible to `adb devices`.
- Screen unlocked, battery above 20%, no debugger attached. The module suppresses the library's
  `LOW-BATTERY` and `UNLOCKED` errors so a quick local run is not blocked, but a report produced
  with either condition is not comparable.
- For the sessions-list and chat-scroll numbers: the app linked to a PocketDesk PC, with at least
  one live session and a chat conversation of at least 200 messages on that PC.

An emulator would need x86_64 native libraries in the benchmark target, which this app does not
build, so it is not a supported substitute here.

## Applying the profile

AGP packages `src/main/baseline-prof.txt` into the APK as `assets/dexopt/baseline.prof`; the
benchmark's profiled variant measures exactly that packaged profile. Applying it at install time for
a sideloaded APK on API 30-31 additionally needs the `androidx.profileinstaller` library, which the
app does not depend on yet. That dependency is a one-line app change and belongs with the first
generated profile, not with this module.