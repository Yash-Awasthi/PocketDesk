package com.yasha.pocketdesk

import kotlinx.serialization.json.Json
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

/**
 * A daemon manifest. `bin` is absent for a GUI application, which has no
 * command and is started by absolute path instead. `chat` is present only for
 * agents that can stream a conversation.
 */
data class Manifest(
    val id: String,
    val name: String,
    val bin: String?,
    val adapter: String = ADAPTER_TERMINAL,
    val chat: Boolean = false,
    /** Account commands the manifest declares: status, login, logout. */
    val auth: Set<String> = emptySet(),
) {
    val isGui: Boolean get() = adapter == ADAPTER_GUI

    companion object {
        const val ADAPTER_TERMINAL = "terminal"
        const val ADAPTER_GUI = "gui"
    }
}

data class ToolInfo(
    val manifest: Manifest,
    val installed: Boolean?,
    val version: String?,
    val installing: Boolean,
)

data class SessionSummary(val id: String, val harnessId: String, val cwd: String)

/**
 * An application found on the PC that ships no manifest. `path` is what the
 * daemon launches; it only accepts paths it discovered itself.
 */
data class AppEntry(val name: String, val path: String, val kind: String) {
    val isGui: Boolean get() = kind == "gui"
}

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

data class FbSkill(val name: String, val description: String, val dir: String)

/** A Freebuff account saved on the PC; its session token never leaves the PC. */
data class FbAccount(val email: String, val name: String, val current: Boolean)
data class FbConfig(val name: String, val size: Long, val mtime: String)

/** One captured desktop frame: base64 JPEG, full virtual-screen geometry. */
data class DesktopFrame(val base64: String, val width: Int, val height: Int)

/** A file or folder on the PC clipboard. */
data class PcFile(val path: String, val name: String, val size: Long?, val dir: Boolean)

/** PC clipboard content; [requested] is false when the PC copied something on its own. */
data class PcClip(val kind: String, val text: String?, val png: String?, val files: List<PcFile>, val requested: Boolean)

/** The PC pointer in picture pixels; [shape] is a CSS cursor name such as "arrow" or "text". */
data class DesktopCursor(val x: Int, val y: Int, val shape: String)

data class FsListing(val path: String, val parent: String?, val items: List<FsEntry>)


/** The daemon's own SSH listeners, addressed by protocol prefix. */
val SSH_SERVERS = listOf("bastion", "sshserver")

const val LINE_BREAK = "\n"

/** One saved SSH/SFTP/VNC target. `keyId` selects key auth; absent means password. */
data class SshProfile(
    val id: String,
    val name: String,
    val host: String,
    val port: Int,
    val username: String,
    val keyId: String?,
)

data class SshKey(val id: String, val name: String, val type: String, val fingerprint: String)

data class KnownHost(val keyId: String, val type: String, val fingerprint: String)

/** Start/stop state of one of the daemon's own SSH listeners. */
data class ServerStat(val running: Boolean, val port: Int?, val activeSessions: Int, val totalUsers: Int)

data class DoctorCheck(val name: String, val ok: Boolean, val detail: String, val hint: String?)

data class GitFile(val state: String, val path: String)

data class GitStatus(val ok: Boolean, val branch: String, val upstream: String?, val files: List<GitFile>, val error: String?)

sealed interface RhEvent {
    data class Created(val id: String) : RhEvent
    data class Exit(val id: String, val harnessId: String, val code: Int) : RhEvent
    data class Failure(val message: String) : RhEvent
    data class TrustNeeded(val fingerprint: String) : RhEvent

    /** A GUI app started on the PC; the phone follows it on the desktop view. */
    data class GuiOpened(val name: String) : RhEvent

    /** A host key seen for the first time, or one that no longer matches. */
    data class HostKeySeen(val host: String, val fingerprint: String, val changed: Boolean) : RhEvent

    /** Result of a profile_connect attempt — the SSH screen reports both ways. */
    data class SshConnect(val ok: Boolean, val detail: String) : RhEvent
}

object Proto {
    private fun str(o: JsonObject, key: String): String? = (o[key] as? JsonPrimitive)?.contentOrNull
    private fun bool(o: JsonObject, key: String): Boolean? = (o[key] as? JsonPrimitive)?.booleanOrNull

