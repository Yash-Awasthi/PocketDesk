// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.File

/** Where a shared file goes: a live PC session's project folder, or a folder on the PC. */
data class ShareDestination(val sessionId: String?, val folder: String?) {
    val label: String
        get() = sessionId?.let { "Session $it" } ?: folder.orEmpty()

    fun encode(): String = if (sessionId != null) "s:$sessionId" else "f:${folder.orEmpty()}"
}

/** The transport the share route talks to; a fake stands in for it in the JVM tests. */
interface ShareTransport {
    val connected: Boolean
    val sessions: List<SessionSummary>
    val knownFolders: List<String>
    /** The terminal on screen, when exactly one session is live. Several means none is assumed. */
    val activeSession: SessionSummary?
    fun upload(remotePath: String, open: () -> java.io.InputStream?, size: Long?, onDone: (String?) -> Unit)
    fun handoff(text: String)
    fun filesCopied(paths: List<String>)
}

/** The real transport: the websocket client and the folders the Files surface already lists. */
object LinkShareTransport : ShareTransport {
    override val connected: Boolean get() = Link.client.status == Status.Connected
    override val sessions: List<SessionSummary> get() = Link.client.sessions
    override val knownFolders: List<String>
        get() = buildList {
            add("~/Downloads")
            Link.client.dirListing?.home?.let(::add)
            Link.client.dirListing?.path?.let(::add)
        }.distinct()
    override val activeSession: SessionSummary? get() = Link.client.sessions.singleOrNull()

    override fun upload(remotePath: String, open: () -> java.io.InputStream?, size: Long?, onDone: (String?) -> Unit) =
        Link.client.uploadFile(remotePath, open, size, {}, onDone)

    override fun handoff(text: String) {
        Link.client.sendRaw(buildJsonObject {
            put("type", JsonPrimitive("handoff"))
            put("text", JsonPrimitive(text))
        }.toString())
    }

    override fun filesCopied(paths: List<String>) {
        Link.client.sendRaw(buildJsonObject {
            put("type", JsonPrimitive("phone_copied"))
            put("files", JsonArray(paths.map { JsonPrimitive(it) }))
        }.toString())
    }
}

/**
 * Routes a file shared from another app to the live session, or to the folder the owner picked
 * last time. With no active session and no remembered choice it asks once and remembers the answer.
 */
object ShareRouter {
    @Volatile var transport: ShareTransport = LinkShareTransport
    /** One background lane keeps multiple files in the order they were shared. */
    @Volatile var worker: (() -> Unit) -> Unit = { task -> Thread(task, "share-route").start() }

    private const val PREFS = "pocketdesk"
    private const val KEY = "share_destination"

    fun share(
        ctx: Context,
        uris: List<Uri>,
        copy: Boolean,
        ask: (List<ShareDestination>, (ShareDestination) -> Unit) -> Unit,
        done: () -> Unit,
        notice: (String) -> Unit,
    ) {
        if (!transport.connected) {
            notice("Connect PocketDesk to your PC first")
            done()
            return
        }
        if (uris.isEmpty()) {
            done()
            return
        }
        val destination = transport.activeSession?.let { ShareDestination(it.id, null) }
            ?: remembered(ctx)
        if (destination == null) {
            val options = options()
            if (options.isEmpty()) {
                notice("No session or PC folder to send to")
                done()
            } else {
                ask(options) { picked ->
                    remember(ctx, picked)
                    route(ctx, uris, picked, copy, done, notice)
                }
            }
            return
        }
        route(ctx, uris, destination, copy, done, notice)
    }

    /** Links and text keep their old hand-off: the PC opens a link or pastes the text. */
    fun sendText(ctx: Context, text: String, copyToPc: Boolean, done: () -> Unit, notice: (String) -> Unit) {
        if (!transport.connected) {
            notice("Connect PocketDesk to your PC first")
            done()
            return
        }
        val body = if (Regex("^https?://\\S+$").matches(text)) com.yasha.pocketdesk.hub.Media.withPosition(text) else text
        transport.handoff(body)
        val opens = Regex("^https?://\\S+$").matches(text) && !copyToPc
        notice(if (opens) "Opening on your PC" else "On your PC's clipboard")
        done()
    }

