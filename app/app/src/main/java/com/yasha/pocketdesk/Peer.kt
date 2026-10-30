package com.yasha.pocketdesk

import android.content.Context
import android.os.Build
import android.util.Base64
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import computer.iroh.EndpointTicket
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import java.io.DataInputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicLong
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Phone to phone, no PC: one phone shows a QR with how to reach it (its Wi-Fi address, and its
 * iroh address for any other network) and a fresh secret key; the other scans it and connects,
 * on the same Wi-Fi straight to it, elsewhere through iroh. Everything is sealed with that key
 * (AES-GCM), so only the phone that saw the QR gets in. The shown phone streams its screen with
 * [ShareService] (its owner still says yes to Android's capture prompt) and acts on the other
 * phone's taps with [ControlService].
 */
object Peer {
    /** The Phone to phone screen is up, over whatever else is showing (it needs no PC). */
    var open by mutableStateOf(false)
    /** null, "host" (this phone is shown) or "join" (this phone views another). */
    var view by mutableStateOf<String?>(null)
    var status by mutableStateOf("")
    /** The QR text while hosting. */
    var qr by mutableStateOf<String?>(null)
    /** Who is viewing this phone while hosting, for the Stop pill. */
    var viewer by mutableStateOf<String?>(null)
    /** The shown phone's screen size and whether it accepts taps, once it starts sharing. */
    var remote by mutableStateOf<Triple<Int, Int, Boolean>?>(null)
    /** "Wi-Fi" or "internet (iroh)": how the link goes. */
    var via by mutableStateOf("")
    @Volatile var videoSink: ((ByteArray) -> Unit)? = null

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    @Volatile private var host: Host? = null
    @Volatile private var join: Channel? = null
    /** The viewer of this phone's screen, while one is connected. */
    val hostChannel: Channel? get() = host?.channel

    fun startHost(ctx: Context) {
        if (host != null) return
        host = Host(ctx.applicationContext).also { it.start() }
    }

    fun stopHost(ctx: Context) {
        host?.close()
        host = null
        qr = null
        viewer = null
        if (PhoneShare.sharing) PhoneShare.stop(ctx)
    }

    /** Connects to the phone behind [text], a scanned pocketdesk://peer QR: Wi-Fi first, then iroh. */
    fun connect(text: String) {
        val o = parse(text) ?: run { status = "Not a PocketDesk phone QR"; return }
        join?.close()
        status = "Connecting to ${o.name}…"
        scope.launch {
            val pipe = o.host?.let { h -> runCatching { tcp(h, o.port) }.getOrNull()?.also { via = "Wi-Fi" } }
                ?: o.iroh?.let { t -> runCatching { iroh(t) }.getOrNull()?.also { via = "internet" } }
            if (pipe == null) { status = "Could not reach that phone. Check both phones are online, then scan a new QR."; return@launch }
            lateinit var ch: Channel
            ch = Channel(pipe, o.key, isHost = false, onText = ::onHostMessage, onVideo = { videoSink?.invoke(it) }, onClose = {
                if (join === ch) { join = null; remote = null; status = "Disconnected" }
            })
            join = ch
            ch.sendText(buildJsonObject { put("type", "hello"); put("name", Build.MODEL) })
            status = "Waiting for ${o.name} to allow screen sharing…"
        }
    }

    fun disconnect() {
        join?.close()
        join = null
        remote = null
        status = ""
    }

    /** Input for the shown phone, as ControlService takes it (tap, press, swipe, key, text). */
    fun input(o: JsonObject) { join?.sendText(o) }
    fun requestKeyframe() { join?.sendText(buildJsonObject { put("type", "keyframe") }) }

    private fun onHostMessage(m: JsonObject) {
        when ((m["type"] as? JsonPrimitive)?.content) {
            "started" -> {
                fun i(k: String) = (m[k] as? JsonPrimitive)?.intOrNull ?: 0
                remote = Triple(i("w"), i("h"), (m["control"] as? JsonPrimitive)?.content == "true")
                status = ""
            }
            "stopped" -> { remote = null; status = "The other phone stopped sharing" }
        }
    }

    /** Called by [ShareService] when the share starts or changes size, and when it ends. */
    fun announce(w: Int, h: Int, control: Boolean) {
        hostChannel?.sendText(buildJsonObject { put("type", "started"); put("w", w); put("h", h); put("control", control) })
    }
    fun announceStop() { hostChannel?.sendText(buildJsonObject { put("type", "stopped") }) }

    private class Target(val host: String?, val port: Int, val iroh: String?, val key: ByteArray, val name: String)

    private val B64 = Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING

    private fun parse(text: String): Target? {
        val m = Regex("pocketdesk://peer#([A-Za-z0-9_-]+)").find(text) ?: return null
        return runCatching {
            val o = Json.parseToJsonElement(String(Base64.decode(m.groupValues[1], B64))) as JsonObject
            fun s(k: String) = (o[k] as? JsonPrimitive)?.content
            Target(s("h"), s("p")?.toIntOrNull() ?: 0, s("i"), Base64.decode(s("k"), B64), s("n") ?: "phone")
        }.getOrNull()?.takeIf { it.key.size == 32 && (it.host != null || it.iroh != null) }
    }

    /** This phone's Wi-Fi address: the one a phone on the same network can reach. */
    private fun lanAddress(): String? = NetworkInterface.getNetworkInterfaces().toList()
        .filter { it.isUp && !it.isLoopback }
        .sortedByDescending { it.name.startsWith("wlan") }
        .flatMap { it.inetAddresses.toList() }
        .firstOrNull { it is Inet4Address && it.isSiteLocalAddress }?.hostAddress

    /** One connection, whichever way it goes: control both ways, and video from the shown phone. */
    interface Pipe {
        suspend fun read(n: Int): ByteArray
        suspend fun write(b: ByteArray)
        /** One framed video packet; [kind] 0 config, 1 key, 2 delta. */
        suspend fun writeVideo(b: ByteArray, kind: Int) = write(b)
        /** Calls [onFrame] with each video packet that arrives apart from control (iroh). */
        fun receiveVideo(onFrame: (ByteArray) -> Unit) {}
        fun close()
    }

    private suspend fun tcp(h: String, port: Int): Pipe = withContext(Dispatchers.IO) {
        val s = Socket()
        s.connect(InetSocketAddress(h, port), 2500)
        tcpPipe(s)
    }

    private fun tcpPipe(s: Socket): Pipe {
        s.tcpNoDelay = true
        val inp = DataInputStream(s.getInputStream().buffered())
        val out = s.getOutputStream().buffered()
        return object : Pipe {
            override suspend fun read(n: Int) = withContext(Dispatchers.IO) { ByteArray(n).also { inp.readFully(it) } }
            override suspend fun write(b: ByteArray) = withContext(Dispatchers.IO) { out.write(b); out.flush() }
            override fun close() { runCatching { s.close() } }
        }
    }

    private suspend fun iroh(ticket: String): Pipe {
        val addr = EndpointTicket.fromString(ticket).endpointAddr()
        val c = withTimeout(15_000) { IrohLink.Node.endpoint(addr.relayUrl()).connect(addr, IrohLink.ALPN) }
        return irohPipe(c, c.openBi())
    }

    /**
     * Over iroh, video goes the way the PC link sends it: each keyframe opens a new one-way stream
     * (config first), its deltas follow, and the viewer drops a stream once a newer one starts. A
     * slow path then skips to the newest picture instead of falling behind.
     */
    private fun irohPipe(c: computer.iroh.Connection, bi: computer.iroh.BiStream): Pipe {
        val recv = bi.recv()
        val send = bi.send()
        return object : Pipe {
            var config: ByteArray? = null
            var gop: computer.iroh.SendStream? = null
            val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
            override suspend fun read(n: Int) = recv.readExact(n.toUInt())
            override suspend fun write(b: ByteArray) = send.writeAll(b)
            override suspend fun writeVideo(b: ByteArray, kind: Int) {
                when (kind) {
                    0 -> config = b
                    1 -> {
                        gop?.let { old -> runCatching { old.finish() } }
                        gop = c.openUni().also { s -> config?.let { s.writeAll(it) }; s.writeAll(b) }
                    }
                    else -> gop?.let { s -> runCatching { s.writeAll(b) } }
                }
            }
            override fun receiveVideo(onFrame: (ByteArray) -> Unit) {
                scope.launch {
                    var current: kotlinx.coroutines.Job? = null
                    while (true) {
                        val s = runCatching { c.acceptUni() }.getOrNull() ?: break
                        current?.cancel()
                        current = launch {
                            runCatching {
                                while (true) {
                                    val n = ByteBuffer.wrap(s.readExact(4u)).int
                                    if (n !in 29..(8 shl 20)) break
                                    onFrame(s.readExact(n.toUInt()))
                                }
                            }
                        }
                    }
                }
            }
            override fun close() { runCatching { c.close(0L, "bye".toByteArray()) }; scope.cancel() }
        }
    }

    private class Host(private val app: Context) {
        private val key = ByteArray(32).also { SecureRandom().nextBytes(it) }
        private val server = ServerSocket(0)
        private val hostScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        @Volatile var channel: Channel? = null

        fun start() {
            status = "Making the QR…"
            hostScope.launch {
                // The iroh address lets a phone on any network in; the Wi-Fi one is faster when it is near.
                val ep = runCatching { IrohLink.Node.endpoint(null) }.getOrNull()
                val ticket = ep?.let { e ->
                    runCatching { withTimeout(4000) { while (e.addr().relayUrl() == null) kotlinx.coroutines.delay(200) } }
                    runCatching { EndpointTicket.fromAddr(e.addr()).toString() }.getOrNull()
                }
                val ip = lanAddress()
                if (ip == null && ticket == null) { status = "This phone is offline"; return@launch }
                val json = buildJsonObject {
                    if (ip != null) { put("h", ip); put("p", server.localPort.toString()) }
                    if (ticket != null) put("i", ticket)
                    put("k", Base64.encodeToString(key, B64)); put("n", Build.MODEL)
                }
                qr = "pocketdesk://peer#" + Base64.encodeToString(json.toString().toByteArray(), B64)
                status = "Scan this from PocketDesk on the other phone (Phone to phone › Scan). Any network works."
                if (ep != null) hostScope.launch {
                    while (true) {
                        val inc = runCatching { ep.acceptNext() }.getOrNull() ?: break
                        launch {
                            runCatching {
                                val c = inc.accept().connect()
                                welcome(irohPipe(c, c.acceptBi()), "internet")
                            }
                        }
                    }
                }
                while (!server.isClosed) {
                    val s = runCatching { server.accept() }.getOrNull() ?: break
                    welcome(tcpPipe(s), "Wi-Fi")
                }
            }
        }

        private fun welcome(pipe: Pipe, how: String) {
            // One viewer at a time; a new one replaces the last.
            channel?.close()
            var hello = false
            lateinit var ch: Channel
            ch = Channel(pipe, key, isHost = true, onText = { m ->
                when ((m["type"] as? JsonPrimitive)?.content) {
                    "hello" -> if (!hello) {
                        hello = true
                        viewer = (m["name"] as? JsonPrimitive)?.content ?: "A phone"
                        via = how
                        status = "$viewer is connected over $how"
                        if (PhoneShare.sharing) PhoneShare.service?.announce() else PhoneShare.ask(app)
                    }
                    "phone_input" -> if (hello) ControlService.instance?.input(m)
                    "keyframe" -> if (hello) PhoneShare.service?.keyframe()
                }
            }, onVideo = {}, onClose = {
                if (channel === ch) {
                    channel = null
                    viewer = null
                    status = "Scan this from PocketDesk on the other phone (Phone to phone › Scan). Any network works."
                    if (PhoneShare.sharing) PhoneShare.stop(app)
                }
            })
            channel = ch
            // Nothing sealed with the key within 10 s: not the phone that saw the QR.
            hostScope.launch { kotlinx.coroutines.delay(10_000); if (!hello) ch.close() }
        }

        fun close() {
            runCatching { server.close() }
            channel?.close()
            channel = null
            hostScope.cancel()
        }
    }

    /**
     * One sealed link. Frames: u32 length, 12-byte nonce (who sent it and whether it is control or
     * video, then a counter that only goes up, so nothing can be replayed), AES-GCM of
     * [type][payload]; type 1 is JSON, 2 a video packet. Writes are queued so a slow link drops
     * video, never blocks the encoder.
     */
    class Channel(
        private val pipe: Pipe, key: ByteArray, private val isHost: Boolean,
        private val onText: (JsonObject) -> Unit, private val onVideo: (ByteArray) -> Unit, private val onClose: () -> Unit,
    ) {
        private val secret = SecretKeySpec(key, "AES")
        private val counter = AtomicLong(0)
        private val videoCounter = AtomicLong(0)
        private val queue = kotlinx.coroutines.channels.Channel<ByteArray>(kotlinx.coroutines.channels.Channel.UNLIMITED)
        private val videoQueue = kotlinx.coroutines.channels.Channel<Pair<ByteArray, Int>>(kotlinx.coroutines.channels.Channel.UNLIMITED)
        @Volatile private var lastVideo = 0L
        @Volatile private var lastControl = 0L
        private val io = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val backlog = AtomicLong(0)
        @Volatile private var closed = false

        init {
            io.launch { try { readLoop() } catch (_: Throwable) {} finally { close() } }
            io.launch {
                try {
                    for (f in queue) pipe.write(framed(f))
                } catch (_: Throwable) {} finally { close() }
            }
            io.launch {
                try {
                    for ((f, kind) in videoQueue) {
                        pipe.writeVideo(framed(f), kind)
                        backlog.addAndGet(-f.size.toLong())
                    }
                } catch (_: Throwable) {} finally { close() }
            }
            pipe.receiveVideo { f -> open(f) }
        }

        fun sendText(o: JsonObject) { if (!closed) queue.trySend(seal(1, o.toString().toByteArray(), video = false)) }
        fun sendVideo(pkt: ByteArray) {
            if (closed) return
            val sealed = seal(2, pkt, video = true)
            backlog.addAndGet(sealed.size.toLong())
            videoQueue.trySend(sealed to pkt[0].toInt())
        }

        private fun framed(f: ByteArray) = ByteBuffer.allocate(4 + f.size).putInt(f.size).put(f).array()

        /** Directions: 1 host control, 2 viewer control, 3 host video; each counts up on its own. */
        private fun seal(type: Int, payload: ByteArray, video: Boolean): ByteArray {
            val dir = if (video) 3 else if (isHost) 1 else 2
            val nonce = ByteBuffer.allocate(12).putInt(dir).putLong((if (video) videoCounter else counter).incrementAndGet()).array()
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, secret, GCMParameterSpec(128, nonce))
            return nonce + c.doFinal(byteArrayOf(type.toByte()) + payload)
        }

        /** Checks and opens one frame. False ends the link (wrong key, replay); a stale video frame is only dropped. */
        private fun open(f: ByteArray): Boolean {
            if (f.size < 29) return false
            val bb = ByteBuffer.wrap(f, 0, 12)
            val dir = bb.int
            val seq = bb.long
            if (dir != (if (isHost) 2 else 1) && (isHost || dir != 3)) return false
            if (dir == 3) { if (seq <= lastVideo) return true } else if (seq <= lastControl) return false
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(128, f, 0, 12))
            // A wrong key fails here.
            val plain = runCatching { c.doFinal(f, 12, f.size - 12) }.getOrNull() ?: return false
            if (dir == 3) lastVideo = seq else lastControl = seq
            when (plain[0].toInt()) {
                1 -> (runCatching { Json.parseToJsonElement(String(plain, 1, plain.size - 1)) }.getOrNull() as? JsonObject)?.let(onText)
                2 -> onVideo(plain.copyOfRange(1, plain.size))
            }
            return true
        }

        private suspend fun readLoop() {
            while (!closed) {
                val n = ByteBuffer.wrap(pipe.read(4)).int
                if (n < 29 || n > 8 shl 20) return
                if (!open(pipe.read(n))) return
            }
        }

        fun close() {
            if (closed) return
            closed = true
            queue.close()
            videoQueue.close()
            pipe.close()
            io.cancel()
            onClose()
        }
    }
}
