# benchmark

Device-only module: Macrobenchmarks for the app and the baseline-profile generator. It is a
`com.android.test` project that instruments `:app` from outside and ships in no APK, so it is not
part of the normal build gate.

| Path | What it is |
| --- | --- |
| `src/main/.../StartupBenchmark.kt` | Cold start to the sessions list, with and without the baseline profile. |
| `src/main/.../ScrollBenchmark.kt` | Frame times while scrolling a seeded chat conversation. |
| `src/main/.../BaselineProfileGenerator.kt` | Walks the app's own screens and writes the profile. |

All three share one APK, so the run mode is pinned by `androidx.benchmark.enabledRules`: this module
defaults to `macrobenchmark`, and `generateBaselineProfile` switches it to `baselineprofile`. A
benchmark run therefore never records a profile, and a generation run never measures one.

## Tasks

```
cd app
./gradlew :benchmark:assembleBenchmarkRelease        # compiles all three sources (no device)
./gradlew :benchmark:tasks --all                     # lists every task, including the generator
./gradlew :benchmark:generateBaselineProfile         # needs a device; writes app/src/main/baseline-prof.txt
./gradlew :benchmark:connectedBenchmarkReleaseAndroidTest  # needs a device; prints the metrics
```

The `benchmarkRelease` variant is the one that pairs with the app variant of the same name: the
baseline-profile plugin creates both, so the test APK and the measured app APK are the same build.

The full device requirements, the one-command flow and what each metric means live in
`docs/BASELINE-PROFILE.md` at the repository root.

No baseline profile is committed yet: generating one needs a physical arm64 device, and none was
attached to the change that added this module. The row in `plan.md` stays open for that reason.