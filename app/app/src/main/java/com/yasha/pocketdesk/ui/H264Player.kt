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
class H264Player(private val surface: Surface, private val onSize: (Int, Int) -> Unit, private val onLost: () -> Unit) {
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
        codec.queueInputBuffer(idx, 0, pkt.size - 1, System.nanoTime() / 1000, flags)
    }

    private fun drain(codec: MediaCodec, info: MediaCodec.BufferInfo) {
        while (true) {
            val idx = codec.dequeueOutputBuffer(info, 0)
            when {
                idx >= 0 -> codec.releaseOutputBuffer(idx, true)
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
