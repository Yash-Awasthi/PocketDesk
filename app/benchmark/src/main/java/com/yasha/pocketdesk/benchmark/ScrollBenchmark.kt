package com.yasha.pocketdesk.benchmark

import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.FrameTimingMetric
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Frame times while scrolling an open chat conversation.
 *
 * The conversation is not fabricated here: it is replayed by the PC daemon, so the run is
 * repeatable only when the host is seeded with a conversation of at least
 * [SEEDED_CONVERSATION_MESSAGES] messages before the run. The swipe distance and count are fixed,
 * so the same seed produces the same amount of scrolling every iteration.
 *
 * Run on a device: `./gradlew :benchmark:connectedBenchmarkAndroidTest`
 */
@RunWith(AndroidJUnit4::class)
class ScrollBenchmark {
    @get:Rule
    val benchmarkRule = MacrobenchmarkRule()

    private val packageName = "com.yasha.pocketdesk"

    @Test
    fun chatScroll() =
        benchmarkRule.measureRepeated(
            packageName = packageName,
            metrics = listOf(FrameTimingMetric()),
            iterations = 5,
            startupMode = StartupMode.WARM,
            compilationMode = CompilationMode.None(),
            setupBlock = {
                pressHome()
                startActivityAndWait()
                check(device.wait(Until.hasObject(By.text("Live sessions")), TIMEOUT_MS)) {
                    "The sessions list never appeared. Link the app to a PocketDesk PC first."
                }
                device.findObject(By.text("Chats"))?.click()
                openFirstChat(device)
                device.waitForIdle()
            },
        ) {
            val ui = device
            repeat(SCROLL_SWEEPS) {
                ui.swipe(
                    ui.displayWidth / 2,
                    ui.displayHeight * 3 / 4,
                    ui.displayWidth / 2,
                    ui.displayHeight / 4,
                    SWIPE_STEPS,
                )
                device.swipe(
                    ui.displayWidth / 2,
                    ui.displayHeight / 4,
                    ui.displayWidth / 2,
                    ui.displayHeight * 3 / 4,
                    SWIPE_STEPS,
                )
            }
        }

    /**
     * The first chat card under "New chat". The cards are clickable Compose nodes, and clicking by
     * position would depend on the transcription of the first message.
     */
    private fun openFirstChat(device: UiDevice) {
        val newChat = checkNotNull(device.wait(Until.findObject(By.text("New chat")), TIMEOUT_MS)) {
            "The Chats tab did not load. Link the app to a PocketDesk PC first."
        }
        // The bottom bar is also clickable and sits below the cards; keep the search to the body.
        val bodyBottom = (device.displayHeight * 0.8f).toInt()
        val card = device.findObjects(By.clickable(true))
            .filter { it.visibleBounds.top > newChat.visibleBounds.bottom }
            .filter { it.visibleBounds.top < bodyBottom }
            .minByOrNull { it.visibleBounds.top }
        checkNotNull(card) {
            "No chat card to open. Seed a conversation on the PC before running this benchmark."
        }.click()
        // A chat opened from the list has to replay its transcript before there is anything to
        // scroll; the conversation's own bottom is the stable signal that the replay has started.
        device.waitForIdle()
    }

    private companion object {
        /** The host seed must hold at least this many messages; eight sweeps stay inside it. */
        const val SEEDED_CONVERSATION_MESSAGES = 200

        /** Eight sweeps cover roughly 25 messages each: enough frames, and a run that stays minutes. */
        const val SCROLL_SWEEPS = 8

        const val SWIPE_STEPS = 12
        const val TIMEOUT_MS = 10_000L
    }
}