    fun options(): List<ShareDestination> {
        val sessions = transport.sessions.map { ShareDestination(it.id, null) }
        val folders = transport.knownFolders.filter { it.isNotBlank() }.map { ShareDestination(null, it) }
        return sessions + folders
    }

    private fun remember(ctx: Context, destination: ShareDestination) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, destination.encode()).apply()
    }

    internal fun remembered(ctx: Context): ShareDestination? {
        val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return null
        val value = raw.substringAfter(':', "")
        if (value.isBlank()) return null
        return if (raw.startsWith("s:")) {
            transport.sessions.firstOrNull { it.id == value }?.let { ShareDestination(it.id, null) }
        } else {
            ShareDestination(null, value)
        }
    }

    private fun route(
        ctx: Context,
        uris: List<Uri>,
        destination: ShareDestination,
        copy: Boolean,
        done: () -> Unit,
        notice: (String) -> Unit,
    ) {
        val dir = destination.sessionId
            ?.let { id -> transport.sessions.firstOrNull { it.id == id }?.cwd }
            ?: destination.folder
        if (dir.isNullOrBlank()) {
            notice("That destination is gone; share again to pick another")
            done()
            return
        }
        worker {
            val cache = File(ctx.cacheDir, "share").apply { mkdirs() }
            val staged = ArrayList<Staged>()
            val taken = HashSet<String>()
            for (uri in uris) {
                val item = stage(ctx, uri, cache) ?: continue
                item.name = uniqueName(item.name, taken)
                taken += item.name
                staged += item
            }
            if (staged.isEmpty()) {
                notice("Could not read the shared files")
                done()
                return@worker
            }
            // The content:// grant lives only while this process does; the copy above is the
            // durable half, so the activity may close before the upload finishes.
            done()
            upload(ctx, staged, 0, dir, copy, notice, ArrayList())
        }
    }

    private class Staged(var name: String, val file: File)

    private fun stage(ctx: Context, uri: Uri, cache: File): Staged? {
        val name = safeName(displayName(ctx, uri))
        val file = File(cache, "${System.nanoTime()}-$name")
        return runCatching {
            ctx.contentResolver.openInputStream(uri)?.use { input ->
                file.outputStream().use { output -> input.copyTo(output, 64 * 1024) }
                Staged(name, file)
            }
        }.getOrNull() ?: runCatching { file.delete() }.let { null }
    }

    private fun upload(
        ctx: Context,
        staged: List<Staged>,
        index: Int,
        dir: String,
        copy: Boolean,
        notice: (String) -> Unit,
        sent: MutableList<String>,
    ) {
        if (index >= staged.size) {
            if (copy && sent.isNotEmpty()) transport.filesCopied(sent.toList())
            notice(if (copy) "${sent.size} file${if (sent.size == 1) "" else "s"} on the PC's clipboard"
                else "${sent.size} file${if (sent.size == 1) "" else "s"} sent to $dir")
            return
        }
        val item = staged[index]
        val remote = childPath(dir, item.name)
        transport.upload(remote, { item.file.inputStream() }, item.file.length()) { err ->
            item.file.delete()
            if (err != null) notice("${item.name}: $err") else sent += remote
            upload(ctx, staged, index + 1, dir, copy, notice, sent)
        }
    }

    private fun displayName(ctx: Context, uri: Uri): String = runCatching {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }.getOrNull() ?: uri.lastPathSegment?.substringAfterLast('/') ?: "shared-file"

    private fun safeName(name: String): String =
        name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "shared-file" }

    private fun uniqueName(name: String, taken: Set<String>): String {
        if (name.lowercase() !in taken.map { it.lowercase() }) return name
        val dot = name.lastIndexOf('.').takeIf { it > 0 } ?: name.length
        return generateSequence(1) { it + 1 }
            .map { "${name.substring(0, dot)} ($it)${name.substring(dot)}" }
            .first { it.lowercase() !in taken.map { t -> t.lowercase() } }
    }

    /** Test hook: puts the real transport and lane back after a fake one. */
    internal fun resetTransport() {
        transport = LinkShareTransport
        worker = { task -> Thread(task, "share-route").start() }
    }
}
