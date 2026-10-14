package com.yasha.pocketdesk.ui

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaCodec
import android.media.MediaFormat
import java.nio.ByteBuffer
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Plays the PC's sound: AAC-LC in ADTS frames (the daemon's kind-3 packets) decoded to PCM and
 * written to an AudioTrack. The decoder is configured from the first frame's ADTS header, so it
 * matches whatever rate and channel count the PC mixed at. One is created per desktop session.
 */
class AacPlayer {
    private val queue = LinkedBlockingQueue<ByteArray>(120)
    @Volatile private var running = true
    private val thread = Thread(::run, "aac-decode").apply { isDaemon = true; start() }

    /** One ADTS frame (with its 7-byte header). Drops the oldest when the phone falls behind. */
    fun feed(frame: ByteArray) {
        if (frame.size <= 7) return
        if (!queue.offer(frame)) { queue.poll(); queue.offer(frame) }
    }

    fun release() {
        running = false
        thread.interrupt()
    }

    private fun run() {
        val first = try { queue.poll(5, TimeUnit.SECONDS) } catch (_: InterruptedException) { return } ?: return
        val hdr = adtsHeader(first) ?: return
        val codec = try { MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_AAC) } catch (_: Exception) { return }
        val track = buildTrack(hdr.rate, hdr.channels)
        try {
            val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, hdr.rate, hdr.channels)
            // csd-0: AudioSpecificConfig — object type 2 (AAC-LC), the rate index and channel count.
            val csd = byteArrayOf(((2 shl 3) or (hdr.rateIndex shr 1)).toByte(), ((hdr.rateIndex shl 7) or (hdr.channels shl 3)).toByte())
            format.setByteBuffer("csd-0", ByteBuffer.wrap(csd))
            codec.configure(format, null, null, 0)
            codec.start()
            track.play()
            val info = MediaCodec.BufferInfo()
            var pkt: ByteArray? = first
            while (running) {
                val f = pkt ?: queue.poll(10, TimeUnit.MILLISECONDS)
                pkt = null
                if (f != null) feedCodec(codec, f)
                drain(codec, track, info)
            }
        } catch (_: InterruptedException) {
        } catch (_: Exception) {
            // Decode errors just silence the PC audio; the picture keeps going.
        } finally {
            runCatching { codec.stop() }
            runCatching { codec.release() }
            runCatching { track.stop() }
            runCatching { track.release() }
        }
    }

    private fun feedCodec(codec: MediaCodec, frame: ByteArray) {
        val idx = codec.dequeueInputBuffer(10_000)
        if (idx < 0) return
        val buf = codec.getInputBuffer(idx) ?: return
        buf.clear()
        buf.put(frame, 7, frame.size - 7) // skip the ADTS header; csd-0 already described the stream
        codec.queueInputBuffer(idx, 0, frame.size - 7, 0, 0)
    }

    private fun drain(codec: MediaCodec, track: AudioTrack, info: MediaCodec.BufferInfo) {
        while (true) {
            val idx = codec.dequeueOutputBuffer(info, 0)
            if (idx < 0) return
            val out = codec.getOutputBuffer(idx)
            if (out != null && info.size > 0) {
                val pcm = ByteArray(info.size)
                out.position(info.offset)
                out.get(pcm, 0, info.size)
                track.write(pcm, 0, pcm.size)
            }
            codec.releaseOutputBuffer(idx, false)
        }
    }

    private fun buildTrack(rate: Int, channels: Int): AudioTrack {
        val mask = if (channels >= 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO
        val min = AudioTrack.getMinBufferSize(rate, mask, AudioFormat.ENCODING_PCM_16BIT).coerceAtLeast(4096)
        return AudioTrack(
            AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build(),
            AudioFormat.Builder().setSampleRate(rate).setChannelMask(mask)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build(),
            min * 2, AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE,
        )
    }
}

private val ADTS_RATES = intArrayOf(96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350)

private class AdtsInfo(val rate: Int, val rateIndex: Int, val channels: Int)

/** Rate and channel count from an ADTS header, or null if it is not one. */
private fun adtsHeader(frame: ByteArray): AdtsInfo? {
    if (frame.size < 7 || frame[0].toInt() and 0xff != 0xff || frame[1].toInt() and 0xf6 != 0xf0) return null
    val rateIndex = (frame[2].toInt() shr 2) and 0x0f
    if (rateIndex >= ADTS_RATES.size) return null
    val channels = (((frame[2].toInt() and 0x01) shl 2) or ((frame[3].toInt() shr 6) and 0x03)).coerceAtLeast(1)
    return AdtsInfo(ADTS_RATES[rateIndex], rateIndex, channels)
}
