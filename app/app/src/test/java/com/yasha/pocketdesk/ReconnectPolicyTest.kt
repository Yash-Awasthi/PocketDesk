package com.yasha.pocketdesk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ReconnectPolicy decides how long the phone waits between reconnect attempts.
 * The jitter is random by design, so every assertion here is a range assertion
 * against the bounds the ladder promises, never an equality against a delay.
 */
class ReconnectPolicyTest {

    /** The delay for the next attempt, or null once the ladder is spent. */
    private fun ReconnectPolicy.next(): Long? = nextDelayMs()

    @Test
    fun `gives up after the configured number of attempts`() {
        val policy = ReconnectPolicy(maxAttempts = 3, baseMs = 1_000, maxMs = 30_000)
        repeat(3) { assertTrue("attempt ${it + 1} must be allowed", policy.next() != null) }
        assertNull("a fourth attempt must be refused", policy.next())
        assertEquals(3, policy.attemptsSoFar)
    }

    @Test
    fun `grows the delay exponentially and caps it`() {
        val policy = ReconnectPolicy(maxAttempts = 8, baseMs = 1_000, maxMs = 30_000)
        val caps = listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L, 30_000L)
        caps.forEachIndexed { i, cap ->
            val delay = policy.next()!!
            assertTrue("attempt ${i + 1}: $delay below $cap", delay >= cap)
            assertTrue("attempt ${i + 1}: $delay above 20% jitter", delay <= cap + cap / 5)
        }
    }

    @Test
    fun `reset restores the ladder to its first step`() {
        val policy = ReconnectPolicy(maxAttempts = 2, baseMs = 1_000, maxMs = 30_000)
        policy.next()
        policy.next()
        assertNull(policy.next())
        policy.reset()
        assertEquals(0, policy.attemptsSoFar)
        val delay = policy.next()!!
        assertTrue("post-reset $delay is not a first-step delay", delay in 1_000..1_200)
    }

    @Test
    fun `raises a base delay below the floor up to 250ms`() {
        val policy = ReconnectPolicy(maxAttempts = 1, baseMs = 10, maxMs = 30_000)
        val delay = policy.next()!!
        assertTrue("$delay is below the 250ms floor", delay in 250..300)
    }

    @Test
    fun `clamps a base delay above the ceiling down to maxMs`() {
        val policy = ReconnectPolicy(maxAttempts = 1, baseMs = 100_000, maxMs = 30_000)
        val delay = policy.next()!!
        assertTrue("$delay is above 30s plus jitter", delay in 30_000..36_000)
    }

    @Test
    fun `never waits longer than 20% above the cap`() {
        val policy = ReconnectPolicy(maxAttempts = 12, baseMs = 5_000, maxMs = 30_000)
        repeat(12) {
            val delay = policy.next()!!
            assertTrue("$delay exceeds the jitter ceiling", delay <= 36_000)
        }
    }
}
