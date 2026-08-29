package com.yasha.pocketdesk

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

data class Manifest(val id: String, val name: String, val bin: String)

data class ToolInfo(
    val manifest: Manifest,
    val installed: Boolean?,
    val version: String?,
    val installing: Boolean,
)

data class SessionSummary(val id: String, val harnessId: String, val cwd: String)

sealed interface ChatItem {
    data class User(val text: String) : ChatItem
    data class Assistant(val text: String) : ChatItem
    data class Tool(val name: String, val detail: String) : ChatItem
    data class ToolResult(val text: String) : ChatItem
    data class System(val text: String) : ChatItem
}

data class ChatSummary(
    val id: String,
    val harnessId: String,
    val cwd: String,
    val state: String,
    val preview: String,
)

data class FsEntry(val name: String, val isDir: Boolean, val size: Long?)

data class FsListing(val path: String, val parent: String?, val items: List<FsEntry>)

sealed interface RhEvent {
    data class Created(val id: String) : RhEvent
    data class Exit(val id: String, val harnessId: String, val code: Int) : RhEvent
    data class Failure(val message: String) : RhEvent
    data class TrustNeeded(val fingerprint: String) : RhEvent
}

object Proto {
    private fun str(o: JsonObject, key: String): String? = (o[key] as? JsonPrimitive)?.contentOrNull
    private fun bool(o: JsonObject, key: String): Boolean? = (o[key] as? JsonPrimitive)?.booleanOrNull

    private fun obj(build: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit) =
        buildJsonObject(build).toString()

    fun hello(token: String) = obj { put("type", "hello"); put("token", token) }
    fun detect() = obj { put("type", "detect") }
    fun install(id: String) = obj { put("type", "install"); put("id", id) }
    fun create(harness: String, cwd: String) = obj {
        put("type", "create"); put("harness", harness); put("cwd", cwd)
    }

    fun attach(id: String) = obj { put("type", "attach"); put("id", id) }
    fun detach(id: String) = obj { put("type", "detach"); put("id", id) }
    fun input(id: String, dataB64: String) = obj {
        put("type", "in"); put("id", id); put("data", dataB64)
    }

    fun resize(id: String, cols: Int, rows: Int) = obj {
        put("type", "resize"); put("id", id); put("cols", cols); put("rows", rows)
    }

    fun kill(id: String) = obj { put("type", "kill"); put("id", id) }

    fun chatSession(harness: String, cwd: String, prompt: String?) = obj {
        put("type", "chatsession"); put("harness", harness); put("cwd", cwd)
        if (!prompt.isNullOrBlank()) put("prompt", prompt)
    }

    fun chatMsg(id: String, text: String) = obj {
        put("type", "chatmsg"); put("id", id); put("text", text)
    }

    fun chatCancel(id: String) = obj { put("type", "chatcancel"); put("id", id) }
    fun fs(path: String?) = obj { put("type", "fs"); put("path", path ?: "") }
    fun fread(path: String, offset: Long) = obj {
        put("type", "fread"); put("path", path); put("offset", offset)
    }

    fun fwrite(path: String, chunkB64: String, append: Boolean) = obj {
        put("type", "fwrite"); put("path", path); put("data", chunkB64); put("append", append)
    }

    fun parseTools(el: JsonElement?): List<ToolInfo> {
        val arr = (el as? JsonObject)?.get("items") as? JsonArray ?: return emptyList()
        return arr.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val m = o["manifest"] as? JsonObject ?: return@mapNotNull null
            val id = str(m, "id") ?: return@mapNotNull null
            ToolInfo(
                manifest = Manifest(id = id, name = str(m, "name") ?: id, bin = str(m, "bin") ?: id),
                installed = bool(o, "installed"),
                version = str(o, "version"),
                installing = bool(o, "installing") ?: false,
            )
        }
    }

    fun parseSessions(el: JsonElement?): List<SessionSummary> {
        val arr = (el as? JsonObject)?.get("items") as? JsonArray ?: return emptyList()
        return arr.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            if (str(o, "kind") == "chat") return@mapNotNull null
            SessionSummary(
                id = str(o, "id") ?: return@mapNotNull null,
                harnessId = str(o, "harnessId") ?: "",
                cwd = str(o, "cwd") ?: "",
            )
        }
    }

    fun parseChats(el: JsonElement?): List<ChatSummary> {
        val arr = (el as? JsonObject)?.get("items") as? JsonArray ?: return emptyList()
        return arr.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            if (str(o, "kind") != "chat") return@mapNotNull null
            ChatSummary(
                id = str(o, "id") ?: return@mapNotNull null,
                harnessId = str(o, "harnessId") ?: "",
                cwd = str(o, "cwd") ?: "",
                state = str(o, "state") ?: "idle",
                preview = str(o, "preview") ?: "",
            )
        }
    }

    fun parseChatReplay(arr: JsonElement?): List<ChatItem> {
        val items = arr as? JsonArray ?: return emptyList()
        return items.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            when (str(o, "role")) {
                "user" -> ChatItem.User(str(o, "text") ?: "")
                "assistant" -> ChatItem.Assistant(str(o, "text") ?: "")
                "tool" -> ChatItem.Tool(name = str(o, "name") ?: "", detail = str(o, "detail") ?: "")
                "toolresult" -> ChatItem.ToolResult(str(o, "text") ?: "")
                "system" -> ChatItem.System(str(o, "text") ?: "")
                else -> null
            }
        }
    }

    fun parseFs(el: JsonElement?): FsListing? {
        val o = el as? JsonObject ?: return null
        if (o["error"] != null) return null
        val items = (o["items"] as? JsonArray)
            ?.mapNotNull { e ->
                val it = e as? JsonObject ?: return@mapNotNull null
                FsEntry(
                    name = str(it, "name") ?: return@mapNotNull null,
                    isDir = bool(it, "dir") ?: false,
                    size = (it["size"] as? JsonPrimitive)?.longOrNull,
                )
            }
            ?: return null
        return FsListing(path = str(o, "path") ?: "", parent = str(o, "parent"), items = items)
    }

    fun exitCode(m: JsonObject): Int = (m["code"] as? JsonPrimitive)?.intOrNull ?: 0
}
