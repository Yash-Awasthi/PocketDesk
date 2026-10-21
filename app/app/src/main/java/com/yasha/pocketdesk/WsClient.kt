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
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
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
    /** Why the last folder could not be listed; cleared by the next listing. */
    var fsError by mutableStateOf<String?>(null)
        private set
    var fsFound by mutableStateOf<FsFound?>(null)
    /** Agent tool calls waiting for Allow or Deny, oldest first. */
    var proposals by mutableStateOf<List<Proposal>>(emptyList())
        private set
    /** Permission mode chosen on this phone per chat; absent means the PC user's own setting. */
    var chatPermission by mutableStateOf<Map<String, String>>(emptyMap())
        private set
    /** JPEG thumbnails by PC path; an empty array marks a file the PC could not thumbnail. */
    val thumbs = androidx.compose.runtime.mutableStateMapOf<String, ByteArray>()
    /** (folder, zip path on the PC or null, error) once a folder is packed for download. */
    val fsZips = MutableSharedFlow<Triple<String, String?, String?>>(extraBufferCapacity = 8)
    /** Thumbnails asked for on this link; a row scrolled back into view does not ask again. */
    private val thumbsAsked: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()
    fun requestThumb(path: String, size: Int): Boolean = !thumbsAsked.add(path) || send(Proto.fsThumb(path, size))
    fun zipFolder(path: String): Boolean = send(Proto.fsZip(path))
    /** Mkdir, rename and delete outcomes, for the file manager to report. */
    val fsResults = MutableSharedFlow<FsResult>(extraBufferCapacity = 16)
    var lastError by mutableStateOf<String?>(null)
        private set
    var activeUrl: String? = null
        private set
    /** (url, token) the daemon issued this device on pairing; saved in place of the master token. */
    var issuedToken by mutableStateOf<Pair<String, String>?>(null)
        private set
    /** (entry url, iroh://ticket) when the PC reports an iroh address the saved entry lacks or has stale. */
    var irohUpdate by mutableStateOf<Pair<String, String>?>(null)
        private set

    // ── Auto-reconnect (client-kt/krossbow backoff + cc-pocket since-reattach) ──
    private var lastToken: String? = null
    private var lastFingerprint: String? = null
    // Read by OkHttp threads; a stale false there schedules a retry after the user said stop.
    @Volatile private var userClosed = false
    /** Bumped by close(): a failure from an older link that reaches the main thread late is dropped. */
    @Volatile private var linkGen = 0
    private val reconnectScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO + kotlinx.coroutines.SupervisorJob())
    private val policy = ReconnectPolicy()
    /** Last output seq seen per session, for missed-output backfill on reattach. */
    private val lastSeq = HashMap<String, Long>()
    /** Sessions attached before the drop — reattached automatically. */
    private val attachedSessions = LinkedHashSet<String>()

    /** Conversations agents saved on the PC, newest first, and the one opened for reading. */
    var history by mutableStateOf<List<HistoryEntry>>(emptyList())
        private set
    /** Terminal sessions the PC recorded (asciicast file names, newest first). */
    var recordings by mutableStateOf<List<String>>(emptyList())
    /** The recording being played: its name and asciicast text. */
    var playing by mutableStateOf<Pair<String, String>?>(null)
    fun recordingsList() = send(Proto.recordingsList())
    fun recordingGet(name: String) = send(Proto.recordingGet(name))
    var historyOpen by mutableStateOf<Pair<HistoryEntry, List<ChatItem>>?>(null)
    fun historyList() = send(Proto.historyList())
    fun historyGet(e: HistoryEntry) { historyOpen = e to emptyList(); send(Proto.historyGet(e.agent, e.id)) }
    fun historyResume(e: HistoryEntry, terminal: Boolean) = send(Proto.historyResume(e.agent, e.id, terminal))

    /** A chat this phone just started or resumed, for the chat screen to open whichever screen asked. */
    var pendingChat by mutableStateOf<String?>(null)

    /** agent id -> its skills, commands and settings files; [agentDocs] carries one opened doc. */
    var agentPanels by mutableStateOf<Map<String, AgentPanel>>(emptyMap())
        private set
    val agentDocs = MutableSharedFlow<AgentDoc>(extraBufferCapacity = 4)
    fun agentPanel(agent: String) = send(Proto.agentPanel(agent))
    fun agentDoc(agent: String, kind: String, name: String) = send(Proto.agentDoc(agent, kind, name))
    fun agentFileSet(agent: String, name: String, content: String) = send(Proto.agentFileSet(agent, name, content))

    /** agent id -> its login on the PC and the accounts saved for switching. */
    var agentAccounts by mutableStateOf<Map<String, AgentAccounts>>(emptyMap())
        private set
    fun accountsList(agent: String) = send(Proto.accountsList(agent))
    fun accountSave(agent: String, label: String) = send(Proto.accountSave(agent, label))
    fun accountSwitch(agent: String, id: String) = send(Proto.accountSwitch(agent, id))
    fun accountForget(agent: String, id: String) = send(Proto.accountForget(agent, id))

    /** chat id -> what its agent offers (model, permission mode, slash commands). */
    var chatInfo by mutableStateOf<Map<String, ChatInfo>>(emptyMap())
        private set

    /** Live transcript for an open chat: id -> list of items. */
    var chatTranscript by mutableStateOf<Map<String, List<ChatItem>>>(emptyMap())
        private set
    /** Chat state: id -> "idle" | "running" | "error". */
    var chatStates by mutableStateOf<Map<String, String>>(emptyMap())
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
    /** fb_skill_get / fb_config_get payloads, for the dialog that asked. */
    val skillContent = MutableSharedFlow<String>(extraBufferCapacity = 1)
    val configContent = MutableSharedFlow<String>(extraBufferCapacity = 1)

    // ── Desktop control state (AnyDesk-style screen viewer) ──
    /** The PC's OS as Node names it (win32, darwin, linux); empty from a daemon too old to say. */
    var hostOs by mutableStateOf("")
        private set
    /** Latest desktop frame (base64 JPEG + geometry) — null until first frame. */
    var desktopFrame by mutableStateOf<DesktopFrame?>(null)
        private set
    /** True while the daemon's frame loop is running for us. */
    var desktopStreaming by mutableStateOf(false)
        private set
    /** "h264" when the daemon streams video, "jpeg" for the frame-by-frame fallback. */
    var desktopMode by mutableStateOf("")
        private set
    /** The codec the daemon is encoding with ("h264", "hevc" or "av1"), decided per session. */
    var desktopCodec by mutableStateOf("h264")
        private set
    /** Whether to ask the PC to stream its sound; remembered between sessions by the screen. */
    @Volatile var desktopAudio = false
    /** Latest PC pointer; the video carries no pointer, so the screen draws this. */
    var desktopCursor by mutableStateOf<DesktopCursor?>(null)
        private set
    /** Monitor names in the daemon's order; the video shows [desktopMonitor]. */
    var desktopMonitors by mutableStateOf<List<String>>(emptyList())
        private set
    var desktopMonitor by mutableStateOf(0)
    /** Receives binary video packets (kinds 0-2); called on the socket thread. */
    @Volatile var videoSink: ((ByteArray) -> Unit)? = null
    /** Receives PC audio packets (kind 3, an ADTS frame); called on the socket thread. */
    @Volatile var audioSink: ((ByteArray) -> Unit)? = null
    /** PC clipboard content, asked for or copied on the PC while the desktop is open. */
    val pcClip = kotlinx.coroutines.flow.MutableSharedFlow<PcClip>(extraBufferCapacity = 4)
    /** Daemon clock minus ours, from the fastest recent ping; frame stamps are in daemon time. */
    @Volatile private var clockOffset = 0L
    private var bestRtt = Long.MAX_VALUE
    private var bestRttAt = 0L
    /** Round trip of the last ping and the smoothed age of frames when shown, in ms. */
    @Volatile var desktopRtt = -1L
    @Volatile var videoDelay = -1L
    fun desktopPing() = send(Proto.desktopPing(System.currentTimeMillis()))
    fun frameShown(sentAtMs: Long) {
        if (bestRttAt == 0L) return
        val age = (System.currentTimeMillis() + clockOffset - sentAtMs).coerceAtLeast(0)
        videoDelay = if (videoDelay < 0) age else (videoDelay * 7 + age) / 8
    }
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
    /** Terminal grid from the PC: (sessionId, cols, rows). The phone draws it scaled and never resizes it. */
    var onTerminalSize: ((String, Int, Int) -> Unit)? = null

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
    /** The saved entry's own url, which stays the same whichever route is in use. */
    val serverUrl: String? get() = lanUrl
    private var fallbackUrl: String? = null
    /** Updated by [Link] from the system; decides between the LAN url and iroh. */
    @Volatile var network = NetInfo(null, local = true)
        private set
    /** The network on which the LAN url last failed: iroh goes first there until the phone moves. */
    private var lanFailedOn: String? = null
    private var retryJob: kotlinx.coroutines.Job? = null

    private fun route(): String? = lanUrl?.let { ConnectRoute.pick(it, fallbackUrl, network, lanFailedOn) }

    fun connect(url: String, token: String, pinnedFingerprint: String?, fallback: String? = null) {
        // Entries saved before wss was required: the daemon refuses plaintext from the LAN.
        if (url.startsWith("ws://")) {
            if (fallback != null) return connect(fallback, token, null)
            close()
            lastError = "plain ws:// is not allowed: re-pair this PC from its QR code"
            return
        }
        close()
        userClosed = false
        policy.reset()
        status = Status.Connecting
        lanUrl = url
        fallbackUrl = fallback
        lastError = null
        lastToken = token
        lastFingerprint = pinnedFingerprint
        hello = Proto.hello(token, password = connPassword)
        val first = route() ?: url
        activeUrl = first
        open(first)
    }

    /**
     * The phone changed networks: every live or pending link is redialled on the new one.
     * An iroh link goes too, since its endpoint cannot see the change and keeps dead sockets.
     */
    fun onNetworkChanged(net: NetInfo) {
        if (net == network) return
        network = net
        IrohLink.Node.networkChanged()
        if (userClosed || lanUrl == null || status == Status.Disconnected || status == Status.AwaitingTrust) return
        retryJob?.cancel()
        socket.getAndSet(null)?.cancel()
        irohLink.getAndSet(null)?.close()
        failTransfers("network changed")
        policy.reset()
        reconnectNow()
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
                            totpNeeded = code == 4011
                            passwordNeeded = code == 4012
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
            connect(url, token, fp, fallbackUrl)
        } else {
            close()
            lastError = "certificate rejected"
        }
    }

    fun close() {
        userClosed = true
        linkGen++
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
            lastError = friendly(t)
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
                totpNeeded = code == 4011
                passwordNeeded = code == 4012
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

    private fun friendly(t: Throwable): String = when (t) {
        is java.net.ConnectException -> "PC not reachable. Is PocketDesk running on it?"
        is java.net.SocketTimeoutException -> "PC did not answer in time"
        is java.net.UnknownHostException -> "PC address not found on this network"
        is java.net.NoRouteToHostException -> "No route to the PC from this network"
        else -> t.message ?: "connection failed"
    }

    private fun onVideoPacket(pkt: ByteArray) {
        videoBytes += pkt.size
        if (pkt.isNotEmpty() && pkt[0].toInt() == 3) { audioSink?.invoke(pkt.copyOfRange(1, pkt.size)); return }
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
    /** What the connected PC reported for waking it later; saved with its entry. */
    var wakeInfo: WakeInfo? = null
        private set
    /** Asked for by the user, or imposed by whoever approved the session on the PC. */
    var desktopViewOnly by mutableStateOf(false)
    /** The PC keeps a recording of this session (its owner turned that on). */
    var desktopRecording by mutableStateOf(false)
        private set
    fun pcPower(action: String): Boolean = send(Proto.pcPower(action))

    /** The PC wants an authenticator code before this new device may pair. */
    var totpNeeded by mutableStateOf(false)
        private set
    fun dismissPairCode() { totpNeeded = false }

    /** The PC requires a connection password; held only for this session unless the user connects again. */
    var passwordNeeded by mutableStateOf(false)
        private set
    private var connPassword: String? = null
    fun dismissPassword() { passwordNeeded = false }
    fun submitConnectionPassword(password: String) {
        val token = lastToken ?: return
        connPassword = password
        passwordNeeded = false
        hello = Proto.hello(token, password = password)
        status = Status.Connecting
        open(activeUrl ?: lanUrl ?: return)
    }
    fun pairWithCode(code: String) {
        val token = lastToken ?: return
        totpNeeded = false
        hello = Proto.hello(token, code, connPassword)
        status = Status.Connecting
        open(activeUrl ?: lanUrl ?: return)
    }
    /** Session status that is not an error, such as waiting for approval on the PC. */
    var desktopNotice by mutableStateOf("")
        private set
    /** Desktop input; a view-only session sends none. */
    private fun control(line: String): Boolean = !desktopViewOnly && !desktopInputPaused && send(line)
    /** Set on the phone only (fullscreen's mouse switch): taps and keys stop reaching the PC, the picture keeps going. */
    var desktopInputPaused by mutableStateOf(false)
    /** saver / balanced / quality; sent with every start so a daemon restart keeps it. */
    var desktopPreset by mutableStateOf("balanced")
    /** Codecs this device can decode, best first; computed once and offered to the daemon. */
    private val decodable by lazy { com.yasha.pocketdesk.ui.decodableCodecs() }
    fun desktopStartVideo() {
        desktopStreaming = true
        val start = { Proto.desktopStartVideo(desktopPreset, desktopMonitor, desktopViewOnly, decodable, desktopAudio) }
        desktopResume = { send(start()) }
        send(start())
        send(Proto.desktopMonitors())
    }
    fun clipboardGet() = send(Proto.clipboardGet())
    /** With [paste], ctrl+v follows once the PC clipboard holds the text. */
    fun clipboardSet(text: String, paste: Boolean) = control(Proto.clipboardSet(text, paste = paste))
    fun clipboardSetImage(pngB64: String) = control(Proto.clipboardSet(null, png = pngB64))
    /** Puts files already on the PC on its clipboard; with [paste] they drop into the focused window. */
    fun clipboardSetFiles(paths: List<String>, paste: Boolean) = control(Proto.clipboardSet(null, files = paths, paste = paste))
    // ── PC controls the phone: the screen goes up as binary [kind, ...annexB], like the desktop comes down ──
    fun phoneShareStart(w: Int, h: Int, control: Boolean) = send(Proto.phoneShareStart(w, h, control))
    fun phoneShareStop() = send(Proto.phoneShareStop())
    fun phoneFsResult(rid: Long, reply: JsonObject) = send(Proto.phoneFsResult(rid, reply))
    fun phoneApps(active: Pair<String, String>?, apps: List<Triple<String, String, Int?>>) = send(Proto.phoneApps(active, apps))
    fun sendPhoneVideo(pkt: ByteArray): Boolean {
        irohLink.get()?.let { return it.sendVideo(pkt) }
        return socket.get()?.send(okio.ByteString.of(*pkt)) ?: false
    }
    /** Bytes not sent yet on whichever link carries the video; OkHttp closes a socket whose queue passes 16 MB. */
    fun uploadBacklog(): Long = irohLink.get()?.uploadBacklog?.get() ?: socket.get()?.queueSize() ?: 0L

    fun desktopStop() { desktopStreaming = false; desktopResume = null; send(Proto.desktopStop()) }
    fun desktopSnapshot() = send(Proto.desktopFrame())
    /** Width and height of the picture on screen; positions also go out as fractions of it. */
    @Volatile var desktopFrameSize: Pair<Int, Int>? = null
    /** The user's pointer calibration for the PC and screen in view; null sends and reads fractions as they are. */
    @Volatile var desktopCalibration: com.yasha.pocketdesk.ui.Calibration? = null
    /** The last pointer report as the daemon sent it, before any calibration; what calibrating measures. */
    @Volatile var desktopPointerRaw: Pair<Double, Double>? = null
        private set
    private fun frac(x: Int, y: Int) = desktopFrameSize?.takeIf { it.first > 0 && it.second > 0 }
        ?.let { (w, h) ->
            val fx = x.toDouble() / w
            val fy = y.toDouble() / h
            desktopCalibration?.toPc(fx, fy) ?: (fx to fy)
        }
    /** x/y are frame pixels; click is left|right|middle|double. */
    fun desktopClick(x: Int, y: Int, click: String) = control(Proto.desktopMouse(x, y, click, null, frac = frac(x, y)))
    fun desktopMove(x: Int, y: Int) = control(Proto.desktopMouse(x, y, null, null, frac = frac(x, y)))
    /** Holds (down) or releases (up) the left button at x/y, for dragging. */
    fun desktopPress(x: Int, y: Int, down: Boolean) = control(Proto.desktopMouse(x, y, null, null, if (down) "down" else "up", frac = frac(x, y)))
    fun desktopScroll(down: Boolean) = control(Proto.desktopMouse(null, null, null, if (down) -120 else 120))
    fun desktopKey(vk: Int, modifiers: List<String> = emptyList()) = control(Proto.desktopKey(vk, modifiers))
    fun desktopKeyPress(vk: Int, down: Boolean) = control(Proto.desktopKey(vk, emptyList(), if (down) "down" else "up"))
    fun desktopButton(x: Int, y: Int, button: String, down: Boolean) =
        control(Proto.desktopMouse(x, y, null, null, if (down) "down" else "up", button, frac = frac(x, y)))
    fun desktopWheel(delta: Int) = control(Proto.desktopMouse(null, null, null, delta))
    /** Positive scrolls right. */
    fun desktopHWheel(delta: Int) = control(Proto.desktopMouse(null, null, null, null, hwheel = delta))
    fun desktopType(text: String) = control(Proto.desktopType(text))

    fun modelList(chatId: String) = send(Proto.modelList(chatId))
    fun chatModelSet(chatId: String, model: String?) = send(Proto.chatModelSet(chatId, model))
    fun install(id: String): Boolean = send(Proto.install(id))

    /** Start a GUI application on the PC. It has no terminal to attach to. */
    fun guiOpen(id: String, cwd: String = ""): Boolean = send(Proto.guiOpen(id, cwd))

    /** Start a discovered application, by the path the daemon reported for it. */
    fun guiOpenPath(path: String, cwd: String = ""): Boolean = send(Proto.guiOpenPath(path, cwd))
    fun createSession(harness: String, cwd: String, worktree: Boolean = false): Boolean = send(Proto.create(harness, cwd, worktree))
    fun createSessionAt(path: String, cwd: String): Boolean = send(Proto.createPath(path, cwd))
    fun discoverApps(q: String, refresh: Boolean = false, guiOnly: Boolean = false): Boolean = send(Proto.appsDiscover(q, refresh, guiOnly))
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
    fun kill(id: String): Boolean = send(Proto.kill(id))
    fun browse(path: String?, hidden: Boolean = false): Boolean = send(Proto.fs(path, hidden))
    fun fileOp(op: String, path: String, to: String? = null): Boolean = send(Proto.fsOp(op, path, to))
    fun searchFiles(path: String, query: String): Boolean = send(Proto.fsSearch(path, query))
    fun approve(id: String, all: Boolean = false): Boolean = send(Proto.approve(id, all))
    fun reject(id: String): Boolean = send(Proto.reject(id))
    fun setChatPermission(id: String, mode: String): Boolean = send(Proto.chatPermission(id, mode))

    /** [worktree]: the PC gives the chat its own git worktree and branch beside the project. */
    fun createChat(harness: String, cwd: String, prompt: String? = null, worktree: Boolean = false): Boolean =
        send(Proto.chatSession(harness, cwd, prompt, worktree))

    fun sendChatMessage(id: String, text: String, model: String? = null, mode: String? = null): Boolean = send(Proto.chatMsg(id, text, model, mode))

    /** The chat on screen: its approvals show inside it, so the overlay card leaves them out. */
    var viewingChat by mutableStateOf<String?>(null)

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
        when (val type = str(m, "type")) {
            "welcome" -> {
                str(m, "deviceToken")?.let { t ->
                    lastToken = t
                    hello = Proto.hello(t, password = connPassword)
                    // Keyed by the entry's own url: the iroh fallback below may change in the same welcome.
                    (lanUrl ?: activeUrl)?.let { issuedToken = it to t }
                }
                str(m, "iroh")?.let { "iroh://$it" }?.takeIf { it != fallbackUrl }?.let { fb ->
                    fallbackUrl = fb
                    lanUrl?.let { irohUpdate = it to fb }
                }
                (m["wake"] as? JsonObject)?.let { w ->
                    val macs = (w["macs"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.let { o -> str(o, "mac") } } ?: emptyList()
                    val bc = (w["broadcasts"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()
                    if (macs.isNotEmpty()) wakeInfo = WakeInfo(macs, bc)
                }
                thumbsAsked.clear()
                hostOs = str(m, "os") ?: ""
                tools = Proto.parseTools(m)
                sessions = Proto.parseSessions(m)
                chats = Proto.parseChats(m)
                status = Status.Connected
                policy.reset()
                reattachAll()
                desktopResume?.invoke()
                send(Proto.proposalList())
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
            "created" -> str(m, "id")?.let { if (str(m, "kind") == "chat") pendingChat = it else events.tryEmit(RhEvent.Created(it)) }
            "agent_panel" -> if (bool(m, "ok") == true) Proto.parseAgentPanel(m)?.let { agentPanels = agentPanels + (it.agent to it) } else failure(str(m, "error") ?: "no panel")
            "agent_doc" -> if (bool(m, "ok") == true) agentDocs.tryEmit(AgentDoc(str(m, "agent") ?: "", str(m, "kind") ?: "", str(m, "name") ?: "", str(m, "content") ?: ""))
                else failure(str(m, "error") ?: "could not open")
            "agent_file_saved" -> if (bool(m, "ok") == true) str(m, "agent")?.let { send(Proto.agentPanel(it)) } else failure(str(m, "error") ?: "not saved")
            "history" -> history = Proto.parseHistory(m)
            "recordings_list" -> recordings = (m["items"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.let { o -> str(o, "name") } }.orEmpty()
            "recording_get" -> str(m, "text")?.let { playing = (str(m, "name") ?: "") to it } ?: failure(str(m, "error") ?: "no recording")
            "accounts" -> if (bool(m, "ok") == false) failure(str(m, "error") ?: "accounts unavailable")
                else Proto.parseAccounts(m)?.let { agentAccounts = agentAccounts + (it.agent to it) }
            "chat_info" -> str(m, "id")?.let { id -> chatInfo = chatInfo + (id to Proto.parseChatInfo(m)) }
            "history_item" -> Proto.parseHistoryEntry(m)?.let { e ->
                if (historyOpen?.first?.id == e.id) historyOpen = e to Proto.parseChatReplay(m["items"])
            }
            "out", "replay" -> {
                val id = str(m, "id") ?: return
                num(m, "seq")?.let { seq -> if (seq > (lastSeq[id] ?: 0L)) lastSeq[id] = seq }
                num(m, "cols")?.let { c -> num(m, "rows")?.let { r -> onTerminalSize?.invoke(id, c.toInt(), r.toInt()) } }
                val data = str(m, "data") ?: return
                onTerminalData?.invoke(id, data)
            }
            "size" -> {
                val id = str(m, "id") ?: return
                num(m, "cols")?.let { c -> num(m, "rows")?.let { r -> onTerminalSize?.invoke(id, c.toInt(), r.toInt()) } }
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
                if (bool(m, "ok") == false) {
                    val reason = str(m, "reason") ?: "could not open the app"
                    failure(if (app.isEmpty()) reason else "$app: $reason")
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
            "fs" -> {
                fsError = str(m, "error")
                Proto.parseFs(m)?.let { dirListing = it }
            }
            "fs_found" -> fsFound = Proto.parseFsFound(m)
            "fs_thumb" -> {
                val path = str(m, "path") ?: return
                thumbs[path] = str(m, "jpeg")?.let { java.util.Base64.getDecoder().decode(it) } ?: ByteArray(0)
            }
            "fs_zip" -> fsZips.tryEmit(Triple(str(m, "path") ?: "", str(m, "zip"), str(m, "error")))
            "proposal_created" -> Proto.parseProposal(m["proposal"])?.let { p ->
                if (proposals.none { it.id == p.id }) {
                    proposals = proposals + p
                    events.tryEmit(RhEvent.ApprovalNeeded(p))
                }
            }
            "proposal_approved", "proposal_rejected", "proposal_expired" -> {
                val id = (m["proposal"] as? JsonObject)?.let { str(it, "id") } ?: return
                proposals = proposals.filterNot { it.id == id }
                events.tryEmit(RhEvent.ApprovalGone(id))
            }
            "chat_permission_ok" -> {
                val id = str(m, "id") ?: return
                chatPermission = chatPermission + (id to (str(m, "mode") ?: return))
            }
            "proposal_list" -> {
                proposals = (m["items"] as? JsonArray)?.mapNotNull { Proto.parseProposal(it) } ?: emptyList()
            }
            "fs_result" -> fsResults.tryEmit(
                FsResult(str(m, "op") ?: "", str(m, "path") ?: "", bool(m, "ok") ?: false, str(m, "error")),
            )
            "fchunk" -> onFChunk(m)
            "fwritten" -> onFWritten(m)
            "error" -> failure(str(m, "message") ?: "unknown error")
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
                mergeAssistantDelta(id, text)
            }
            "chartool" -> {
                val id = str(m, "id") ?: return
                val name = str(m, "name") ?: ""
                val detail = str(m, "detail") ?: ""
                val item = ChatItem.Tool(name, detail, str(m, "toolId"))
                val list = chatTranscript[id].orEmpty()
                val at = item.toolId?.let { tid -> list.indexOfFirst { it is ChatItem.Tool && it.toolId == tid } } ?: -1
                if (at < 0) appendChatItem(id, item)
                else chatTranscript = chatTranscript + (id to list.toMutableList().also { it[at] = item })
            }
            "chattoolresult" -> {
                val id = str(m, "id") ?: return
                val text = str(m, "text") ?: ""
                appendChatItem(id, ChatItem.ToolResult(text))
            }
            "chatstate" -> {
                val id = str(m, "id") ?: return
                val state = str(m, "state") ?: "idle"
                chatStates = chatStates + (id to state)
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
                        size = num(o, "size") ?: 0L,
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
                    failure(str(m, "error") ?: "Freebuff account change failed")
                }
            }
            "fb_skill_get" -> skillContent.tryEmit(if (bool(m, "ok") == true) str(m, "content") ?: "" else "Could not load: ${str(m, "error")}")
            "fb_config_get" -> if (bool(m, "ok") == true) configContent.tryEmit(m["content"]?.toString() ?: "") else failure(str(m, "error") ?: "config unreadable")
            "fb_config_set", "fb_skill_run", "fb_app_open", "fb_app_quit" ->
                if (bool(m, "ok") == false) failure(str(m, "error") ?: "${type.removePrefix("fb_").replace('_', ' ')} failed")
                else if (type == "fb_config_set") send(Proto.fbConfigList()) else if (type != "fb_skill_run") send(Proto.fbStatus())
            "desktop_started" -> {
                desktopNotice = ""
                if (bool(m, "ok") == true) {
                    desktopStreaming = true
                    desktopMode = str(m, "mode") ?: "jpeg"
                    desktopCodec = str(m, "codec") ?: "h264"
                    bool(m, "viewOnly")?.let { desktopViewOnly = it }
                    desktopRecording = bool(m, "recording") ?: false
                } else {
                    desktopStreaming = false
                    // A refusal on the PC must not be retried on every reconnect.
                    desktopResume = null
                    _desktopError.value = str(m, "reason") ?: "desktop unavailable"
                }
            }
            "desktop_pong" -> {
                val t = num(m, "t") ?: return
                val server = num(m, "server") ?: return
                val now = System.currentTimeMillis()
                val rtt = now - t
                desktopRtt = rtt
                // The fastest round trip bounds the offset error best; refresh it now and then for drift.
                if (rtt <= bestRtt || now - bestRttAt > 30_000) {
                    bestRtt = rtt
                    bestRttAt = now
                    clockOffset = server - (t + rtt / 2)
                }
            }
            "control_allowed" -> {
                bool(m, "viewOnly")?.let { desktopViewOnly = it }
                desktopNotice = if (bool(m, "allowed") == false) "The PC owner paused control. You can watch only." else ""
            }
            "pc_power" -> events.tryEmit(RhEvent.PowerDone(str(m, "action") ?: "", bool(m, "ok") == true, str(m, "error")))
            "desktop_stopped" -> {
                desktopStreaming = false
                str(m, "reason")?.let { desktopResume = null; _desktopError.value = "Session $it" }
            }
            "desktop_cursor" -> {
                val x = (m["x"] as? JsonPrimitive)?.intOrNull ?: return
                val y = (m["y"] as? JsonPrimitive)?.intOrNull ?: return
                val fx = (m["fx"] as? JsonPrimitive)?.doubleOrNull
                val fy = (m["fy"] as? JsonPrimitive)?.doubleOrNull
                desktopPointerRaw = if (fx != null && fy != null) fx to fy else null
                val pic = if (fx != null && fy != null) desktopCalibration?.toPicture(fx, fy) ?: (fx to fy) else null
                desktopCursor = DesktopCursor(x, y, str(m, "shape") ?: "arrow", pic?.first, pic?.second)
            }
            "desktop_monitors" -> if (bool(m, "ok") == true) {
                desktopMonitors = (m["monitors"] as? JsonArray)?.mapIndexed { i, e ->
                    val o = e as? JsonObject
                    val w = (o?.get("w") as? JsonPrimitive)?.intOrNull
                    val h = (o?.get("h") as? JsonPrimitive)?.intOrNull
                    "${i + 1}" + (if (w != null && h != null) " · ${w}×$h" else "") +
                        (if (o?.let { bool(it, "primary") } == true) " · main" else "")
                } ?: emptyList()
            }
            "clipboard", "clipboard_changed" ->
                if (type == "clipboard_changed" || bool(m, "ok") == true) {
                    val files = (m["files"] as? JsonArray)?.mapNotNull { e ->
                        val o = e as? JsonObject ?: return@mapNotNull null
                        PcFile(str(o, "path") ?: return@mapNotNull null, str(o, "name") ?: "", num(o, "size"), bool(o, "dir") ?: false)
                    } ?: emptyList()
                    pcClip.tryEmit(PcClip(str(m, "kind") ?: "text", str(m, "text"), str(m, "png"), files, type == "clipboard"))
                } else _desktopError.value = "PC clipboard: " + (str(m, "error") ?: "failed")
            "clipboard_set_ok" ->
                if (bool(m, "ok") != true) _desktopError.value = "PC clipboard: " + (str(m, "error") ?: "failed")
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
                if (bool(m, "ok") == false)
                    _desktopError.value = str(m, "error") ?: "input rejected"
            "model_list" -> {
                val id = str(m, "id") ?: return
                if (bool(m, "ok") == true) {
                    val models = (m["models"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()
                    chatModels = chatModels.toMutableMap().apply { put(id, models) }
                    chatCurrentModel = chatCurrentModel.toMutableMap().apply { put(id, str(m, "current")) }
                    chatModelCustom = if (bool(m, "custom") == true) chatModelCustom + id else chatModelCustom - id
                }
            }
            "chat_model_set" -> {
                if (bool(m, "ok") == true) {
                    val id = str(m, "id") ?: return
                    chatCurrentModel = chatCurrentModel.toMutableMap().apply { put(id, str(m, "current")) }
                } else {
                    failure(str(m, "error") ?: "model rejected")
                }
            }
            "phone_share_request", "phone_share_stop", "phone_keyframe", "phone_input", "phone_switch", "phone_fs" ->
                events.tryEmit(RhEvent.Phone(type, m))
            else -> {}
        }
    }

    private fun failure(msg: String) {
        lastError = msg
        events.tryEmit(RhEvent.Failure(msg))
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
        // Socket threads land here; on the main thread it cannot interleave with close() or connect().
        val gen = linkGen
        reconnectScope.launch(kotlinx.coroutines.Dispatchers.Main) { if (gen == linkGen) scheduleReconnectOnMain() }
    }

    private fun scheduleReconnectOnMain() {
        // A LAN url that failed here is skipped on this network from now on.
        // When the fallback fails too, the PC is down rather than off this LAN: retries alternate again,
        // or a PC that comes back would stay on the relay while the phone sits on its Wi-Fi.
        if (activeUrl != null && activeUrl == lanUrl) lanFailedOn = network.id ?: ""
        else if (activeUrl != null && activeUrl == fallbackUrl) lanFailedOn = null
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
        retryJob = reconnectScope.launch(kotlinx.coroutines.Dispatchers.Main) {
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
        hello = Proto.hello(token, password = connPassword)
        open(url)
    }
}
