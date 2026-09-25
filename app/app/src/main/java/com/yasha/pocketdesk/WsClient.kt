package com.yasha.pocketdesk

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

enum class Status { Disconnected, Connecting, AwaitingTrust, Connected, Reconnecting }

// Pings surface a half-open socket (Wi-Fi to cellular handover) as a failure.
// A short connect timeout keeps an unreachable LAN address from delaying the fallback for long.
class WsClient(
    private val base: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(20, java.util.concurrent.TimeUnit.SECONDS)
        .connectTimeout(3, java.util.concurrent.TimeUnit.SECONDS)
        .build(),
) {

    private val statusState = mutableStateOf(Status.Disconnected)
    /** Mirrors [status] for collectors outside composition, which see no snapshot notifications. */
    val statusFlow = kotlinx.coroutines.flow.MutableStateFlow(Status.Disconnected)
    var status: Status
        get() = statusState.value
        private set(v) {
            statusState.value = v
            statusFlow.value = v
        }
    var tools by mutableStateOf<List<ToolInfo>>(emptyList())
        private set
    var sessions by mutableStateOf<List<SessionSummary>>(emptyList())
        private set
    var chats by mutableStateOf<List<ChatSummary>>(emptyList())
        private set
    var progress by mutableStateOf<Map<String, String>>(emptyMap())
        private set
    /** Applications found on the PC that ship no manifest. */
    var apps by mutableStateOf<List<AppEntry>>(emptyList())
        private set
    var dirListing by mutableStateOf<FsListing?>(null)
        private set
    var lastError by mutableStateOf<String?>(null)
        private set
    var activeUrl: String? = null
        private set
    /** (url, token) the daemon issued this device on pairing; saved in place of the master token. */
    var issuedToken by mutableStateOf<Pair<String, String>?>(null)
        private set

    // ── Auto-reconnect (client-kt/krossbow backoff + cc-pocket since-reattach) ──
    private var lastToken: String? = null
    private var lastFingerprint: String? = null
    private var userClosed = false
    private val reconnectScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO + kotlinx.coroutines.SupervisorJob())
    private val policy = ReconnectPolicy()
    /** Last output seq seen per session, for missed-output backfill on reattach. */
    private val lastSeq = HashMap<String, Long>()
    /** Sessions attached before the drop — reattached automatically. */
    private val attachedSessions = LinkedHashSet<String>()

    /** Live transcript for an open chat: id -> list of items. */
    var chatTranscript by mutableStateOf<Map<String, List<ChatItem>>>(emptyMap())
        private set
    /** Chat state: id -> "idle" | "running" | "error". */
    var chatStates by mutableStateOf<Map<String, String>>(emptyMap())
        private set
    /** Streaming delta accumulator for active chat turn. */
    var chatStreamBuf by mutableStateOf<Map<String, StringBuilder>>(emptyMap())
        private set

    // ── Freebuff control state ──
    var fbRunning by mutableStateOf<Boolean?>(null)
        private set
    var fbProfile by mutableStateOf<String?>(null)
        private set
    var fbSkills by mutableStateOf<List<FbSkill>>(emptyList())
        private set
    var fbConfigs by mutableStateOf<List<FbConfig>>(emptyList())
        private set
    var fbAuthLoggedIn by mutableStateOf<Boolean?>(null)
        private set
    var fbAuthEmail by mutableStateOf<String?>(null)
        private set
    var fbAccounts by mutableStateOf<List<FbAccount>>(emptyList())
        private set
    /** Last fb_skill_get / fb_config_get payload, consumed by dialogs. */
    val _skillContent = kotlinx.coroutines.flow.MutableStateFlow("")
    val _configContent = kotlinx.coroutines.flow.MutableStateFlow("")

    // ── Desktop control state (AnyDesk-style screen viewer) ──
    /** Latest desktop frame (base64 JPEG + geometry) — null until first frame. */
    var desktopFrame by mutableStateOf<DesktopFrame?>(null)
        private set
    /** True while the daemon's frame loop is running for us. */
    var desktopStreaming by mutableStateOf(false)
        private set
    /** "h264" when the daemon streams video, "jpeg" for the frame-by-frame fallback. */
    var desktopMode by mutableStateOf("")
        private set
    /** Latest PC pointer; the video carries no pointer, so the screen draws this. */
    var desktopCursor by mutableStateOf<DesktopCursor?>(null)
        private set
    /** Monitor names in the daemon's order; the video shows [desktopMonitor]. */
    var desktopMonitors by mutableStateOf<List<String>>(emptyList())
        private set
    var desktopMonitor by mutableStateOf(0)
    /** Receives binary H.264 packets; called on the socket thread. */
    @Volatile var videoSink: ((ByteArray) -> Unit)? = null
    /** PC clipboard content, asked for or copied on the PC while the desktop is open. */
    val pcClip = kotlinx.coroutines.flow.MutableSharedFlow<PcClip>(extraBufferCapacity = 4)
    /** Running totals of received video, for the on-screen rate readout. */
    @Volatile var videoBytes = 0L
    @Volatile var videoFrames = 0L
    /** Set on desktop_frame_error / input failures — consumed by the screen. */
    val _desktopError = kotlinx.coroutines.flow.MutableStateFlow("")

    // ── Model selection state (chatId -> models/current) ──
    var chatModels by mutableStateOf<Map<String, List<String>>>(emptyMap())
        private set
    var chatCurrentModel by mutableStateOf<Map<String, String?>>(emptyMap())
        private set
    /** Agent id -> (logged in, status text) from the last auth_status. */
    var authStatus by mutableStateOf<Map<String, Pair<Boolean, String>>>(emptyMap())
        private set
    fun authCheck(id: String) = send(Proto.auth("status", id, ""))
    /** Login and logout open a terminal session (device codes, links, provider pickers). */
    fun authLogin(id: String, cwd: String) = send(Proto.auth("login", id, cwd))
    fun authLogout(id: String, cwd: String) = send(Proto.auth("logout", id, cwd))

    /** Chats whose CLI takes any model name, not only the listed ones. */
    var chatModelCustom by mutableStateOf<Set<String>>(emptySet())
        private set


    // ── SSH screen state (profiles, keys, known hosts, local listeners) ──
    var sshProfiles by mutableStateOf<List<SshProfile>>(emptyList())
        private set
    var sshKeys by mutableStateOf<List<SshKey>>(emptyList())
        private set
    var knownHosts by mutableStateOf<List<KnownHost>>(emptyList())
        private set
    var sshServerStats by mutableStateOf<Map<String, ServerStat>>(emptyMap())
        private set
    /** Public half of the last generated key — shown so it can be copied out. */
    var lastGeneratedKey by mutableStateOf<String?>(null)
        private set

    // ── Tools screen state (doctor + git) ──
    var doctorChecks by mutableStateOf<List<DoctorCheck>>(emptyList())
        private set
    var gitStatus by mutableStateOf<GitStatus?>(null)
        private set
    var gitOutput by mutableStateOf("")
        private set

    val events = MutableSharedFlow<RhEvent>(extraBufferCapacity = 256)

    /** Terminal output router: (sessionId, base64 chunk). Set by the terminal screen. */
    var onTerminalData: ((String, String) -> Unit)? = null

    private val socket = AtomicReference<WebSocket?>(null)
    private var hello: String? = null
    private var collectingTm: Tls.CollectingTrustManager? = null

    /** Anywhere transport (iroh://<ticket>) — dials the PC by key, direct or relayed. */
    private val irohLink = AtomicReference<IrohLink?>(null)
    /** How the current connection reaches the PC: the address dialled, or iroh's "iroh direct 42 ms". */
    var route by mutableStateOf("")
        private set

    /** Primary url and its fallback for the current server; retries alternate between them. */
    private var lanUrl: String? = null
    private var fallbackUrl: String? = null
    /** Updated by [Link] from the system; decides between the LAN url and iroh. */
    @Volatile var network = NetInfo(null, local = true)
        private set
    /** The network on which the LAN url last failed: iroh goes first there until the phone moves. */
    private var lanFailedOn: String? = null
    private var retryJob: kotlinx.coroutines.Job? = null

    private fun route(): String? = lanUrl?.let { ConnectRoute.pick(it, fallbackUrl, network, lanFailedOn) }

    fun connect(url: String, token: String, pinnedFingerprint: String?, fallback: String? = null) {
        close()
        userClosed = false
        policy.reset()
        status = Status.Connecting
        lanUrl = url
        fallbackUrl = fallback
        lastError = null
        lastToken = token
        lastFingerprint = pinnedFingerprint
        hello = Proto.hello(token)
        val first = route() ?: url
        activeUrl = first
        open(first)
    }

    /**
     * The phone changed networks. A pending retry runs at once on the new network,
     * and a LAN socket is replaced, since it cannot survive leaving that network.
     * An iroh connection is left alone: it moves paths by itself.
     */
    fun onNetworkChanged(net: NetInfo) {
        if (net == network) return
        network = net
        if (userClosed || lanUrl == null) return
        val onLan = activeUrl == lanUrl && socket.get() != null
        if (status == Status.Reconnecting || (status == Status.Connected && onLan && fallbackUrl != null)) {
            retryJob?.cancel()
            socket.getAndSet(null)?.let { it.cancel(); failTransfers("network changed") }
            policy.reset()
            reconnectNow()
        }
    }

    /** Opens the transport for [url] with the current token and pin; retries reuse it without resetting backoff. */
    private fun open(url: String) {
        collectingTm = null
        if (url.startsWith("iroh://")) {
            lateinit var link: IrohLink
            link = IrohLink(url.removePrefix("iroh://"),
                onText = { text -> if (irohLink.get() === link) handle(text) },
                onVideo = { pkt -> if (irohLink.get() === link) onVideoPacket(pkt) },
                onPath = { p -> if (irohLink.get() === link) route = "iroh $p" },
                onClosed = { code, reason ->
                    if (irohLink.compareAndSet(link, null)) {
                        failTransfers("connection lost")
                        // Same rule as the socket path: a 4xxx refusal must not be retried.
                        if (code != null) {
                            lastError = reason.ifEmpty { "refused by server ($code)" }
                            status = Status.Disconnected
                        } else {
                            lastError = reason
                            scheduleReconnect()
                        }
                    }
                })
            irohLink.set(link)
            route = "iroh"
            link.start { hello?.let { link.send(it) } }
            return
        }
        route = url.substringAfter("://").substringBefore('/')
        val fp = lastFingerprint
        val client: OkHttpClient = when {
            !url.startsWith("wss") -> base
            fp != null -> Tls.pinnedClient(base, fp)
            else -> Tls.collectingClient(base).also { collectingTm = it.second }.first
        }

        socket.set(client.newWebSocket(Request.Builder().url(url).build(), listener))
    }

    /** Called by the UI after the user accepted (or rejected) a self-signed certificate. */
    fun resolveTrust(accepted: Boolean) {
        val fp = collectingTm?.seen
        collectingTm = null
        val url = activeUrl
        val token = lastToken
        // Reopen pinned rather than reuse the probe socket: the daemon drops a
        // socket that sent no hello within 10 s, and a retry must not re-prompt.
        if (accepted && fp != null && url != null && token != null) {
            connect(url, token, fp)
        } else {
            close()
            lastError = "certificate rejected"
        }
    }

    fun close() {
        userClosed = true
        retryJob?.cancel()
        // A deliberate disconnect leaves no stale error behind; callers that fail set one after.
        lastError = null
        socket.getAndSet(null)?.close(1000, "bye")
        irohLink.getAndSet(null)?.close()
        status = Status.Disconnected
        collectingTm = null
        failTransfers("disconnected")
    }

    private fun failTransfers(reason: String) {
        val pending = transfers.values.toList()
        transfers.clear()
        for (t in pending) when (t) {
            is Transfer.Download -> t.onDone(reason)
            is Transfer.Upload -> t.finish(reason)
        }
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (webSocket !== socket.get()) return
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
            if (!socket.compareAndSet(webSocket, null)) return
            lastError = t.message ?: "connection failed"
            failTransfers("connection lost")
            scheduleReconnect()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (!socket.compareAndSet(webSocket, null)) return
            failTransfers("connection lost")
            // 4xxx are the daemon's auth refusals (bad token, revoked, timeout,
            // rate limit): retrying spends the IP's 5-attempt budget and locks it out.
            if (code >= 4000) {
                lastError = reason.ifEmpty { "refused by server ($code)" }
                status = Status.Disconnected
                return
            }
            scheduleReconnect()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (webSocket === socket.get()) handle(text)
        }

        override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) {
            if (webSocket === socket.get()) onVideoPacket(bytes.toByteArray())
        }
    }

    private fun onVideoPacket(pkt: ByteArray) {
        videoBytes += pkt.size
        if (pkt.isNotEmpty() && pkt[0].toInt() != 0) videoFrames++
        videoSink?.invoke(pkt)
    }

    private fun send(line: String): Boolean {
        irohLink.get()?.let { return it.send(line) }
        val ws = socket.get() ?: return false
        return ws.send(line)
    }

    fun rescan(): Boolean = send(Proto.detect())

    // ── SSH ──
    fun sshRefresh() {
        send(Proto.profileList()); send(Proto.sshKeyList()); send(Proto.hostKeyList())
        send(Proto.mprotoStatus())
        for (kind in SSH_SERVERS) send(Proto.serverStats(kind))
    }
    fun profileCreate(name: String, host: String, port: Int, username: String, keyId: String?) =
        send(Proto.profileCreate(name, host, port, username, keyId))
    fun profileDelete(id: String) = send(Proto.profileDelete(id))
    fun profileConnect(id: String, protocol: String, secret: String?, usesKey: Boolean) =
        send(Proto.profileConnect(id, protocol, secret, usesKey))
    fun sshKeyGenerate(algo: String, name: String, passphrase: String?) =
        send(Proto.sshKeyGenerate(algo, name, passphrase))
    fun sshKeyDelete(id: String) = send(Proto.sshKeyDelete(id))
    fun serverStart(kind: String, port: Int, host: String) = send(Proto.serverStart(kind, port, host))
    fun serverStop(kind: String) = send(Proto.serverStop(kind))

    // ── Tools ──
    fun runDoctor() = send(Proto.doctor())
    fun gitLoad(cwd: String) = send(Proto.gitStatus(cwd))
    fun gitLog(cwd: String) = send(Proto.gitLog(cwd, 20))
    fun gitDiff(cwd: String) = send(Proto.gitDiff(cwd))



    // ── Freebuff control methods ──
    fun fbStatus() = send(Proto.fbStatus())
    fun fbSkillList() = send(Proto.fbSkillList())
    fun fbSkillGet(name: String) = send(Proto.fbSkillGet(name))
    fun fbSkillRun(name: String, harness: String, args: String?) = send(Proto.fbSkillRun(name, harness, args))
    fun fbConfigList() = send(Proto.fbConfigList())
    fun fbConfigGet(name: String) = send(Proto.fbConfigGet(name))
    fun fbConfigSet(name: String, patchJson: String) = send(Proto.fbConfigSet(name, patchJson))
    fun fbAuthStatus() = send(Proto.fbAuthStatus())
    fun fbAuthLogout() = send(Proto.fbAuthLogout())
    fun fbAccountsList() = send(Proto.fbAccounts())
    fun fbAccountSwitch(email: String) = send(Proto.fbAccountSwitch(email))
    fun fbAccountForget(email: String) = send(Proto.fbAccountForget(email))
    fun fbAppOpen() = send(Proto.fbAppOpen())
    fun fbAppQuit() = send(Proto.fbAppQuit())
    // ── Desktop control methods ──
    /** Re-sends the last desktop start after a reconnect, so the picture does not stay frozen. */
    private var desktopResume: (() -> Unit)? = null
    fun desktopStart(quality: Int = 55) {
        desktopStreaming = true
        desktopResume = { send(Proto.desktopStart(quality)) }
        send(Proto.desktopStart(quality))
    }
    /** Also the resync request: the daemon answers with a fresh config + keyframe. */
    /** saver / balanced / quality; sent with every start so a daemon restart keeps it. */
    var desktopPreset by mutableStateOf("balanced")
    fun desktopStartVideo() {
        desktopStreaming = true
        desktopResume = { send(Proto.desktopStartVideo(desktopPreset, desktopMonitor)) }
        send(Proto.desktopStartVideo(desktopPreset, desktopMonitor))
        send(Proto.desktopMonitors())
    }
    fun clipboardGet() = send(Proto.clipboardGet())
    /** With [paste], ctrl+v follows once the PC clipboard holds the text. */
    fun clipboardSet(text: String, paste: Boolean) = send(Proto.clipboardSet(text, paste = paste))
    fun clipboardSetImage(pngB64: String) = send(Proto.clipboardSet(null, png = pngB64))
    /** Puts files already on the PC on its clipboard; with [paste] they drop into the focused window. */
    fun clipboardSetFiles(paths: List<String>, paste: Boolean) = send(Proto.clipboardSet(null, files = paths, paste = paste))
    fun desktopStop() { desktopStreaming = false; desktopResume = null; send(Proto.desktopStop()) }
    fun desktopSnapshot() = send(Proto.desktopFrame())
    /** x/y are frame pixels; click is left|right|middle|double. */
    fun desktopClick(x: Int, y: Int, click: String) = send(Proto.desktopMouse(x, y, click, null))
    fun desktopMove(x: Int, y: Int) = send(Proto.desktopMouse(x, y, null, null))
    /** Holds (down) or releases (up) the left button at x/y, for dragging. */
    fun desktopPress(x: Int, y: Int, down: Boolean) = send(Proto.desktopMouse(x, y, null, null, if (down) "down" else "up"))
    fun desktopScroll(down: Boolean) = send(Proto.desktopMouse(null, null, null, if (down) -120 else 120))
    fun desktopKey(vk: Int, modifiers: List<String> = emptyList()) = send(Proto.desktopKey(vk, modifiers))
    fun desktopKeyPress(vk: Int, down: Boolean) = send(Proto.desktopKey(vk, emptyList(), if (down) "down" else "up"))
    fun desktopButton(x: Int, y: Int, button: String, down: Boolean) =
        send(Proto.desktopMouse(x, y, null, null, if (down) "down" else "up", button))
    fun desktopWheel(delta: Int) = send(Proto.desktopMouse(null, null, null, delta))
    fun desktopType(text: String) = send(Proto.desktopType(text))

    fun modelList(chatId: String) = send(Proto.modelList(chatId))
    fun chatModelSet(chatId: String, model: String?) = send(Proto.chatModelSet(chatId, model))
    fun install(id: String): Boolean = send(Proto.install(id))

    /** Start a GUI application on the PC. It has no terminal to attach to. */
    fun guiOpen(id: String, cwd: String = ""): Boolean = send(Proto.guiOpen(id, cwd))

    /** Start a discovered application, by the path the daemon reported for it. */
    fun guiOpenPath(path: String, cwd: String = ""): Boolean = send(Proto.guiOpenPath(path, cwd))
    fun createSession(harness: String, cwd: String): Boolean = send(Proto.create(harness, cwd))
    fun createSessionAt(path: String, cwd: String): Boolean = send(Proto.createPath(path, cwd))
    fun discoverApps(q: String, refresh: Boolean = false): Boolean = send(Proto.appsDiscover(q, refresh))
    fun attach(id: String): Boolean {
        attachedSessions.add(id)
        val since = lastSeq[id]
        return if (since != null) send(Proto.attachSince(id, since)) else send(Proto.attach(id))
    }
    fun detach(id: String): Boolean {
        attachedSessions.remove(id)
        lastSeq.remove(id)
        return send(Proto.detach(id))
    }
    fun sendInput(id: String, dataB64: String): Boolean = send(Proto.input(id, dataB64))
    fun sendResize(id: String, cols: Int, rows: Int): Boolean = send(Proto.resize(id, cols, rows))
    fun kill(id: String): Boolean = send(Proto.kill(id))
    fun browse(path: String?): Boolean = send(Proto.fs(path))

    fun createChat(harness: String, cwd: String, prompt: String? = null): Boolean =
        send(Proto.chatSession(harness, cwd, prompt))

    fun sendChatMessage(id: String, text: String): Boolean = send(Proto.chatMsg(id, text))

    fun cancelChat(id: String): Boolean = send(Proto.chatCancel(id))

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
            private var createdEmpty = false

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
                // An empty file still has to exist on the PC.
                if (n <= 0 && offset == 0L && !createdEmpty) {
                    createdEmpty = true
                    ws.writeFileChunk(path, "", append = false)
                    return true
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
                str(m, "deviceToken")?.let { t ->
                    lastToken = t
                    hello = Proto.hello(t)
                    activeUrl?.let { issuedToken = it to t }
                }
                tools = Proto.parseTools(m)
                sessions = Proto.parseSessions(m)
                chats = Proto.parseChats(m)
                status = Status.Connected
                policy.reset()
                reattachAll()
                desktopResume?.invoke()
            }
            "manifests" -> tools = Proto.parseTools(m)
            "auth_status" -> str(m, "harness")?.let { id ->
                authStatus = authStatus + (id to Pair(bool(m, "loggedIn") == true, str(m, "text") ?: ""))
            }
            "profile_list" -> sshProfiles = Proto.parseProfiles(m)
            "profile_created", "profile_updated", "profile_deleted" -> {
                if (bool(m, "ok") == false) lastError = str(m, "error")
                send(Proto.profileList()); send(Proto.mprotoStatus())
            }
            "profile_connected" -> {
                val ok = bool(m, "ok") == true
                val session = m["session"] as? JsonObject
                val proto = session?.let { str(it, "protocol") } ?: "ssh"
                val detail = if (ok) proto + " connected" else str(m, "error") ?: "connect failed"
                events.tryEmit(RhEvent.SshConnect(ok, detail))
                send(Proto.hostKeyList()); send(Proto.mprotoStatus())
            }
            "profile_disconnected" -> send(Proto.mprotoStatus())
            "sshkey_list" -> sshKeys = Proto.parseSshKeys(m)
            "sshkey_generated" -> {
                if (bool(m, "ok") == true) {
                    lastGeneratedKey = (m["key"] as? JsonObject)?.let { str(it, "publicKey") }
                } else {
                    lastError = str(m, "error")
                }
                send(Proto.sshKeyList())
            }
            "sshkey_deleted" -> send(Proto.sshKeyList())
            "hostkey_list" -> knownHosts = Proto.parseHostKeys(m)
            "mproto_event" -> {
                val kind = str(m, "mprotoEvent")
                if (kind == "new" || kind == "changed") {
                    events.tryEmit(
                        RhEvent.HostKeySeen(
                            host = (str(m, "host") ?: "?") + ":" + (str(m, "port") ?: "22"),
                            fingerprint = str(m, "newFingerprint") ?: str(m, "fingerprint") ?: "",
                            changed = kind == "changed",
                        ),
                    )
                    send(Proto.hostKeyList())
                }
            }
            "bastion_started", "bastion_stopped" -> {
                if (bool(m, "ok") == false) lastError = str(m, "error")
                send(Proto.serverStats("bastion"))
            }
            "sshserver_started", "sshserver_stopped" -> {
                if (bool(m, "ok") == false) lastError = str(m, "error")
                send(Proto.serverStats("sshserver"))
            }
            "bastion_stats" -> sshServerStats = sshServerStats + ("bastion" to Proto.parseServerStat(m))
            "sshserver_stats" -> sshServerStats = sshServerStats + ("sshserver" to Proto.parseServerStat(m))
            "doctor_report" -> doctorChecks = Proto.parseDoctor(m)
            "git_status" -> gitStatus = Proto.parseGitStatus(m)
            "git_log" -> {
                val commits = (m["commits"] as? kotlinx.serialization.json.JsonArray)
                    ?.filterIsInstance<JsonObject>()
                    .orEmpty()
                gitOutput = commits.joinToString(LINE_BREAK) { c ->
                    val hash = str(c, "hash")?.take(8) ?: ""
                    val subject = str(c, "subject") ?: ""
                    hash + "  " + subject
                }
            }
            "git_diff" -> gitOutput = str(m, "out") ?: ""

            "sessions" -> {
                sessions = Proto.parseSessions(m)
                chats = Proto.parseChats(m)
            }
            "created" -> str(m, "id")?.let { events.tryEmit(RhEvent.Created(it)) }
            "out", "replay" -> {
                val id = str(m, "id") ?: return
                m["seq"]?.jsonPrimitive?.longOrNull?.let { seq -> if (seq > (lastSeq[id] ?: 0L)) lastSeq[id] = seq }
                val data = str(m, "data") ?: return
                onTerminalData?.invoke(id, data)
            }
            "exit" -> {
                val id = str(m, "id") ?: return
                val harnessId = sessions.firstOrNull { it.id == id }?.harnessId ?: id
                sessions = sessions.filterNot { it.id == id }
                events.tryEmit(RhEvent.Exit(id, harnessId, Proto.exitCode(m)))
            }
            "gui_opened" -> {
                // The window opens on the PC, out of sight: success moves the
                // phone to the desktop view, a refusal only reports itself.
                val app = str(m, "harness") ?: ""
                if (m["ok"]?.jsonPrimitive?.booleanOrNull == false) {
                    val reason = str(m, "reason") ?: "could not open the app"
                    val msg = if (app.isEmpty()) reason else "$app: $reason"
                    lastError = msg
                    events.tryEmit(RhEvent.Failure(msg))
                } else {
                    events.tryEmit(RhEvent.GuiOpened(app))
                }
            }
            "apps" -> apps = Proto.parseApps(m)
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
            "chatreplay" -> {
                val id = str(m, "id") ?: return
                val items = Proto.parseChatReplay(m["items"])
                chatTranscript = chatTranscript.toMutableMap().apply { put(id, items) }
                chatStates = chatStates.toMutableMap().apply { if (!containsKey(id)) put(id, "idle") }
            }
            "chatuser" -> {
                val id = str(m, "id") ?: return
                val text = str(m, "text") ?: return
                appendChatItem(id, ChatItem.User(text))
            }
            "chatdelta" -> {
                val id = str(m, "id") ?: return
                val text = str(m, "text") ?: return
                // Accumulate streaming deltas into the assistant message
                val bufs = chatStreamBuf.toMutableMap()
                val buf = bufs.getOrPut(id) { StringBuilder() }
                buf.append(text)
                chatStreamBuf = bufs
                // Merge into transcript: update or create the trailing assistant item
                mergeAssistantDelta(id, text)
            }
            "chartool" -> {
                val id = str(m, "id") ?: return
                val name = str(m, "name") ?: ""
                val detail = str(m, "detail") ?: ""
                appendChatItem(id, ChatItem.Tool(name, detail))
            }
            "chattoolresult" -> {
                val id = str(m, "id") ?: return
                val text = str(m, "text") ?: ""
                appendChatItem(id, ChatItem.ToolResult(text))
            }
            "chatstate" -> {
                val id = str(m, "id") ?: return
                val state = str(m, "state") ?: "idle"
                chatStates = chatStates.toMutableMap().apply { put(id, state) }
                if (state == "idle" || state == "error") {
                    // Reset stream buffer for next turn
                    chatStreamBuf = chatStreamBuf.toMutableMap().apply { remove(id) }
                }
            }
            "fb_status" -> {
                fbRunning = bool(m, "running")
                fbProfile = str(m, "profile")
                fbAuthLoggedIn = (m["auth"] as? JsonObject)?.let { bool(it, "loggedIn") }
                fbAuthEmail = (m["auth"] as? JsonObject)?.let { str(it, "email") }
            }
            "fb_skill_list" -> {
                val items = (m["items"] as? JsonArray)?.mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    FbSkill(
                        name = str(o, "name") ?: return@mapNotNull null,
                        description = str(o, "description") ?: "",
                        dir = str(o, "dir") ?: "",
                    )
                } ?: emptyList()
                fbSkills = items
            }
            "fb_config_list" -> {
                val items = (m["items"] as? JsonArray)?.mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    FbConfig(
                        name = str(o, "name") ?: return@mapNotNull null,
                        size = (o["size"] as? JsonPrimitive)?.longOrNull ?: 0L,
                        mtime = str(o, "mtime") ?: "",
                    )
                } ?: emptyList()
                fbConfigs = items
            }
            "fb_auth_status" -> {
                fbAuthLoggedIn = bool(m, "loggedIn")
                fbAuthEmail = str(m, "email")
            }
            "fb_accounts" -> fbAccounts = (m["accounts"] as? JsonArray)?.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                FbAccount(str(o, "email") ?: return@mapNotNull null, str(o, "name") ?: "", bool(o, "current") == true)
            } ?: emptyList()
            "fb_auth_logout", "fb_account_switch" -> {
                if (bool(m, "ok") == true) {
                    send(Proto.fbStatus()); send(Proto.fbAccounts())
                } else {
                    val msg = str(m, "error") ?: "Freebuff account change failed"
                    lastError = msg
                    events.tryEmit(RhEvent.Failure(msg))
                }
            }
            "fb_skill_get" -> {
                if (m["ok"]?.jsonPrimitive?.booleanOrNull == true) {
                    _skillContent.value = str(m, "content") ?: ""
                }
            }
            "fb_config_get" -> {
                if (m["ok"]?.jsonPrimitive?.booleanOrNull == true) {
                    _configContent.value = m["content"]?.toString() ?: ""
                }
            }
            "desktop_started" -> {
                if (m["ok"]?.jsonPrimitive?.booleanOrNull == true) {
                    desktopStreaming = true
                    desktopMode = str(m, "mode") ?: "jpeg"
                } else {
                    desktopStreaming = false
                    _desktopError.value = str(m, "reason") ?: "desktop unavailable"
                }
            }
            "desktop_stopped" -> desktopStreaming = false
            "desktop_cursor" -> {
                val x = (m["x"] as? JsonPrimitive)?.intOrNull ?: return
                val y = (m["y"] as? JsonPrimitive)?.intOrNull ?: return
                desktopCursor = DesktopCursor(x, y, str(m, "shape") ?: "arrow")
            }
            "desktop_monitors" -> if (m["ok"]?.jsonPrimitive?.booleanOrNull == true) {
                desktopMonitors = (m["monitors"] as? JsonArray)?.mapIndexed { i, e ->
                    val o = e as? JsonObject
                    val w = (o?.get("w") as? JsonPrimitive)?.intOrNull
                    val h = (o?.get("h") as? JsonPrimitive)?.intOrNull
                    "${i + 1}" + if (w != null && h != null) " · ${w}×$h" else ""
                } ?: emptyList()
            }
            "clipboard", "clipboard_changed" ->
                if (type == "clipboard_changed" || m["ok"]?.jsonPrimitive?.booleanOrNull == true) {
                    val files = (m["files"] as? JsonArray)?.mapNotNull { e ->
                        val o = e as? JsonObject ?: return@mapNotNull null
                        PcFile(str(o, "path") ?: return@mapNotNull null, str(o, "name") ?: "", num(o, "size"), bool(o, "dir") ?: false)
                    } ?: emptyList()
                    pcClip.tryEmit(PcClip(str(m, "kind") ?: "text", str(m, "text"), str(m, "png"), files, type == "clipboard"))
                } else _desktopError.value = "PC clipboard: " + (str(m, "error") ?: "failed")
            "clipboard_set_ok" ->
                if (m["ok"]?.jsonPrimitive?.booleanOrNull != true) _desktopError.value = "PC clipboard: " + (str(m, "error") ?: "failed")
            "desktop_frame" -> {
                val b64 = str(m, "base64") ?: return
                desktopFrame = DesktopFrame(
                    base64 = b64,
                    width = (m["width"] as? JsonPrimitive)?.intOrNull ?: 1,
                    height = (m["height"] as? JsonPrimitive)?.intOrNull ?: 1,
                )
            }
            "desktop_frame_error" ->
                _desktopError.value = str(m, "reason") ?: "capture failed"
            "desktop_input_ok" ->
                if (m["ok"]?.jsonPrimitive?.booleanOrNull == false)
                    _desktopError.value = str(m, "error") ?: "input rejected"
            "model_list" -> {
                val id = str(m, "id") ?: return
                if (m["ok"]?.jsonPrimitive?.booleanOrNull == true) {
                    val models = (m["models"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList()
                    chatModels = chatModels.toMutableMap().apply { put(id, models) }
                    chatCurrentModel = chatCurrentModel.toMutableMap().apply { put(id, str(m, "current")) }
                    chatModelCustom = if (m["custom"]?.jsonPrimitive?.booleanOrNull == true) chatModelCustom + id else chatModelCustom - id
                }
            }
            "chat_model_set" -> {
                if (m["ok"]?.jsonPrimitive?.booleanOrNull == true) {
                    val id = str(m, "id") ?: return
                    chatCurrentModel = chatCurrentModel.toMutableMap().apply { put(id, str(m, "current")) }
                } else {
                    val msg = str(m, "error") ?: "model rejected"
                    lastError = msg
                    events.tryEmit(RhEvent.Failure(msg))
                }
            }
            else -> {}
        }
    }

    private fun appendChatItem(chatId: String, item: ChatItem) {
        chatTranscript = chatTranscript.toMutableMap().apply {
            val list = (get(chatId) ?: emptyList()).toMutableList()
            list.add(item)
            put(chatId, list)
        }
    }

    private fun mergeAssistantDelta(chatId: String, delta: String) {
        chatTranscript = chatTranscript.toMutableMap().apply {
            val list = (get(chatId) ?: emptyList()).toMutableList()
            val last = list.lastOrNull()
            if (last is ChatItem.Assistant) {
                list[list.lastIndex] = ChatItem.Assistant(last.text + delta)
            } else {
                list.add(ChatItem.Assistant(delta))
            }
            put(chatId, list)
        }
    }

    private fun bool(o: JsonObject, key: String): Boolean? = o[key]?.jsonPrimitive?.booleanOrNull

    private fun num(o: JsonObject, key: String): Long? = o[key]?.jsonPrimitive?.contentOrNull?.toLongOrNull()

    private fun str(o: JsonObject, key: String): String? = o[key]?.jsonPrimitive?.contentOrNull

    /** Re-attach every session the UI had open, replaying only missed seqs. */
    private fun reattachAll() {
        for (id in attachedSessions.toList()) {
            val since = lastSeq[id]
            if (since != null) send(Proto.attachSince(id, since)) else send(Proto.attach(id))
        }
    }

    /**
     * Exponential backoff + jitter reconnect loop. Goes straight to Reconnecting
     * without passing Disconnected, which would stop the foreground service.
     */
    private fun scheduleReconnect() {
        // A LAN url that failed here is skipped on this network from now on.
        if (activeUrl != null && activeUrl == lanUrl) lanFailedOn = network.id ?: ""
        if (userClosed || route() == null || lastToken == null) {
            status = Status.Disconnected
            return
        }
        // Switching from a failed LAN url to iroh is not a real failure: no backoff for it.
        val delay = if (activeUrl == lanUrl && route() != lanUrl) 0L else policy.nextDelayMs() ?: run {
            lastError = "gave up after ${policy.attemptsSoFar} reconnect attempts"
            status = Status.Disconnected
            return
        }
        status = Status.Reconnecting
        retryJob = reconnectScope.launch {
            kotlinx.coroutines.delay(delay)
            reconnectNow()
        }
    }

    private fun reconnectNow() {
        val url = route() ?: return
        val token = lastToken ?: return
        if (userClosed) return
        activeUrl = url
        status = Status.Connecting
        hello = Proto.hello(token)
        open(url)
    }
}
