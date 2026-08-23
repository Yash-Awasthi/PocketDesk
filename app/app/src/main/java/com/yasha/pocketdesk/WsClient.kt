package com.yasha.pocketdesk

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

enum class Status { Disconnected, Connecting, Connected }

class WsClient(private val client: OkHttpClient = OkHttpClient()) {

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

    val events = MutableSharedFlow<RhEvent>(extraBufferCapacity = 64)

    /** Terminal output router: (sessionId, base64 chunk). Set by the terminal screen. */
    var onTerminalData: ((String, String) -> Unit)? = null

    private var socket: WebSocket? = null

    fun connect(url: String, token: String) {
        close()
        status = Status.Connecting
        lastError = null
        socket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(Proto.hello(token))
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
        })
    }

    fun close() {
        socket?.close(1000, "bye")
        socket = null
        status = Status.Disconnected
    }

    private fun send(line: String) {
        socket?.send(line)
    }

    fun rescan() = send(Proto.detect())
    fun install(id: String) = send(Proto.install(id))
    fun createSession(harness: String, cwd: String) = send(Proto.create(harness, cwd))
    fun attach(id: String) = send(Proto.attach(id))
    fun detach(id: String) = send(Proto.detach(id))
    fun sendInput(id: String, dataB64: String) = send(Proto.input(id, dataB64))
    fun sendResize(id: String, cols: Int, rows: Int) = send(Proto.resize(id, cols, rows))
    fun kill(id: String) = send(Proto.kill(id))
    fun browse(path: String?) = send(Proto.fs(path))

    private fun handle(text: String) {
        val m = runCatching {
            Json.parseToJsonElement(text) as? JsonObject
        }.getOrNull() ?: return
        when (m["type"]?.jsonPrimitive?.contentOrNull) {
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
                val data = str(m, "data") ?: ""
                onTerminalData?.invoke(id, data)
            }
            "exit" -> {
                val id = str(m, "id") ?: return
                sessions = sessions.filterNot { it.id == id }
                events.tryEmit(RhEvent.Exit(id, (m["code"] as? JsonPrimitive)?.intOrNull ?: 0))
            }
            "progress" -> {
                val id = str(m, "id") ?: return
                val line = str(m, "line") ?: return
                progress = progress.toMutableMap().apply {
                    merge(id, line) { a, b -> (a + "\n" + b).takeLast(2000) }
                }
            }
            "fs" -> dirListing = Proto.parseFs(m)
            "error" -> {
                val msg = str(m, "message") ?: "unknown error"
                lastError = msg
                events.tryEmit(RhEvent.Failure(msg))
            }
        }
    }

    private fun str(o: JsonObject, key: String): String? =
        o[key]?.jsonPrimitive?.contentOrNull
}
