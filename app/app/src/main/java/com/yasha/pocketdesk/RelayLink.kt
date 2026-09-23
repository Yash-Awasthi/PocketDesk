package com.yasha.pocketdesk

import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.PrintWriter
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.atomic.AtomicReference

/**
 * Raw TCP client for the PocketDesk relay protocol (daemon `relay_server.js`).
 *
 * Frames are one JSON object per TCP write, both directions — same framing the
 * daemon's `relay.js` uses, so the greedy JSON parse below mirrors it. The
 * handshake is server-first: the relay sends `{"type":"connected","id":..}`,
 * then the client sends `{"type":"subscribe","channel":..}` once, after which
 * every `publish(channel, data)` is broadcast to all channel members.
 *
 * Used by [WsClient] when the server URL is `relay://host:port/channel` —
 * the off-LAN transport: the phone dials OUT to the relay (no inbound port on
 * the PC, no VPN), and the daemon bridges `rhreq` envelopes to its protocol
 * handler and pushes responses/broadcasts back as `rhresp`/`rhpush`.
 */
class RelayLink(
    private val host: String,
    private val port: Int,
    private val channel: String,
    /** Called with each JSON frame received from the relay (on a reader thread). */
    private val onFrame: (String) -> Unit,
    /** Called once when the socket drops (reader thread). */
    private val onClosed: () -> Unit,
) {
    private val socket = AtomicReference<Socket?>(null)
    @Volatile private var writer: PrintWriter? = null
    @Volatile private var intentClosed = false
    // Callers are UI taps on the main thread, where socket writes throw
    // NetworkOnMainThreadException; one writer thread also keeps frame order.
    private val writes = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "relay-write").apply { isDaemon = true } }

    fun start() {
        val thread = Thread({
            try {
                val s = Socket()
                s.connect(InetSocketAddress(host, port), 10_000)
                s.tcpNoDelay = true
                socket.set(s)
                writer = PrintWriter(s.getOutputStream(), true)
                // Newline-delimited framing (the daemon relay writes one JSON
                // frame + \n per message): readLine handles split segments AND
                // multiple frames per chunk — the old whole-buffer parse
                // deadlocked when two frames coalesced.
                val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
                while (!intentClosed) {
                    val line = reader.readLine() ?: break
                    val trimmed = line.trim()
                    if (trimmed.isNotEmpty()) onFrame(trimmed)
                }
            } catch (_: Exception) {
                // connect/read failure — fall through to onClosed
            } finally {
                writes.shutdown()
                closeQuietly()
                if (!intentClosed) onClosed()
            }
        }, "relay-link")
        thread.isDaemon = true
        thread.start()
    }

    fun send(text: String): Boolean {
        if (writer == null || intentClosed) return false
        writes.execute { writer?.println(text) }
        return true
    }

    fun subscribe() {
        send("""{"type":"subscribe","channel":${jsonString(channel)}}""")
    }

    fun publish(data: String) {
        send("""{"type":"publish","channel":${jsonString(channel)},"data":$data}""")
    }

    fun close() {
        intentClosed = true
        writes.shutdown()
        closeQuietly()
    }

    private fun closeQuietly() {
        try {
            writer?.close()
        } catch (_: Exception) {}
        try {
            socket.getAndSet(null)?.close()
        } catch (_: Exception) {}
        writer = null
    }

    internal fun jsonString(s: String): String {
        val sb = StringBuilder("\"")
        for (ch in s) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch.code < 0x20) sb.append("\\u").append(String.format("%04x", ch.code)) else sb.append(ch)
            }
        }
        return sb.append("\"").toString()
    }

    companion object {
        /** Parse `relay://host:port[/channel]` → (host, port, channel). */
        fun parse(url: String): Triple<String, Int, String>? {
            if (!url.startsWith("relay://")) return null
            val rest = url.removePrefix("relay://").trimEnd('/')
            val parts = rest.split("/")
            val hostPort = parts.getOrNull(0) ?: return null
            val hp = hostPort.split(":")
            val host = hp.getOrNull(0)?.takeIf { it.isNotBlank() } ?: return null
            val port = hp.getOrNull(1)?.toIntOrNull() ?: 8790
            val channel = parts.getOrNull(1)?.takeIf { it.isNotBlank() } ?: "rh-default"
            return Triple(host, port, channel)
        }
    }
}
