package com.yasha.pocketdesk

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

enum class Status { Disconnected, Connecting, AwaitingTrust, Connected }

class WsClient(private val base: OkHttpClient = OkHttpClient()) {

    var status by mutableStateOf(Status.Disconnected)
        private set
    var tools by mutableStateOf<List<ToolInfo>>(emptyList())
        private set
    var sessions by mutableStateOf<List<SessionSummary>>(emptyList())
        private set
    var progress by mutableStateOf<Map<String, String>>(emptyMap())
        private set
    var dirListing by mutableStateOf<FsListing?>(null)
        private set
    var lastError by mutableStateOf<String?>(null)
        private set
    var activeUrl: String? = null
        private set

    val events = MutableSharedFlow<RhEvent>(extraBufferCapacity = 256)

    /** Terminal output router: (sessionId, base64 chunk). Set by the terminal screen. */
    var onTerminalData: ((String, String) -> Unit)? = null

    private val socket = AtomicReference<WebSocket?>(null)
    private var hello: String? = null
    private var collectingTm: Tls.CollectingTrustManager? = null

    fun connect(url: String, token: String, pinnedFingerprint: String?) {
        close()
        status = Status.Connecting
        activeUrl = url
        lastError = null
        hello = Proto.hello(token)
        collectingTm = null

        val client: OkHttpClient = when {
            !url.startsWith("wss") -> base
            pinnedFingerprint != null -> Tls.pinnedClient(base, pinnedFingerprint)
            else -> Tls.collectingClient(base).also { collectingTm = it.second }.first
        }

        socket.set(client.newWebSocket(Request.Builder().url(url).build(), listener))
    }

    /** Called by the UI after the user accepted (or rejected) a self-signed certificate. */
    fun resolveTrust(accepted: Boolean) {
        collectingTm = null
        if (accepted) {
            hello?.let { socket.get()?.send(it) }
        } else {
            socket.getAndSet(null)?.close(4000, "cert rejected")
            status = Status.Disconnected
            lastError = "certificate rejected"
        }
    }

    fun close() {
        socket.getAndSet(null)?.close(1000, "bye")
        status = Status.Disconnected
        collectingTm = null
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            val tm = collectingTm
            if (tm != null) {
                val fp = tm.seen
                if (fp == null) {
                    webSocket.close(4000, "no certificate presented")
                    status = Status.Disconnected
                    lastError = "server presented no certificate"
                    return
                }
                status = Status.AwaitingTrust
                events.tryEmit(RhEvent.TrustNeeded(fp))
            } else {
                hello?.let { webSocket.send(it) }
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            status = Status.Disconnected
            lastError = t.message ?: "connection failed"
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            status = Status.Disconnected
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            handle(text)
        }
    }

    private fun send(line: String): Boolean {
        val ws = socket.get() ?: return false
        return ws.send(line)
    }

    fun rescan(): Boolean = send(Proto.detect())
    fun install(id: String): Boolean = send(Proto.install(id))
    fun createSession(harness: String, cwd: String): Boolean = send(Proto.create(harness, cwd))
    fun attach(id: String): Boolean = send(Proto.attach(id))
    fun detach(id: String): Boolean = send(Proto.detach(id))
    fun sendInput(id: String, dataB64: String): Boolean = send(Proto.input(id, dataB64))
    fun sendResize(id: String, cols: Int, rows: Int): Boolean = send(Proto.resize(id, cols, rows))
    fun kill(id: String): Boolean = send(Proto.kill(id))
    fun browse(path: String?): Boolean = send(Proto.fs(path))

    private val transfers = HashMap<String, Transfer>()

    /** Stop-and-wait chunked download; sink receives decoded bytes sequentially. */
    fun downloadFile(
        remotePath: String,
        sink: (ByteArray) -> Unit,
        onProgress: (transferred: Long, total: Long?) -> Unit,
        onDone: (error: String?) -> Unit,
    ) {
        transfers[remotePath] = Transfer.Download(remotePath, sink, onProgress, onDone)
        readFileChunk(remotePath, 0)
    }

    /** Streams [source] up in base64 chunks; waits for each ack before the next. */
    fun uploadFile(
        remotePath: String,
        openSource: () -> java.io.InputStream?,
        sizeHint: Long?,
        onProgress: (Long) -> Unit,
        onDone: (error: String?) -> Unit,
    ) {
        val stream = openSource()
        if (stream == null) {
            onDone("could not open selected file")
            return
        }
        val up = Transfer.Upload(remotePath, stream, sizeHint, onProgress, onDone)
        transfers[remotePath] = up
        up.sendNext(this)
    }

