package com.yasha.pocketdesk

import android.content.Context
import android.os.Environment
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.File
import java.io.RandomAccessFile

/**
 * The PC browses and edits this phone's shared storage. Android's "All files access", switched on by
 * the owner, is the consent; without it every request is refused and the owner is shown where to allow it.
 */
object PhoneStorage {
    private val io = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private const val CHUNK = 256 shl 10

    fun handle(app: Context, m: JsonObject) = io.launch {
        val rid = (m["rid"] as? JsonPrimitive)?.longOrNull ?: return@launch
        val reply = runCatching { answer(app, m) }.getOrElse { buildJsonObject { put("error", it.message ?: "failed") } }
        Link.client.phoneFsResult(rid, reply)
    }

    private fun answer(app: Context, m: JsonObject): JsonObject {
        if (!Environment.isExternalStorageManager()) {
            Notifier.storageRequest(app)
            error("Storage access is off on the phone: allow \"All files access\" for PocketDesk (a notification on the phone opens it)")
        }
        fun s(k: String) = (m[k] as? JsonPrimitive)?.content
        val file = resolve(s("path") ?: "/")
        return when (s("op")) {
            "list" -> buildJsonObject {
                val items = file.listFiles() ?: error("not a folder: ${s("path")}")
                put("path", rel(file))
                put("items", buildJsonArray {
                    for (f in items.sortedWith(compareBy({ !it.isDirectory }, { it.name.lowercase() }))) add(buildJsonObject {
                        put("name", f.name); put("dir", f.isDirectory); put("size", f.length()); put("mtime", f.lastModified())
                    })
                })
            }
            "read" -> {
                val offset = (m["offset"] as? JsonPrimitive)?.longOrNull ?: 0L
                RandomAccessFile(file, "r").use { r ->
                    r.seek(offset)
                    val buf = ByteArray(minOf(CHUNK.toLong(), maxOf(0L, r.length() - offset)).toInt())
                    r.readFully(buf)
                    buildJsonObject {
                        put("size", r.length()); put("offset", offset)
                        put("data", java.util.Base64.getEncoder().encodeToString(buf))
                        put("eof", offset + buf.size >= r.length())
                    }
                }
            }
            "write" -> {
                val bytes = java.util.Base64.getDecoder().decode(s("data") ?: "")
                val append = (m["append"] as? JsonPrimitive)?.booleanOrNull == true
                file.parentFile?.mkdirs()
                java.io.FileOutputStream(file, append).use { it.write(bytes) }
                buildJsonObject { put("ok", true); put("size", file.length()) }
            }
            "mkdir" -> buildJsonObject { put("ok", file.mkdirs() || file.isDirectory) }
            "delete" -> buildJsonObject { put("ok", file != root() && file.deleteRecursively()) }
            "rename" -> buildJsonObject { put("ok", file.renameTo(resolve(s("to") ?: error("rename: missing target")))) }
            else -> error("unknown op: ${s("op")}")
        }
    }

    private fun root(): File = Environment.getExternalStorageDirectory().canonicalFile

    /** A path under shared storage; anything that climbs out of it is refused. */
    private fun resolve(path: String): File {
        val f = File(root(), path.trimStart('/')).canonicalFile
        require(f == root() || f.path.startsWith(root().path + File.separator)) { "outside phone storage: $path" }
        return f
    }

    private fun rel(f: File) = "/" + f.path.removePrefix(root().path).trimStart(File.separatorChar)
}
