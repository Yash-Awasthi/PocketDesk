package com.yasha.pocketdesk.benchmark

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Records the app's own screens and asks Android to AOT-compile exactly that.
 *
 * The app is a client: with a linked PC it opens on the sessions list and its bottom bar reaches
 * Chats, Tools and Files. Those are the paths walked here. Without a link the app can only show
 * Connect, so the walk stops there and the resulting profile covers the connect screen; that is
 * honest but thin, and `docs/BASELINE-PROFILE.md` says so.
 *
 * Run with a device: `./gradlew :benchmark:generateBaselineProfile`, then commit
 * `app/src/main/baseline-prof.txt`.
 */
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
    @get:Rule
    val rule = BaselineProfileRule()

    private val packageName = "com.yasha.pocketdesk"

    @Test
    fun walksAppScreens() =
        rule.collect(packageName = packageName, includeInStartupProfile = false) {
            pressHome()
            startActivityAndWait()
            val ui = device

            // A linked PC lands on the sessions list; an unlinked one shows Connect, which is then
            // the only screen this device can profile.
            if (!ui.wait(Until.hasObject(By.text("Live sessions")), LINK_TIMEOUT_MS)) return@collect

            for (tab in TABS) {
                ui.findObject(By.text(tab))?.click()
                ui.waitForIdle()
            }

            // The chat transcript is the screen with the most text work; one open and one sweep
            // records its composition without turning the profile into a chat-only profile.
            openFirstChat(ui)
            repeat(2) {
                ui.swipe(
                    ui.displayWidth / 2,
                    ui.displayHeight * 3 / 4,
                    ui.displayWidth / 2,
                    ui.displayHeight / 4,
                    SWIPE_STEPS,
                )
            }
        }

    private fun openFirstChat(device: UiDevice) {
        val newChat = device.wait(Until.findObject(By.text("New chat")), LINK_TIMEOUT_MS) ?: return
        val bodyBottom = (device.displayHeight * 0.8f).toInt()
        device.findObjects(By.clickable(true))
            .filter { it.visibleBounds.top > newChat.visibleBounds.bottom }
            .filter { it.visibleBounds.top < bodyBottom }
            .minByOrNull { it.visibleBounds.top }
            ?.click()
        device.waitForIdle()
    }

    private companion object {
        const val LINK_TIMEOUT_MS = 3_000L
        const val SWIPE_STEPS = 12

        /** Bottom-bar tabs, in the order a user visits them. */
        val TABS = listOf("Chats", "Tools", "Files", "Sessions")
    }
}