    private fun onFChunk(m: JsonObject) {
        val path = str(m, "path") ?: return
        val t = transfers[path] as? Transfer.Download ?: return
        val err = str(m, "error")
        if (err != null) {
            transfers.remove(path)
            t.onDone(err)
            return
        }
        val data = str(m, "data") ?: ""
        val bytes = java.util.Base64.getDecoder().decode(data)
        if (bytes.isNotEmpty()) t.sink(bytes)
        val done = bool(m, "eof") ?: false
        val at = (num(m, "offset") ?: 0L) + bytes.size
        t.onProgress(at, num(m, "size"))
        if (done) {
            transfers.remove(path)
            t.onDone(null)
        } else {
            readFileChunk(path, at)
        }
    }

    private fun onFWritten(m: JsonObject) {
        val path = str(m, "path") ?: return
        val t = transfers[path] as? Transfer.Upload ?: return
        val err = str(m, "error")
        if (err != null) {
            transfers.remove(path)
            t.finish(err)
            return
        }
        t.acked(num(m, "size"))
        if (!t.sendNext(this)) transfers.remove(path)
    }

    private sealed class Transfer {
        class Download(
            val path: String,
            val sink: (ByteArray) -> Unit,
            val onProgress: (Long, Long?) -> Unit,
            val onDone: (String?) -> Unit,
        ) : Transfer()

        class Upload(
            val path: String,
            val stream: java.io.InputStream,
            val sizeHint: Long?,
            val onProgress: (Long) -> Unit,
            val onDone: (String?) -> Unit,
        ) : Transfer() {
            var offset: Long = 0

            /** Returns false when the stream is fully sent. */
            fun sendNext(ws: WsClient): Boolean {
                val buf = ByteArray(192 * 1024)
                val n = try {
                    stream.read(buf)
                } catch (e: Exception) {
                    onDone(e.message ?: "read failed")
                    close()
                    return false
                }
                if (n <= 0) {
                    onDone(null)
                    close()
                    return false
                }
                val b64 = java.util.Base64.getEncoder().encodeToString(if (n == buf.size) buf else buf.copyOf(n))
                offset += n
                ws.writeFileChunk(path, b64, append = offset > n)
                onProgress(offset)
                return true
            }

            fun finish(error: String?) {
                onDone(error)
                close()
            }

            fun acked(totalOnRemote: Long?) {
                if (totalOnRemote != null) onProgress(totalOnRemote)
            }

            fun close() {
                try {
                    stream.close()
                } catch (_: java.io.IOException) {
                }
            }
        }
    }

    fun readFileChunk(path: String, offset: Long): Boolean = send(Proto.fread(path, offset))
    fun writeFileChunk(path: String, chunkB64: String, append: Boolean): Boolean =
        send(Proto.fwrite(path, chunkB64, append))

    private fun handle(text: String) {
        val m = runCatching {
            Json.parseToJsonElement(text) as? JsonObject
        }.getOrNull() ?: return
        when (val type = m["type"]?.jsonPrimitive?.contentOrNull) {
            "welcome" -> {
                tools = Proto.parseTools(m)
                sessions = Proto.parseSessions(m)
                status = Status.Connected
            }
            "manifests" -> tools = Proto.parseTools(m)
            "sessions" -> sessions = Proto.parseSessions(m)
            "created" -> str(m, "id")?.let { events.tryEmit(RhEvent.Created(it)) }
            "out", "replay" -> {
                val id = str(m, "id") ?: return
                val data = str(m, "data") ?: return
                onTerminalData?.invoke(id, data)
            }
            "exit" -> {
                val id = str(m, "id") ?: return
                val harnessId = sessions.firstOrNull { it.id == id }?.harnessId ?: id
                sessions = sessions.filterNot { it.id == id }
                events.tryEmit(RhEvent.Exit(id, harnessId, Proto.exitCode(m)))
            }
            "progress" -> {
                val id = str(m, "id") ?: return
                val line = str(m, "line") ?: return
                progress = progress.toMutableMap().apply {
                    merge(id, line) { a, b -> (a + "\n" + b).takeLast(2000) }
                }
            }
            "fs" -> dirListing = Proto.parseFs(m)
            "fchunk" -> onFChunk(m)
            "fwritten" -> onFWritten(m)
            "error" -> {
                val msg = str(m, "message") ?: "unknown error"
                lastError = msg
                events.tryEmit(RhEvent.Failure(msg))
            }
            else -> {}
        }
    }

    private fun bool(o: JsonObject, key: String): Boolean? = o[key]?.jsonPrimitive?.booleanOrNull

    private fun num(o: JsonObject, key: String): Long? = o[key]?.jsonPrimitive?.contentOrNull?.toLongOrNull()

    private fun str(o: JsonObject, key: String): String? = o[key]?.jsonPrimitive?.contentOrNull
}
