package com.yasha.pocketdesk

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class ServerBookTest {

    @Test
    fun `saved PCs read back the same`() {
        val pcs = listOf(
            ServerEntry("Desk", "wss://192.168.1.7:8765/ws", "tok", "e6:7b", "iroh-ticket", WakeInfo(listOf("18:3D:2D:38:96:18"), listOf("192.168.1.255"))),
            ServerEntry("Laptop", "wss://10.0.0.2:8765/ws", "t2"),
        )
        assertEquals(pcs, ServerBook.decode(ServerBook.encode(pcs)))
    }

    @Test
    fun `missing fields take defaults and entries without a url are skipped`() {
        val raw = """[{"url":"wss://a/ws","fp":"","fallback":"","wake":{"macs":[],"bc":["x"]}},{"name":"no url"},7]"""
        assertEquals(listOf(ServerEntry("wss://a/ws", "wss://a/ws", "")), ServerBook.decode(raw))
    }

    @Test
    fun `unreadable storage gives an empty book`() {
        assertEquals(emptyList<ServerEntry>(), ServerBook.decode("not json"))
        assertEquals(emptyList<ServerEntry>(), ServerBook.decode("""{"url":"wss://a/ws"}"""))
        assertEquals(emptyList<ServerEntry>(), ServerBook.decode(null))
    }
}
