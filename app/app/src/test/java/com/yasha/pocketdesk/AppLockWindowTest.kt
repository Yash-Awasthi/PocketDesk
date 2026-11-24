package com.yasha.pocketdesk

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The re-lock rule behind `AppLock`, checked without a phone: the 30-second grace window is
 * the only thing standing between "I glanced at a notification" and "scan my face again", so
 * both sides of the boundary are asserted rather than just the constant.
 */
class AppLockWindowTest {

    private fun decide(
        enabled: Boolean = true,
        available: Boolean = true,
        locked: Boolean = false,
        awayMs: Long,
    ) = AppLock.decide(enabled, available, locked, stoppedAt = 1_000L, now = 1_000L + awayMs)

    @Test
    fun `the grace window is thirty seconds`() {
        assertTrue(AppLock.GRACE_MS == 30_000L)
    }

    @Test
    fun `a quick switch away does not lock`() {
        assertFalse(decide(awayMs = 1_000))
        assertFalse(decide(awayMs = AppLock.GRACE_MS - 1))
    }

    @Test
    fun `the boundary itself still does not lock but a millisecond more does`() {
        assertFalse(decide(awayMs = AppLock.GRACE_MS))
        assertTrue(decide(awayMs = AppLock.GRACE_MS + 1))
    }

    @Test
    fun `a long absence locks`() {
        assertTrue(decide(awayMs = 10 * 60_000))
    }

    @Test
    fun `the lock is off until the user turns it on`() {
        assertFalse(decide(enabled = false, awayMs = 10 * 60_000))
    }

    @Test
    fun `a phone with no screen lock is never gated`() {
        // No lock set means nothing to unlock with, so gating would trap the user outside the app.
        assertFalse(decide(available = false, awayMs = 10 * 60_000))
    }

    @Test
    fun `once locked it stays locked until the prompt succeeds`() {
        assertTrue(decide(locked = true, awayMs = 0))
        assertTrue(decide(locked = true, available = false, awayMs = 0))
    }

    @Test
    fun `a cold start with the lock enabled is gated immediately`() {
        // stoppedAt == 0 means the activity has not been stopped yet in this process, so there is
        // no grace window to spend: launching the app with the lock on always shows the prompt.
        assertTrue(AppLock.decide(enabled = true, available = true, locked = false, stoppedAt = 0L, now = 9_999_999L))
    }
}
