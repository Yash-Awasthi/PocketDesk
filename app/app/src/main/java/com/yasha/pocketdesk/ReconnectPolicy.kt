package com.yasha.pocketdesk

/**
 * Auto-reconnect with exponential backoff + jitter (client-kt / krossbow
 * pattern), plus `since`-seq reattach (cc-pocket pattern): after a drop, the
 * client re-connects, re-auths and replays only the output it missed.
 */
class ReconnectPolicy(
    // Never give up on its own: a PC reboot + login can outlast any fixed cap, so retry at the
    // capped interval until the socket reconnects or the user stops it (userClosed in WsClient).
    private val maxAttempts: Int = Int.MAX_VALUE,
    baseMs: Long = 1_000,
    private val maxMs: Long = 30_000,
) {
    private val base = baseMs.coerceIn(250, maxMs)
    private var attempt = 0

    /** Milliseconds to wait before attempt N; null when reconnection gives up. */
    fun nextDelayMs(): Long? {
        if (attempt >= maxAttempts) return null
        attempt++
        val exp = base * (1L shl (attempt - 1).coerceAtMost(10))
        val capped = exp.coerceAtMost(maxMs)
        val jitter = (capped * 0.2 * Math.random()).toLong()
        return capped + jitter
    }

    /** A successful (re)connect resets the ladder. */
    fun reset() {
        attempt = 0
    }

    val attemptsSoFar: Int get() = attempt
}
