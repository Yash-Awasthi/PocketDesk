package com.yasha.pocketdesk.ui

import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.view.Surface
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Hardware H.264 decode straight onto a Surface. Packets are the daemon's binary
 * desktop messages: kind byte (0 config, 1 key, 2 delta) then Annex B data.
 * After a dropped packet it waits for the next config, which the daemon sends on resync.
 */
class H264Player(
    private val surface: Surface,
    private val onSize: (Int, Int) -> Unit,
    private val onLost: () -> Unit,
    private val onShown: (sentAtMs: Long) -> Unit = {},
) {
    private val queue = LinkedBlockingQueue<ByteArray>(90)
    @Volatile private var running = true
    @Volatile private var needConfig = true
    private val thread = Thread(::run, "h264-decode").apply { start() }

    fun feed(pkt: ByteArray) {
        if (pkt.isEmpty()) return
        if (!queue.offer(pkt)) { queue.clear(); lost() }
    }

    private fun lost() {
        if (!needConfig) { needConfig = true; onLost() }
    }

    fun release() {
        running = false
        thread.interrupt()
    }

    private fun run() {
        val codec = try { MediaCodec.createDecoderByType("video/avc") } catch (_: Exception) { return }
        try {
            val format = MediaFormat.createVideoFormat("video/avc", 1920, 1080)
            if (Build.VERSION.SDK_INT >= 30) format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
            codec.configure(format, surface, null, 0)
            codec.start()
            val info = MediaCodec.BufferInfo()
            while (running) {
                val pkt = queue.poll(4, TimeUnit.MILLISECONDS)
                if (pkt != null) queueInput(codec, pkt)
                drain(codec, info)
            }
        } catch (_: InterruptedException) {
        } catch (_: Exception) {
            // Codec errors end playback; the screen falls back to reopening the stream.
        } finally {
            runCatching { codec.stop() }
            runCatching { codec.release() }
        }
    }

    private fun queueInput(codec: MediaCodec, pkt: ByteArray) {
        val kind = pkt[0].toInt()
        if (needConfig && kind != 0) return
        needConfig = false
        val idx = codec.dequeueInputBuffer(20_000)
        if (idx < 0) { lost(); return }
        val buf = codec.getInputBuffer(idx) ?: return
        buf.clear()
        buf.put(pkt, 1, pkt.size - 1)
        val flags = if (kind == 0) MediaCodec.BUFFER_FLAG_CODEC_CONFIG else 0
        // The daemon's send time rides through the decoder as the presentation time.
        codec.queueInputBuffer(idx, 0, pkt.size - 1, (frameStamp(pkt) ?: 0L) * 1000, flags)
    }

    private fun drain(codec: MediaCodec, info: MediaCodec.BufferInfo) {
        while (true) {
            val idx = codec.dequeueOutputBuffer(info, 0)
            when {
                idx >= 0 -> {
                    codec.releaseOutputBuffer(idx, true)
                    if (info.presentationTimeUs > 0) onShown(info.presentationTimeUs / 1000)
                }
                idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    val f = codec.outputFormat
                    val w = if (f.containsKey("crop-right")) f.getInteger("crop-right") - f.getInteger("crop-left") + 1 else f.getInteger(MediaFormat.KEY_WIDTH)
                    val h = if (f.containsKey("crop-bottom")) f.getInteger("crop-bottom") - f.getInteger("crop-top") + 1 else f.getInteger(MediaFormat.KEY_HEIGHT)
                    onSize(w, h)
                }
                else -> return
            }
        }
    }
}

private val STAMP_HEAD = byteArrayOf(0, 0, 0, 1, 0x06, 0x05, 23) + "RH-latency-stamp".toByteArray()

/** Daemon send time from the SEI unit at the front of a frame packet, or null when absent. */
internal fun frameStamp(pkt: ByteArray): Long? {
    val at = 1 + STAMP_HEAD.size
    if (pkt.size < at + 7) return null
    for (i in STAMP_HEAD.indices) if (pkt[1 + i] != STAMP_HEAD[i]) return null
    var v = 0L
    for (i in 0 until 7) v = v * 128 + (pkt[at + i].toInt() and 0x7f)
    return v
}
