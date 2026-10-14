package com.yasha.pocketdesk.ui

import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.view.Surface
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Hardware video decode straight onto a Surface, for whichever codec the daemon chose (H.264, HEVC
 * or AV1). Packets are the daemon's binary desktop messages: a kind byte (0 config, 1 key, 2 delta)
 * then the bitstream. The codec can change on a restart, so the decoder is rebuilt when it does.
 * After a dropped packet it waits for the next config, which the daemon sends on resync.
 */
class H264Player(
    private val surface: Surface,
    private val onSize: (Int, Int) -> Unit,
    private val onLost: () -> Unit,
    private val onShown: (sentAtMs: Long) -> Unit = {},
    codec: String = "h264",
) {
    private val queue = LinkedBlockingQueue<ByteArray>(90)
    @Volatile private var running = true
    @Volatile private var needConfig = true
    @Volatile private var mime = codecMime(codec)
    @Volatile private var wantMime = codecMime(codec)
    private val thread = Thread(::run, "video-decode").apply { start() }

    fun feed(pkt: ByteArray) {
        if (pkt.isEmpty()) return
        if (!queue.offer(pkt)) { queue.clear(); lost() }
    }

    /** Switch codec (e.g. the daemon stepped between HEVC and H.264); the decode thread rebuilds. */
    fun setCodec(codec: String) {
        val m = codecMime(codec)
        if (m != wantMime) { wantMime = m; queue.clear(); lost() }
    }

    private fun lost() {
        if (!needConfig) { needConfig = true; onLost() }
    }

    fun release() {
        running = false
        thread.interrupt()
    }

    private fun run() {
        while (running) {
            mime = wantMime
            val codec = try { MediaCodec.createDecoderByType(mime) } catch (_: Exception) { return }
            try {
                val format = MediaFormat.createVideoFormat(mime, 1920, 1080)
                if (Build.VERSION.SDK_INT >= 30) format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                codec.configure(format, surface, null, 0)
                codec.start()
                val info = MediaCodec.BufferInfo()
                while (running && mime == wantMime) {
                    val pkt = queue.poll(4, TimeUnit.MILLISECONDS)
                    if (pkt != null) queueInput(codec, pkt)
                    drain(codec, info)
                }
            } catch (_: InterruptedException) {
                return
            } catch (_: Exception) {
                // Codec errors end this decoder; loop rebuilds, or the screen reopens the stream.
            } finally {
                runCatching { codec.stop() }
                runCatching { codec.release() }
            }
            // A codec switch loops to rebuild; anything else (error, stop) falls back to a fresh stream.
            if (running && mime == wantMime) { lost(); return }
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

private val UUID = "RH-latency-stamp".toByteArray()
// H.264: start code, SEI (0x06,0x05), length 23. HEVC: start code, prefix-SEI NAL header, 0x05, length 23.
private val H264_HEAD = byteArrayOf(0, 0, 0, 1, 0x06, 0x05, 23) + UUID
private val HEVC_HEAD = byteArrayOf(0, 0, 0, 1, 0x4e, 0x01, 0x05, 23) + UUID
// AV1: padding OBU (0x7a) with length 23, then the UUID — at the very end of the packet.
private val AV1_HEAD = byteArrayOf(0x7a, 23) + UUID

/** Daemon send time from the SEI/OBU stamp on a frame packet (H.264, HEVC or AV1), or null when absent. */
internal fun frameStamp(pkt: ByteArray): Long? {
    timeAfter(pkt, 1, H264_HEAD)?.let { return it }
    timeAfter(pkt, 1, HEVC_HEAD)?.let { return it }
    timeAfter(pkt, pkt.size - (AV1_HEAD.size + 7), AV1_HEAD)?.let { return it }
    return null
}

/** The 7-bit-per-byte time right after [head] at [headAt], or null if [head] is not there. */
private fun timeAfter(pkt: ByteArray, headAt: Int, head: ByteArray): Long? {
    if (headAt < 0) return null
    val at = headAt + head.size
    if (pkt.size < at + 7) return null
    for (i in head.indices) if (pkt[headAt + i] != head[i]) return null
    var v = 0L
    for (i in 0 until 7) v = v * 128 + (pkt[at + i].toInt() and 0x7f)
    return v
}
