package com.yasha.pocketdesk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Payloads built exactly as daemon/src/server.js buildPairPage does. */
class PairingTest {

    private val full = "pocketdesk://pair#eyJ1Ijoid3NzOi8vMTkyLjE2OC4xLjU6ODc2NS93cyIsInQiOiJ0b2sxMjMiLCJmIjoiQUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUI6QUIiLCJyIjoicmVsYXk6Ly8xOTIuMTY4LjEuNTo4NzkwIiwiYyI6ImhvbWUifQ"

    private fun link(json: String) =
        "pocketdesk://pair#" + java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray())

    @Test
    fun `an older payload with relay fields yields just the pinned LAN entry`() {
        assertEquals(listOf(ServerEntry("192.168.1.5", "wss://192.168.1.5:8765/ws", "tok123", "ab".repeat(32))), Pairing.parse(full))
    }

    @Test
    fun `plain ws pairing without tls or relay gives one unpinned entry`() {
        val entries = Pairing.parse(link("""{"u":"ws://10.0.0.2:8765/ws","t":"x","f":""}"""))
        assertEquals(listOf(ServerEntry("10.0.0.2", "ws://10.0.0.2:8765/ws", "x", null)), entries)
    }

    @Test
    fun `an iroh ticket becomes the LAN entry's fallback`() {
        val entries = Pairing.parse(link("""{"u":"ws://10.0.0.2:8765/ws","t":"x","f":"","i":"endpointabc"}"""))
        assertEquals(listOf(ServerEntry("10.0.0.2", "ws://10.0.0.2:8765/ws", "x", null, "iroh://endpointabc")), entries)
    }

    @Test
    fun `malformed or foreign links are rejected`() {
        assertTrue(Pairing.parse("https://evil.example/pair#abc").isEmpty())
        assertTrue(Pairing.parse("pocketdesk://pair#not-base64!").isEmpty())
        assertTrue(Pairing.parse(link("""{"u":"http://x/ws","t":"x"}""")).isEmpty())
        assertTrue(Pairing.parse(link("""{"u":"ws://x/ws"}""")).isEmpty())
    }

    @Test
    fun `fingerprints normalise to the form Tls compares`() {
        assertEquals("ab".repeat(32), Pairing.fingerprint("AB:".repeat(31) + "AB"))
        assertNull(Pairing.fingerprint("n/a"))
        assertNull(Pairing.fingerprint("ABCD"))
    }
}