    private fun obj(build: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit) =
        buildJsonObject(build).toString()

    fun hello(token: String) = obj {
        put("type", "hello"); put("token", token)
        put("name", android.os.Build.MODEL); put("platform", "android")
    }
    fun detect() = obj { put("type", "detect") }
    fun install(id: String) = obj { put("type", "install"); put("id", id) }
    fun guiOpen(id: String, cwd: String) = obj {
        put("type", "gui_open"); put("harness", id); put("cwd", cwd)
    }

    fun auth(op: String, harness: String, cwd: String) = obj {
        put("type", "auth_$op"); put("harness", harness); put("cwd", cwd)
    }

    fun guiOpenPath(path: String, cwd: String) = obj {
        put("type", "gui_open"); put("path", path); put("cwd", cwd)
    }

    fun create(harness: String, cwd: String) = obj {
        put("type", "create"); put("harness", harness); put("cwd", cwd)
    }

    fun createPath(path: String, cwd: String) = obj {
        put("type", "create"); put("path", path); put("cwd", cwd)
    }

    fun appsDiscover(q: String, refresh: Boolean) = obj {
        put("type", "apps_discover"); put("q", q); put("refresh", refresh)
    }

    fun attach(id: String) = obj { put("type", "attach"); put("id", id) }
    fun attachSince(id: String, since: Long) = obj {
        put("type", "attach"); put("id", id); put("since", since)
    }
    fun detach(id: String) = obj { put("type", "detach"); put("id", id) }
    fun input(id: String, dataB64: String) = obj {
        put("type", "in"); put("id", id); put("data", dataB64)
    }

    fun resize(id: String, cols: Int, rows: Int) = obj {
        put("type", "resize"); put("id", id); put("cols", cols); put("rows", rows)
    }

    fun kill(id: String) = obj { put("type", "kill"); put("id", id) }

    // ── Desktop control (AnyDesk-style watch + full input) ──
    fun desktopStart(quality: Int) = obj { put("type", "desktop_start"); put("quality", quality) }
    fun desktopStartVideo(preset: String, monitor: Int, viewOnly: Boolean) = obj {
        put("type", "desktop_start"); put("video", true); put("preset", preset); put("monitor", monitor)
        if (viewOnly) put("viewOnly", true)
    }
    fun desktopMonitors() = obj { put("type", "desktop_monitors") }
    fun desktopPing(t: Long) = obj { put("type", "desktop_ping"); put("t", t) }
    fun clipboardGet() = obj { put("type", "clipboard_get") }
    fun clipboardSet(text: String?, png: String? = null, files: List<String>? = null, paste: Boolean = false) = obj {
        put("type", "clipboard_set")
        if (text != null) put("text", text)
        if (png != null) put("png", png)
        if (files != null) put("files", JsonArray(files.map { JsonPrimitive(it) }))
        if (paste) put("paste", true)
    }
    fun desktopStop() = obj { put("type", "desktop_stop") }
    fun desktopFrame() = obj { put("type", "desktop_frame") }
    fun desktopMouse(x: Int?, y: Int?, click: String?, wheel: Int?, press: String? = null, button: String? = null) = obj {
        put("type", "desktop_mouse")
        if (x != null && y != null) { put("x", x); put("y", y) }
        if (click != null) put("click", click)
        if (wheel != null) put("wheel", wheel)
        if (press != null) put("press", press)
        if (button != null) put("button", button)
    }
    fun desktopKey(vk: Int, modifiers: List<String>, press: String? = null) = obj {
        put("type", "desktop_key"); put("key", vk)
        put("modifiers", JsonArray(modifiers.map { JsonPrimitive(it) }))
        if (press != null) put("press", press)
    }
    fun desktopType(text: String) = obj { put("type", "desktop_type"); put("text", text) }

