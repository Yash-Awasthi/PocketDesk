package com.yasha.pocketdesk

import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * What a phone does with a QR that is not a usable pairing link.
 *
 * The scanner cannot be driven from a test, but its decision can: it calls `Pairing.parse` and
 * shows [Pairing.REJECTED] when the result is empty. A plain `ws://` link with no iroh ticket is
 * the case that matters — the daemon behind it has no TLS, so dialling it would send the master
 * token over the LAN in the clear. It must be refused, and the user must be told why.
 */
@RunWith(AndroidJUnit4::class)
class PairRejectInstrumentedTest {

    private fun link(json: String): String {
        val b64 = Base64.encodeToString(json.toByteArray(), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        return "pocketdesk://pair#$b64"
    }

    /** The scanner's rule, in one place: empty parse means the rejection toast. */
    private fun scan(qr: String): String? = Pairing.parse(qr).takeIf { it.isNotEmpty() }?.let { "paired" }
        ?: Pairing.REJECTED

    @Test
    fun theRejectionMessageIsTheDocumentedOne() {
        assertEquals("Not a PocketDesk pairing QR", Pairing.REJECTED)
    }

    @Test
    fun aPlainWsLinkIsRejectedWithThatMessage() {
        val qr = link("""{"u":"ws://192.168.1.20:8765/pocketdesk","t":"secret-token"}""")
        assertTrue("a ws:// link must not parse", Pairing.parse(qr).isEmpty())
        assertEquals(Pairing.REJECTED, scan(qr))
    }

    @Test
    fun theSameLinkWithAnIrohTicketIsAcceptedOverIroh() {
        // The ticket is end-to-end encrypted, so the same URL-less route is allowed; the entry
        // carries no fingerprint because TLS is not what protects it.
        val qr = link("""{"u":"ws://192.168.1.20:8765/pocketdesk","t":"secret-token","i":"ticket-abc"}""")
        val entry = Pairing.parse(qr).single()
        assertEquals("iroh://ticket-abc", entry.url)
        assertEquals(null, entry.pinnedFingerprint)
        assertEquals(null, entry.fallback)
    }

    @Test
    fun aQrFromAnotherAppIsRejected() {
        assertEquals(Pairing.REJECTED, scan("https://example.com/not-a-pairing-qr"))
        assertEquals(Pairing.REJECTED, scan("WIFI:S:CafeNet;T:WPA;P:password;;"))
        assertEquals(Pairing.REJECTED, scan(""))
    }

    @Test
    fun aWsLinkMissingItsTokenIsRejectedToo() {
        // A url with no token cannot authenticate anything, and a half-parsed entry would show up
        // in the saved list as a PC that never connects.
        assertEquals(Pairing.REJECTED, scan(link("""{"u":"wss://pc.example:8765/pocketdesk"}""")))
    }
}
