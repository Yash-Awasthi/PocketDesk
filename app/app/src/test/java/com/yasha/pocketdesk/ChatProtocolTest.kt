package com.yasha.pocketdesk

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test

/** Chat messages the phone sends and the transcript and agent info it reads back. */
class ChatProtocolTest {

    private fun obj(s: String) = Json.parseToJsonElement(s) as JsonObject

    @Test
    fun `a plain message carries no model or mode`() {
        val m = obj(Proto.chatMsg("c1", "hi"))
        assertFalse("model" in m || "mode" in m)
    }

    @Test
    fun `per-message model and mode go with the message, empty model meaning the CLI default`() {
        val m = obj(Proto.chatMsg("c1", "hi", model = "", mode = "readonly"))
        assertEquals("", str(m, "model"))
        assertEquals("readonly", str(m, "mode"))
    }

    @Test
    fun `replayed tool items keep their id`() {
        val items = Proto.parseChatReplay(Json.parseToJsonElement("""[{"role":"tool","name":"Read","detail":"a","toolId":"tu1"},{"role":"tool","name":"Bash","detail":"b"}]"""))
        assertEquals(listOf(ChatItem.Tool("Read", "a", "tu1"), ChatItem.Tool("Bash", "b")), items)
    }

    @Test
    fun `chat info lists agent and daemon commands`() {
        val i = Proto.parseChatInfo(obj("""{"model":"opus","permissionMode":"plan","commands":["review"],"pocketdesk":[{"name":"help","description":"List"}]}"""))
        assertEquals(ChatInfo("opus", "plan", listOf("review"), listOf("help" to "List")), i)
    }
}
