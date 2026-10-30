package com.yasha.pocketdesk

import android.content.Context
import android.os.Build
import android.util.Base64
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicLong
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Phone to phone, no PC: one phone shows a QR with its address and a fresh secret key, the other
 * scans it and connects straight to it over the same Wi-Fi. Everything on the socket is sealed with
 * that key (AES-GCM), so only the phone that saw the QR gets in. The shown phone streams its screen
 * with [ShareService] (its owner still says yes to Android's capture prompt) and acts on the other
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
    /** The shown phone's screen size and whether it accepts taps, once it starts sharing. */
    var remote by mutableStateOf<Triple<Int, Int, Boolean>?>(null)
    @Volatile var videoSink: ((ByteArray) -> Unit)? = null

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
        if (PhoneShare.sharing) PhoneShare.stop(ctx)
    }

    /** Connects to the phone behind [text], a scanned pocketdesk://peer QR. */
    fun connect(text: String) {
        val o = parse(text) ?: run { status = "Not a PocketDesk phone QR"; return }
        join?.close()
        status = "Connecting to ${o.name}…"
        Thread {
            try {
                val s = Socket()
                s.connect(InetSocketAddress(o.host, o.port), 5000)
                val ch = Channel(s, o.key, isHost = false, onText = ::onHostMessage, onVideo = { videoSink?.invoke(it) }, onClose = {
                    if (join?.socket === s) { join = null; remote = null; status = "Disconnected" }
                })
                join = ch
                ch.sendText(buildJsonObject { put("type", "hello"); put("name", Build.MODEL) })
                status = "Waiting for ${o.name} to allow screen sharing…"
            } catch (e: Exception) {
                status = "Could not reach that phone: ${e.message}. Both phones need the same Wi-Fi."
            }
        }.start()
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

    private data class Target(val host: String, val port: Int, val key: ByteArray, val name: String)

    private fun parse(text: String): Target? {
        val m = Regex("pocketdesk://peer#([A-Za-z0-9_-]+)").find(text) ?: return null
        return runCatching {
            val o = Json.parseToJsonElement(String(Base64.decode(m.groupValues[1], Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))) as JsonObject
            fun s(k: String) = (o[k] as JsonPrimitive).content
            Target(s("h"), s("p").toInt(), Base64.decode(s("k"), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING), (o["n"] as? JsonPrimitive)?.content ?: "phone")
        }.getOrNull()?.takeIf { it.key.size == 32 }
    }

    /** This phone's Wi-Fi address: the one the other phone can reach. */
    private fun lanAddress(): String? = NetworkInterface.getNetworkInterfaces().toList()
        .filter { it.isUp && !it.isLoopback }
        .sortedByDescending { it.name.startsWith("wlan") }
        .flatMap { it.inetAddresses.toList() }
        .firstOrNull { it is Inet4Address && it.isSiteLocalAddress }?.hostAddress

    private class Host(private val app: Context) {
        private val key = ByteArray(32).also { SecureRandom().nextBytes(it) }
        private val server = ServerSocket(0)
        @Volatile var channel: Channel? = null

        fun start() {
            val ip = lanAddress()
            if (ip == null) { status = "Connect this phone to Wi-Fi first"; server.close(); return }
            val b64 = { b: ByteArray -> Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) }
            val json = buildJsonObject { put("h", ip); put("p", server.localPort.toString()); put("k", b64(key)); put("n", Build.MODEL) }
            qr = "pocketdesk://peer#" + b64(json.toString().toByteArray())
            status = "Scan this from PocketDesk on the other phone (Phone to phone › Scan)"
            Thread({
                while (!server.isClosed) {
                    val s = runCatching { server.accept() }.getOrNull() ?: break
                    // One viewer at a time; a new one replaces the last.
                    channel?.close()
                    s.soTimeout = 10_000
                    var hello = false
                    val ch = Channel(s, key, isHost = true, onText = { m ->
                        when ((m["type"] as? JsonPrimitive)?.content) {
                            "hello" -> if (!hello) {
                                hello = true
                                s.soTimeout = 0
                                status = "${(m["name"] as? JsonPrimitive)?.content ?: "A phone"} is connected"
                                if (PhoneShare.sharing) PhoneShare.service?.announce() else PhoneShare.ask(app)
                            }
                            "phone_input" -> if (hello) ControlService.instance?.input(m)
                            "keyframe" -> if (hello) PhoneShare.service?.keyframe()
                        }
                    }, onVideo = {}, onClose = {
                        if (channel?.socket === s) {
                            channel = null
                            status = "Scan this from PocketDesk on the other phone (Phone to phone › Scan)"
                            if (PhoneShare.sharing) PhoneShare.stop(app)
                        }
                    })
                    channel = ch
                }
            }, "peer-host").start()
        }

        fun close() {
            runCatching { server.close() }
            channel?.close()
            channel = null
        }
    }

    /**
     * One sealed socket. Frames: u32 length, 12-byte nonce (sender's direction, then a counter
     * that only goes up, so nothing can be replayed), AES-GCM of [type][payload]; type 1 is JSON,
     * 2 a video packet. Writes go through a queue so a slow link drops video, never blocks the encoder.
     */
    class Channel(
        val socket: Socket, key: ByteArray, private val isHost: Boolean,
        private val onText: (JsonObject) -> Unit, private val onVideo: (ByteArray) -> Unit, private val onClose: () -> Unit,
    ) {
        private val secret = SecretKeySpec(key, "AES")
        private val counter = AtomicLong(0)
        private val queue = LinkedBlockingQueue<ByteArray>()
        val backlog = AtomicLong(0)
        @Volatile private var closed = false

        init {
            socket.tcpNoDelay = true
            Thread(::readLoop, "peer-read").start()
            Thread(::writeLoop, "peer-write").start()
        }

        fun sendText(o: JsonObject) = enqueue(1, o.toString().toByteArray())
        fun sendVideo(pkt: ByteArray) = enqueue(2, pkt)

        private fun enqueue(type: Int, payload: ByteArray) {
            if (closed) return
            val nonce = ByteBuffer.allocate(12).putInt(if (isHost) 1 else 2).putLong(counter.incrementAndGet()).array()
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, secret, GCMParameterSpec(128, nonce))
            val sealed = nonce + c.doFinal(byteArrayOf(type.toByte()) + payload)
            backlog.addAndGet(sealed.size.toLong())
            queue.offer(sealed)
        }

        private fun writeLoop() {
            try {
                val out = DataOutputStream(socket.getOutputStream().buffered())
                while (!closed) {
                    val f = queue.take()
                    out.writeInt(f.size)
                    out.write(f)
                    if (queue.isEmpty()) out.flush()
                    backlog.addAndGet(-f.size.toLong())
                }
            } catch (_: Exception) {} finally { close() }
        }

        private fun readLoop() {
            var last = 0L
            try {
                val inp = DataInputStream(socket.getInputStream().buffered())
                while (!closed) {
                    val n = inp.readInt()
                    if (n < 29 || n > 8 shl 20) break
                    val f = ByteArray(n).also { inp.readFully(it) }
                    val bb = ByteBuffer.wrap(f, 0, 12)
                    val dir = bb.int
                    val seq = bb.long
                    if (dir != (if (isHost) 2 else 1) || seq <= last) break
                    last = seq
                    val c = Cipher.getInstance("AES/GCM/NoPadding")
                    c.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(128, f, 0, 12))
                    // A wrong key fails here, and the socket closes.
                    val plain = c.doFinal(f, 12, n - 12)
                    when (plain[0].toInt()) {
                        1 -> (runCatching { Json.parseToJsonElement(String(plain, 1, plain.size - 1)) }.getOrNull() as? JsonObject)?.let(onText)
                        2 -> onVideo(plain.copyOfRange(1, plain.size))
                    }
                }
            } catch (_: Exception) {} finally { close() }
        }

        fun close() {
            if (closed) return
            closed = true
            queue.offer(ByteArray(0))
            runCatching { socket.close() }
            onClose()
        }
    }
}
