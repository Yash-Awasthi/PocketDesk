package com.yasha.pocketdesk

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Display
import android.view.Surface
import androidx.core.app.NotificationCompat
import androidx.core.content.IntentCompat

/**
 * The phone screen as H.264 to the PC: MediaProjection mirrors into a VirtualDisplay drawn
 * straight into the encoder's input surface. Rebuilds at the new size on rotation or fold.
 */
class ShareService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var encoder: Encoder? = null
    private val sink = LinkSink(0) { encoder?.keyframe() }
    private var size = 0 to 0
    /** Live panes for recent apps; only on a rooted phone whose owner let PocketDesk use root. */
    @Volatile var panes: RootPanes? = null
        private set

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP || projection != null) {
            if (intent?.action == ACTION_STOP) stopSelf()
            return START_NOT_STICKY
        }
        startForeground(ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        val data = intent?.let { IntentCompat.getParcelableExtra(it, EXTRA_DATA, Intent::class.java) }
        val p = data?.let { getSystemService(MediaProjectionManager::class.java).getMediaProjection(intent.getIntExtra(EXTRA_CODE, 0), it) }
        if (p == null) { stopSelf(); return START_NOT_STICKY }
        projection = p
        p.registerCallback(object : MediaProjection.Callback() {
            // The owner stopped it from the status bar chip or the lock screen.
            override fun onStop() { stopSelf() }
        }, main)
        size = captureSize()
        val enc = Encoder(size, BITRATE, sink::send).also { encoder = it }
        Link.client.phoneShareStart(size.first, size.second, ControlService.instance != null)
        display = p.createVirtualDisplay("PocketDesk", size.first, size.second, resources.displayMetrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, enc.surface, null, null)
        getSystemService(DisplayManager::class.java).registerDisplayListener(displayChanged, main)
        PhoneShare.service = this
        PhoneShare.sharing = true
        ControlService.instance?.sendApps()
        // su may wait on the owner's grant prompt, so root is asked off the main thread.
        Thread {
            if (!Root.available()) return@Thread
            main.post {
                if (PhoneShare.service !== this) return@post
                panes = RootPanes(this, size)
                ControlService.instance?.sendApps()
            }
        }.start()
        return START_NOT_STICKY
    }

    private val displayChanged = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(id: Int) {}
        override fun onDisplayRemoved(id: Int) {}
        override fun onDisplayChanged(id: Int) {
            if (id != Display.DEFAULT_DISPLAY || display == null) return
            val next = captureSize()
            if (next == size) return
            size = next
            val old = encoder
            val enc = Encoder(next, BITRATE, sink::send).also { encoder = it }
            display?.resize(next.first, next.second, resources.displayMetrics.densityDpi)
            display?.surface = enc.surface
            old?.stop()
            Link.client.phoneShareStart(next.first, next.second, ControlService.instance != null)
        }
    }

    /** Screen size scaled so the long side fits [MAX_SIDE] and the encoder takes it. */
    private fun captureSize(): Pair<Int, Int> {
        val (w, h) = PhoneShare.screenSize(this)
        val caps = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC).let { c ->
            c.codecInfo.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC).videoCapabilities.also { c.release() }
        }
        var scale = minOf(1.0, MAX_SIDE.toDouble() / maxOf(w, h))
        while (true) {
            val sw = (w * scale).toInt() / 8 * 8
            val sh = (h * scale).toInt() / 8 * 8
            if (caps?.isSizeSupported(sw, sh) != false || sw < 160) return sw to sh
            scale *= 0.85
        }
    }

    fun announce() {
        Link.client.phoneShareStart(size.first, size.second, ControlService.instance != null)
        keyframe()
        ControlService.instance?.sendApps()
    }

    /** A viewer joined or fell behind: every stream resends its config and makes its next frame a keyframe. */
    fun keyframe() {
        encoder?.keyframe()
        panes?.keyframe()
    }

    override fun onDestroy() {
        getSystemService(DisplayManager::class.java).unregisterDisplayListener(displayChanged)
        display?.release()
        display = null
        encoder?.stop()
        encoder = null
        panes?.close()
        panes = null
        projection?.stop()
        projection = null
        PhoneShare.service = null
        if (PhoneShare.sharing) Link.client.phoneShareStop()
        PhoneShare.sharing = false
        super.onDestroy()
    }

    private fun notification(): Notification {
        val mgr = getSystemService(NotificationManager::class.java)
        if (mgr.getNotificationChannel(CHANNEL) == null) {
            mgr.createNotificationChannel(NotificationChannel(CHANNEL, "Screen shared with PC", NotificationManager.IMPORTANCE_LOW))
        }
        val stop = PendingIntent.getService(this, 0, Intent(this, ShareService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("Your PC is viewing this phone")
            .setContentText(if (ControlService.instance != null) "It can also tap and type here" else "View only: PC control is off")
            .setOngoing(true)
            // Shown in full while Android masks notifications during the share, so Stop stays reachable.
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(0, "Stop", stop)
            .build()
    }

    companion object {
        const val EXTRA_CODE = "code"
        const val EXTRA_DATA = "data"
        private const val ACTION_STOP = "stop"
        private const val CHANNEL = "share"
        private const val ID = 9
        // ponytail: fixed size and rate; adapt to the link like the daemon's presets if a slow link needs it.
        private const val MAX_SIDE = 1920
        private const val BITRATE = 6_000_000
    }
}

/** One H.264 stream fed through [surface]; each packet goes to [sink] with its kind: 0 config, 1 key, 2 delta. */
class Encoder(size: Pair<Int, Int>, bitrate: Int, private val sink: (Int, ByteArray) -> Unit) {
    @Volatile private var config: ByteArray? = null
    private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    val surface: Surface
    private val drain: Thread

    init {
        val f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, size.first, size.second).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, 30)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            // A still screen produces no frames at all without this, and a new viewer would wait for one.
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000)
            setInteger(MediaFormat.KEY_PRIORITY, 0)
            setInteger(MediaFormat.KEY_LATENCY, 1)
        }
        codec.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        surface = codec.createInputSurface()
        codec.start()
        drain = Thread({
            val info = MediaCodec.BufferInfo()
            try {
                while (!Thread.currentThread().isInterrupted) {
                    val i = codec.dequeueOutputBuffer(info, 100_000)
                    if (i < 0) continue
                    val buf = codec.getOutputBuffer(i)
                    val bytes = ByteArray(info.size)
                    buf?.position(info.offset)
                    buf?.get(bytes)
                    codec.releaseOutputBuffer(i, false)
                    val kind = when {
                        info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0 -> 0.also { config = bytes }
                        info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0 -> 1
                        else -> 2
                    }
                    if (bytes.isNotEmpty()) sink(kind, bytes)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                }
            } catch (_: IllegalStateException) {
                // Codec released under us during a rebuild or stop.
            }
        }, "share-encoder").also { it.start() }
    }

    /** A viewer joined or fell behind: the held config again, then a keyframe next. */
    fun keyframe() {
        config?.let { sink(0, it) }
        runCatching { codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }) }
    }

    fun stop() {
        drain.interrupt()
        drain.join(500)
        runCatching { codec.stop() }
        runCatching { codec.release() }
        surface.release()
    }
}

/** One stream's packets to the PC as [slot * 4 + kind, ...annexB]; a link that falls behind skips to the next keyframe. */
class LinkSink(private val slot: Int, private val requestKey: () -> Unit) {
    @Volatile private var dropping = false

    fun send(kind: Int, data: ByteArray) {
        if (kind == 1) dropping = false
        if (kind == 2 && dropping) return
        if (kind != 0 && Link.client.uploadBacklog() > MAX_BACKLOG) { dropping = true; requestKey(); return }
        Link.client.sendPhoneVideo(byteArrayOf((slot * 4 + kind).toByte()) + data)
    }

    companion object {
        private const val MAX_BACKLOG = 1_500_000L
    }
}
