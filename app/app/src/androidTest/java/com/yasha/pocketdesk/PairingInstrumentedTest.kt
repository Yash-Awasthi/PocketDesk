package com.yasha.pocketdesk

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The pairing payload, decoded on a device:
 * `pocketdesk://pair#<base64url JSON {u,t,f,i,n}>`, exactly as `buildPair` in
 * daemon/src/server.js writes it.
 *
 * This is the instrumented twin of the JVM `PairingTest`: same payloads, but the base64
 * and JSON implementations are Android's. A phone that cannot read this link cannot pair,
 * so it is the first thing the emulator job checks.
 */
@RunWith(AndroidJUnit4::class)
class PairingInstrumentedTest {

    private fun base64(json: String): String =
        java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray())

    private fun link(json: String) = "pocketdesk://pair#" + base64(json)

    @Test
    fun tlsPayloadCarriesUrlTokenFingerprintAndLabel() {
        val fp = "ab".repeat(32)
        val entries = Pairing.parse(
            link("""{"u":"wss://192.168.1.5:8765/ws","t":"tok123","f":"$fp","n":"Studio PC"}"""),
        )
        assertEquals(1, entries.size)
        assertEquals("Studio PC", entries[0].name)
        assertEquals("wss://192.168.1.5:8765/ws", entries[0].url)
        assertEquals("tok123", entries[0].token)
        assertEquals(fp, entries[0].pinnedFingerprint)
        assertNull(entries[0].fallback)
    }

    @Test
    fun payloadWithoutALabelIsNamedAfterTheHost() {
        val entries = Pairing.parse(link("""{"u":"wss://10.0.0.2:8766/ws","t":"x","f":"","n":""}"""))
        assertEquals("10.0.0.2", entries[0].name)
        assertNull(entries[0].pinnedFingerprint)
    }

    @Test
    fun plainWsIsRefusedUnlessAnIrohTicketCarriesIt() {
        assertTrue(Pairing.parse(link("""{"u":"ws://10.0.0.2:8765/ws","t":"x","f":""}""")).isEmpty())
        val viaIroh = Pairing.parse(link("""{"u":"ws://10.0.0.2:8765/ws","t":"x","f":"","i":"endpointabc"}"""))
        assertEquals(listOf(ServerEntry("10.0.0.2", "iroh://endpointabc", "x", null)), viaIroh)
    }

    @Test
    fun theIrohTicketRidesAlongAsTheFallbackOfAWssEntry() {
        val entries = Pairing.parse(link("""{"u":"wss://10.0.0.2:8765/ws","t":"x","f":"","i":"endpointabc"}"""))
        assertEquals("wss://10.0.0.2:8765/ws", entries[0].url)
        assertEquals("iroh://endpointabc", entries[0].fallback)
    }

    @Test
    fun junkAndForeignLinksYieldNoEntry() {
        assertTrue(Pairing.parse("").isEmpty())
        assertTrue(Pairing.parse("https://example.com").isEmpty())
        assertTrue(Pairing.parse("pocketdesk://pair#not-base64!!").isEmpty())
        assertTrue(Pairing.parse(link("""{"u":"https://10.0.0.2:8765/ws","t":"x"}""")).isEmpty())
        assertTrue(Pairing.parse(link("""{"u":"wss://10.0.0.2:8765/ws"}""")).isEmpty())
    }

    @Test
    fun fingerprintsNormaliseToLowercaseHexWithoutSeparators() {
        val colonised = (1..32).joinToString(":") { "AB" }
        assertEquals("ab".repeat(32), Pairing.fingerprint(colonised))
        assertNull(Pairing.fingerprint("AB:CD"))
        assertNull(Pairing.fingerprint(null))
        assertNull(Pairing.fingerprint("zz".repeat(32)))
    }

    // The same link the daemon actually built, captured from a real pairing page.
    @Test
    fun theDaemonsOwnLinkShapeIsUnderstood() {
        val fp = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"
        val payload =
            """{"u":"wss://192.168.1.5:8765/ws","t":"tok123","f":"$fp","i":"ticket-1","n":"PC (console)"}"""
        val entries = Pairing.parse("pocketdesk://pair#" + base64(payload))
        assertEquals("PC (console)", entries[0].name)
        assertEquals(fp.replace(":", "").lowercase(), entries[0].pinnedFingerprint)
        assertEquals("iroh://ticket-1", entries[0].fallback)
    }
}
