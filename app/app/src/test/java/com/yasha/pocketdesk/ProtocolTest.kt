package com.yasha.pocketdesk

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The daemon sends a mixed manifest list: CLI agents carry a `bin`, while GUI
 * applications carry an absolute path per platform and no `bin` at all. The app
 * has to tell the two apart to know whether to offer a terminal or a launch.
 */
class ProtocolTest {

    private fun tools(vararg manifests: String) =
        Proto.parseTools(Json.parseToJsonElement("""{"manifests":[${manifests.joinToString(",")}]}"""))

    @Test
    fun `terminal manifest keeps its bin and adapter`() {
        val t = tools("""{"manifest":{"id":"claude","name":"Claude Code","bin":"claude","adapter":"terminal"},
            "installed":true,"version":"1.2.3","installing":false}""").single()
        assertEquals("claude", t.manifest.bin)
        assertEquals(Manifest.ADAPTER_TERMINAL, t.manifest.adapter)
        assertFalse(t.manifest.isGui)
    }

    @Test
    fun `gui manifest has no bin and reports itself as gui`() {
        val t = tools("""{"manifest":{"id":"vscode","name":"Visual Studio Code","adapter":"gui",
            "paths":{"win32":"%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe"}},
            "installed":true,"version":"C:\\Code.exe","installing":false}""").single()
        assertNull(t.manifest.bin)
        assertTrue(t.manifest.isGui)
    }

    @Test
    fun `a manifest without an adapter defaults to terminal`() {
        val t = tools("""{"manifest":{"id":"aider","name":"Aider","bin":"aider"},"installed":false}""").single()
        assertEquals(Manifest.ADAPTER_TERMINAL, t.manifest.adapter)
        assertFalse(t.manifest.isGui)
    }

    @Test
    fun `gui and terminal manifests coexist in one list`() {
        val list = tools(
            """{"manifest":{"id":"zed","name":"Zed","adapter":"gui"},"installed":true}""",
            """{"manifest":{"id":"codex","name":"Codex","bin":"codex"},"installed":true}""",
        )
        assertEquals(listOf(true, false), list.map { it.manifest.isGui })
    }

    @Test
    fun `a manifest is chat capable only when it carries chat args`() {
        val withArgs = tools(
            """{"manifest":{"id":"claude","name":"[CC]","bin":"claude","chat":{"args":["-p"]}},"installed":true}""",
        ).single()
        val withoutArgs = tools(
            """{"manifest":{"id":"copilot","name":"Copilot","bin":"copilot","chat":{"models":{}}},"installed":true}""",
        ).single()
        val noChatKey = tools("""{"manifest":{"id":"aider","name":"Aider","bin":"aider"},"installed":true}""").single()

        assertTrue(withArgs.manifest.chat)
        assertFalse(withoutArgs.manifest.chat)
        assertFalse(noChatKey.manifest.chat)
    }

    @Test
    fun `gui_open names the harness and the project folder`() {
        val o = Json.parseToJsonElement(Proto.guiOpen("vscode", "C:/work/api")).jsonObject
        assertEquals("gui_open", o["type"]?.jsonPrimitive?.content)
        assertEquals("vscode", o["harness"]?.jsonPrimitive?.content)
        assertEquals("C:/work/api", o["cwd"]?.jsonPrimitive?.content)
    }

    @Test
    fun `a discovered app is launched by path, not by harness id`() {
        val gui = Json.parseToJsonElement(Proto.guiOpenPath("C:/apps/Zed.lnk", "")).jsonObject
        assertEquals("gui_open", gui["type"]?.jsonPrimitive?.content)
        assertEquals("C:/apps/Zed.lnk", gui["path"]?.jsonPrimitive?.content)
        assertNull(gui["harness"])

        val cli = Json.parseToJsonElement(Proto.createPath("C:/bin/claude.exe", "C:/work")).jsonObject
        assertEquals("create", cli["type"]?.jsonPrimitive?.content)
        assertEquals("C:/bin/claude.exe", cli["path"]?.jsonPrimitive?.content)
        assertEquals("C:/work", cli["cwd"]?.jsonPrimitive?.content)
    }

    @Test
    fun `apps parse into name, path and kind`() {
        val apps = Proto.parseApps(
            Json.parseToJsonElement(
                """{"items":[{"name":"Zed","path":"C:/apps/Zed.lnk","kind":"gui"},{"name":"claude","path":"C:/bin/claude.exe","kind":"cli"},{"name":"broken"}]}""",
            ),
        )
        assertEquals(2, apps.size)
        assertTrue(apps[0].isGui)
        assertFalse(apps[1].isGui)
        assertEquals("C:/bin/claude.exe", apps[1].path)
    }
}
