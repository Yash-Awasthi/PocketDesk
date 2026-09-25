package com.yasha.pocketdesk

import android.content.Context
import computer.iroh.Connection
import computer.iroh.Endpoint
import computer.iroh.EndpointOptions
import computer.iroh.EndpointTicket
import computer.iroh.RecvStream
import computer.iroh.RelayMode
import computer.iroh.SecretKey
import computer.iroh.presetMinimal
import computer.iroh.presetN0
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Off-LAN transport over iroh: the phone dials the PC by the key in its pairing
 * ticket, over a hole-punched direct QUIC path or an end-to-end encrypted relay.
 *
 * Mirrors the daemon's `iroh_link.js`: one bidirectional stream carries control
 * messages as u32 length + UTF-8 JSON; desktop video arrives as one
 * unidirectional stream per GOP (a u32 GOP number, then packets), and a newer
 * stream makes older ones obsolete. Read progress goes back as `video_ack`.
 */
class IrohLink(
    private val ticket: String,
    private val onText: (String) -> Unit,
    private val onVideo: (ByteArray) -> Unit,
    /** Called once. The code is the daemon's close code (4xxx = refused) when it sent one. */
    private val onClosed: (code: Int?, reason: String) -> Unit,
    /** The selected path every few seconds, e.g. "direct 42 ms" or "relayed 80 ms". */
    private val onPath: (String) -> Unit = {},
) {
    // Any loop failing (a timed-out connection throws from every pending call) ends the link and
    // hands over to the reconnect; uncaught, it would kill the whole app.
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob() +
        kotlinx.coroutines.CoroutineExceptionHandler { _, t -> finish(null, t.message ?: "connection lost") })
    private val outbox = Channel<ByteArray>(Channel.UNLIMITED)
    private val closed = AtomicBoolean(false)
    @Volatile private var conn: Connection? = null

    fun start(onOpen: () -> Unit) {
        scope.launch {
            try {
                val addr = EndpointTicket.fromString(ticket).endpointAddr()
                val c = Node.endpoint(addr.relayUrl()).connect(addr, ALPN)
                conn = c
                val bi = c.openBi()
                val send = bi.send()
                scope.launch { for (msg in outbox) send.writeAll(frame(msg)) }
                scope.launch { acceptVideo(c) }
                scope.launch {
                    while (true) {
                        c.paths().firstOrNull { it.isSelected }?.let { onPath("${if (it.isRelay) "relayed" else "direct"} ${it.rttMs} ms") }
                        kotlinx.coroutines.delay(3000)
                    }
                }
                scope.launch {
                    val reason = runCatching { c.closed() }.getOrDefault("")
                    finish(Regex("\\b(4\\d{3})\\b").find(reason)?.value?.toInt(), reason)
                }
                onOpen()
                val recv = bi.recv()
                while (true) onText(String(readMessage(recv), Charsets.UTF_8))
            } catch (t: Throwable) {
                finish(null, t.message ?: "connection failed")
            }
        }
    }

    fun send(text: String): Boolean = !closed.get() && outbox.trySend(text.toByteArray(Charsets.UTF_8)).isSuccess

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        runCatching { conn?.close(1000L, "bye".toByteArray()) }
        outbox.close()
        scope.cancel()
    }

    /** GOP and packet count read so far; the daemon turns it into the real delay behind QUIC and relay buffers. */
    @Volatile private var progress = 0L to 0L

    private suspend fun acceptVideo(c: Connection) {
        var current: Pair<RecvStream, Job>? = null
        val lock = Mutex()
        scope.launch {
            var sent = progress
            while (true) {
                kotlinx.coroutines.delay(250)
                val p = progress
                if (p != sent && p.first > 0) { send("""{"type":"video_ack","g":${p.first},"f":${p.second}}"""); sent = p }
            }
        }
        while (true) {
            val s = c.acceptUni()
            lock.withLock {
                current?.let { (old, job) -> job.cancel(); runCatching { old.stop(0uL) } }
                current = s to scope.launch {
                    runCatching {
                        val gop = java.nio.ByteBuffer.wrap(s.readExact(4u)).int.toLong() and 0xffffffffL
                        var n = 0L
                        progress = gop to 0L
                        while (true) { onVideo(readMessage(s)); progress = gop to ++n }
                    }
                }
            }
        }
    }

    private fun finish(code: Int?, reason: String) {
        if (!closed.compareAndSet(false, true)) return
        outbox.close()
        scope.cancel()
        onClosed(code, reason)
    }

    /**
     * Endpoints share one persisted secret, so the PC always sees the same device key.
     * The phone uses the PC's own relay: with a self-hosted relay nothing reaches n0.
     */
    object Node {
        private val eps = HashMap<String, Endpoint>()
        private val lock = Mutex()
        private lateinit var key: ByteArray

        fun init(context: Context) {
            computer.iroh.IrohAndroid.installAndroidContext(context)
            val prefs = context.getSharedPreferences("pocketdesk", Context.MODE_PRIVATE)
            val saved = prefs.getString("iroh_key", null)
            key = saved?.let { java.util.Base64.getDecoder().decode(it) } ?: SecretKey.generate().toBytes().also {
                prefs.edit().putString("iroh_key", java.util.Base64.getEncoder().encodeToString(it)).apply()
            }
        }

        suspend fun endpoint(relay: String?): Endpoint = lock.withLock {
            val k = relay ?: ""
            eps[k] ?: Endpoint.bind(
                // n0's relays come with its address lookup, which follows the PC across relay changes.
                if (relay == null || ".n0.iroh.link" in relay) EndpointOptions(preset = presetN0(), secretKey = key, alpns = listOf(ALPN))
                else EndpointOptions(preset = presetMinimal(), secretKey = key, alpns = listOf(ALPN), relayMode = RelayMode.customFromUrls(listOf(relay))),
            ).also { eps[k] = it }
        }
    }

    companion object {
        val ALPN = "pocketdesk/1".toByteArray()
        private const val MAX_MESSAGE = 8 shl 20

        private fun frame(msg: ByteArray): ByteArray =
            java.nio.ByteBuffer.allocate(4 + msg.size).putInt(msg.size).put(msg).array()

        private suspend fun readMessage(s: RecvStream): ByteArray {
            val len = java.nio.ByteBuffer.wrap(s.readExact(4u)).int
            require(len in 0..MAX_MESSAGE) { "bad message length $len" }
            return s.readExact(len.toUInt())
        }
    }
}
