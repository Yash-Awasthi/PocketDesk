package com.yasha.pocketdesk

import android.content.Context
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * `AppLock` as the activity actually uses it: the switch persists, a phone with no screen lock
 * is never gated, and a stop followed by an immediate return spends no prompt.
 *
 * The 30-second window itself is asserted in `AppLockWindowTest` on the JVM, because widening
 * it here would mean putting a phone to sleep for half a minute in CI.
 */
@RunWith(AndroidJUnit4::class)
class AppLockInstrumentedTest {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val prefs get() = compose.activity.getSharedPreferences("pocketdesk", Context.MODE_PRIVATE)

    @Test
    fun theSwitchIsOffByDefaultAndPersists() {
        prefs.edit().remove("lock").commit()
        val lock = AppLock(compose.activity, onUnlocked = {})
        assertFalse("the lock must start off", lock.enabled)
        lock.enabled = true
        assertTrue("the switch must survive a new instance", AppLock(compose.activity, onUnlocked = {}).enabled)
        assertTrue("and be readable from disk", prefs.getBoolean("lock", false))
        lock.enabled = false
        assertFalse(AppLock(compose.activity, onUnlocked = {}).enabled)
    }

    @Test
    fun aPhoneWithoutAScreenLockIsNeverGated() {
        // The emulator used for tests has no PIN, which is also how a fresh phone behaves: with
        // nothing to authenticate against, gating would lock the owner out of their own app.
        val secure = compose.activity.getSystemService(android.app.KeyguardManager::class.java).isDeviceSecure
        prefs.edit().putBoolean("lock", true).commit()
        val lock = AppLock(compose.activity, onUnlocked = {})
        assertEquals("available must mirror the keyguard", secure, lock.available)
        if (!lock.available) {
            assertFalse("a phone with no lock must never be gated", lock.shouldLock())
        }
        prefs.edit().remove("lock").commit()
    }

    @Test
    fun aRotationDoesNotSpendANewGraceWindow() {
        prefs.edit().putBoolean("lock", true).commit()
        val lock = AppLock(compose.activity, onUnlocked = {})
        if (!lock.available) {
            // Nothing else to prove on an unsecured phone; the JVM test owns the timing rule.
            return
        }
        lock.unlocked()
        lock.onStop()
        // Back within the grace window: the UI must stay open.
        assertFalse("returning immediately must not re-lock", lock.shouldLock())
    }
}