    // ── Freebuff control (fb_*) ──
    fun fbStatus() = obj { put("type", "fb_status") }
    fun fbSkillList() = obj { put("type", "fb_skill_list") }
    fun fbSkillGet(name: String) = obj { put("type", "fb_skill_get"); put("name", name) }
    fun fbSkillRun(name: String, harness: String, args: String?) = obj {
        put("type", "fb_skill_run"); put("name", name); put("harness", harness)
        if (args != null) put("args", args)
    }
    fun fbConfigList() = obj { put("type", "fb_config_list") }
    fun fbConfigGet(name: String) = obj { put("type", "fb_config_get"); put("name", name) }
    fun fbConfigSet(name: String, patchJson: String) = obj {
        put("type", "fb_config_set"); put("name", name)
        put("patch", Json.parseToJsonElement(patchJson))
    }
    fun fbAuthStatus() = obj { put("type", "fb_auth_status") }
    fun fbAuthLogout() = obj { put("type", "fb_auth_logout"); put("confirm", "CLEAR") }
    fun fbAccounts() = obj { put("type", "fb_accounts") }
    fun fbAccountSwitch(email: String) = obj { put("type", "fb_account_switch"); put("email", email) }
    fun fbAccountForget(email: String) = obj { put("type", "fb_account_forget"); put("email", email) }
    fun fbAppOpen() = obj { put("type", "fb_app_open") }
    fun fbAppQuit() = obj { put("type", "fb_app_quit") }

    // ── Model selection ──
    fun modelList(chatId: String) = obj { put("type", "model_list"); put("id", chatId) }
    fun chatModelSet(chatId: String, model: String?) = obj {
        put("type", "chat_model_set"); put("id", chatId)
        if (model != null) put("model", model)
    }

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


    // ── SSH: profiles, keys, known hosts, the daemon's own listeners ──
    fun profileList() = obj { put("type", "profile_list") }
    fun profileCreate(name: String, host: String, port: Int, username: String, keyId: String?) = obj {
        put("type", "profile_create"); put("name", name); put("host", host); put("port", port)
        put("username", username); put("authMethod", if (keyId != null) "key" else "password")
        put("protocols", JsonArray(listOf(JsonPrimitive("ssh"), JsonPrimitive("sftp"), JsonPrimitive("vnc"))))
        if (keyId != null) put("keyId", keyId)
    }
    fun profileDelete(id: String) = obj { put("type", "profile_delete"); put("id", id) }
    fun profileConnect(id: String, protocol: String, secret: String?, usesKey: Boolean) = obj {
        put("type", "profile_connect"); put("id", id); put("protocol", protocol)
        if (!secret.isNullOrEmpty()) put(if (usesKey) "passphrase" else "password", secret)
    }
    fun sshKeyList() = obj { put("type", "sshkey_list") }
    fun sshKeyGenerate(algo: String, name: String, passphrase: String?) = obj {
        put("type", "sshkey_generate"); put("algo", algo); put("name", name)
        if (!passphrase.isNullOrEmpty()) put("passphrase", passphrase)
    }
    fun sshKeyDelete(id: String) = obj { put("type", "sshkey_delete"); put("id", id) }
    fun hostKeyList() = obj { put("type", "hostkey_list") }
    fun mprotoStatus() = obj { put("type", "mproto_status") }
    fun serverStart(kind: String, port: Int, host: String) = obj {
        put("type", kind + "_start"); put("port", port); put("host", host)
    }
    fun serverStop(kind: String) = obj { put("type", kind + "_stop") }
    fun serverStats(kind: String) = obj { put("type", kind + "_stats") }

    // ── Tools: doctor + git ──
    fun doctor() = obj { put("type", "doctor") }
    fun gitStatus(cwd: String) = obj { put("type", "git_status"); put("cwd", cwd) }
    fun gitLog(cwd: String, limit: Int) = obj { put("type", "git_log"); put("cwd", cwd); put("limit", limit) }
    fun gitDiff(cwd: String) = obj { put("type", "git_diff"); put("cwd", cwd) }

