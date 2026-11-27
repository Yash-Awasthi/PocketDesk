package com.yasha.pocketdesk.benchmark

import androidx.benchmark.macro.BaselineProfileMode
import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.StartupTimingMetric
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Cold first frame to the sessions list, the screen a user lands on after opening the app.
 *
 * Two variants of the same journey: without any profile, and with the baseline profile that the
 * generator writes. The difference between the two reports is the profile's effect; without both
 * numbers the profile is an assertion.
 *
 * The launch needs a linked PC: an unlinked install stops on the Connect screen, and this
 * benchmark then fails on the timeout instead of reporting the wrong screen as a sessions start.
 *
 * Run on a device: `./gradlew :benchmark:connectedBenchmarkAndroidTest`
 */
@RunWith(AndroidJUnit4::class)
class StartupBenchmark {
    @get:Rule
    val benchmarkRule = MacrobenchmarkRule()

    private val packageName = "com.yasha.pocketdesk"

    @Test
    fun coldStartToSessionsWithoutProfile() = measureColdStart(CompilationMode.None())

    @Test
    // `Require`: a run against an APK with no packaged profile fails instead of quietly
    // measuring an unprofiled build as if it were profiled.
    fun coldStartToSessionsWithProfile() =
        measureColdStart(CompilationMode.Partial(baselineProfileMode = BaselineProfileMode.Require))

    private fun measureColdStart(compilationMode: CompilationMode) =
        benchmarkRule.measureRepeated(
            packageName = packageName,
            metrics = listOf(StartupTimingMetric()),
            iterations = 5,
            startupMode = StartupMode.COLD,
            compilationMode = compilationMode,
        ) {
            pressHome()
            startActivityAndWait()
            // "Live sessions" is the list header in both the wide and the narrow layout, so the
            // measured frame is the first one with the sessions content, not the empty scaffold.
            check(
                device.wait(Until.hasObject(By.text("Live sessions")), FIRST_FRAME_TIMEOUT_MS),
            ) {
                "The sessions list never appeared. Link the app to a PocketDesk PC before running " +
                    "this benchmark; an unlinked install stops on the Connect screen."
            }
        }

    private companion object {
        const val FIRST_FRAME_TIMEOUT_MS = 10_000L
    }
}