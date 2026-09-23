package com.yasha.pocketdesk

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Pure pieces of the transports: relay URLs, relay frame escaping, remote paths. */
class TransportTest {

    @Test
    fun `relay url parses host, port and channel`() {
        assertEquals(Triple("pc.example", 9000, "home"), RelayLink.parse("relay://pc.example:9000/home"))
    }

    @Test
    fun `relay url defaults port and channel`() {
        assertEquals(Triple("10.0.0.2", 8790, "rh-default"), RelayLink.parse("relay://10.0.0.2/"))
    }

    @Test
    fun `non relay or hostless urls are rejected`() {
        assertNull(RelayLink.parse("ws://pc:8765/ws"))
        assertNull(RelayLink.parse("relay://:9000/x"))
    }

    @Test
    fun `channel names survive json escaping`() {
        val link = RelayLink("h", 1, "c", onFrame = {}, onClosed = {})
        val raw = "a\"b\\c\nd\u0001"
        val decoded = Json.parseToJsonElement(link.jsonString(raw)).jsonPrimitive.content
        assertEquals(raw, decoded)
    }

    @Test
    fun `relay proof matches the daemon's hmac`() {
        // Same vector as node: createHmac("sha256", sha256hex("tok")).update("abc:peer1").
        assertEquals("1ea71ca095b26b74a3fe596d78d4012fc340c05f4c6aff0c7a385dd0522a46d0", RelayLink.proof("tok", "abc", "peer1"))
    }

    @Test
    fun `child paths use the separator of the daemon host`() {
        assertEquals("C:\\Users\\me\\a.txt", childPath("C:\\Users\\me", "a.txt"))
        assertEquals("C:\\a.txt", childPath("C:\\", "a.txt"))
        assertEquals("/home/me/a.txt", childPath("/home/me/", "a.txt"))
        assertEquals("/a.txt", childPath("/", "a.txt"))
    }
}