    fun parseTools(el: JsonElement?): List<ToolInfo> {
        // welcome sends `manifests`; rescan broadcasts send `items`.
        val o = el as? JsonObject ?: return emptyList()
        val arr = (o["items"] as? JsonArray) ?: (o["manifests"] as? JsonArray) ?: return emptyList()
        return arr.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val m = o["manifest"] as? JsonObject ?: return@mapNotNull null
            val id = str(m, "id") ?: return@mapNotNull null
            ToolInfo(
                manifest = Manifest(
                    id = id,
                    name = str(m, "name") ?: id,
                    bin = str(m, "bin"),
                    adapter = str(m, "adapter") ?: Manifest.ADAPTER_TERMINAL,
                    // The daemon treats a chat adapter as present only when the
                    // manifest carries the runtime args for it.
                    chat = (m["chat"] as? JsonObject)?.containsKey("args") == true,
                    auth = (m["auth"] as? JsonObject)?.keys ?: emptySet(),
                ),
                installed = bool(o, "installed"),
                version = str(o, "version"),
                installing = bool(o, "installing") ?: false,
            )
        }
    }

    fun parseApps(el: JsonElement?): List<AppEntry> {
        val arr = (el as? JsonObject)?.get("items") as? JsonArray ?: return emptyList()
        return arr.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            AppEntry(
                name = str(o, "name") ?: return@mapNotNull null,
                path = str(o, "path") ?: return@mapNotNull null,
                kind = str(o, "kind") ?: "cli",
            )
        }
    }

    fun parseSessions(el: JsonElement?): List<SessionSummary> {
        // welcome sends `sessions`; refreshes broadcast `items`.
        val o = el as? JsonObject ?: return emptyList()
        val arr = (o["items"] as? JsonArray) ?: (o["sessions"] as? JsonArray) ?: return emptyList()
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
        // welcome sends `sessions` (mixed kinds); refreshes broadcast `items`.
        val o = el as? JsonObject ?: return emptyList()
        val arr = (o["items"] as? JsonArray) ?: (o["sessions"] as? JsonArray) ?: return emptyList()
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


    private fun items(el: JsonElement?): List<JsonObject> =
        ((el as? JsonObject)?.get("items") as? JsonArray)?.filterIsInstance<JsonObject>() ?: emptyList()

    fun parseProfiles(el: JsonElement?): List<SshProfile> = items(el).mapNotNull {
        SshProfile(
            id = str(it, "id") ?: return@mapNotNull null,
            name = str(it, "name") ?: "",
            host = str(it, "host") ?: "",
            port = (it["port"] as? JsonPrimitive)?.intOrNull ?: 22,
            username = str(it, "username") ?: "",
            keyId = str(it, "keyId"),
        )
    }

    fun parseSshKeys(el: JsonElement?): List<SshKey> = items(el).mapNotNull {
        SshKey(
            id = str(it, "id") ?: return@mapNotNull null,
            name = str(it, "name") ?: "",
            type = str(it, "type") ?: "",
            fingerprint = str(it, "fingerprint") ?: "",
        )
    }

    fun parseHostKeys(el: JsonElement?): List<KnownHost> = items(el).mapNotNull {
        KnownHost(
            keyId = str(it, "keyId") ?: return@mapNotNull null,
            type = str(it, "type") ?: "",
            fingerprint = str(it, "fingerprint") ?: "",
        )
    }

    fun parseServerStat(m: JsonObject) = ServerStat(
        running = bool(m, "running") ?: false,
        port = (m["port"] as? JsonPrimitive)?.intOrNull,
        activeSessions = (m["activeSessions"] as? JsonPrimitive)?.intOrNull ?: 0,
        totalUsers = (m["totalUsers"] as? JsonPrimitive)?.intOrNull ?: 0,
    )

    fun parseDoctor(m: JsonObject): List<DoctorCheck> =
        (m["checks"] as? JsonArray)?.filterIsInstance<JsonObject>()?.mapNotNull {
            DoctorCheck(
                name = str(it, "name") ?: return@mapNotNull null,
                ok = bool(it, "ok") ?: false,
                detail = str(it, "detail") ?: "",
                hint = str(it, "hint"),
            )
        } ?: emptyList()

    fun parseGitStatus(m: JsonObject) = GitStatus(
        ok = bool(m, "ok") ?: false,
        branch = str(m, "branch") ?: "",
        upstream = str(m, "upstream"),
        files = (m["files"] as? JsonArray)?.filterIsInstance<JsonObject>()?.map {
            GitFile(state = str(it, "x") ?: "", path = str(it, "path") ?: "")
        } ?: emptyList(),
        error = str(m, "error"),
    )

    fun exitCode(m: JsonObject): Int = (m["code"] as? JsonPrimitive)?.intOrNull ?: 0
}

/** Joins a remote child path using the separator the daemon's own listing uses (Windows or POSIX host). */
fun childPath(dir: String, name: String): String {
    val sep = if (dir.contains('\\')) '\\' else '/'
    return dir.trimEnd('\\', '/') + sep + name
}
