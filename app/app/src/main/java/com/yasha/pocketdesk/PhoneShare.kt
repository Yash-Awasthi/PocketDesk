package com.yasha.pocketdesk

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Path
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
import android.os.SystemClock
import android.view.Display
import android.view.Surface
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.InputMethodManager
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.app.NotificationCompat
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * The PC views and controls this phone. The owner consents every time through Android's own
 * screen-capture prompt; [ShareService] streams the screen, [ControlService] carries the PC's input.
 */
object PhoneShare {
    /** True while the screen is going to the PC; the Desktop screen shows the swap-back panel then. */
    var sharing by mutableStateOf(false)
        internal set
    @Volatile internal var service: ShareService? = null

    /** Opens Android's consent prompt; nothing is shared until the owner accepts it. */
    fun ask(ctx: Context) {
        Notifier.shareRequestGone(ctx)
        // One prompt at a time: every reload of the PC page asks again.
        if (ShareConsentActivity.open) return
        ctx.startActivity(Intent(ctx, ShareConsentActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun stop(ctx: Context) {
        ctx.stopService(Intent(ctx, ShareService::class.java))
    }

    fun onMessage(app: Context, ev: RhEvent.Phone) {
        when (ev.type) {
            // Already sharing: the daemon lost track (screen off, reconnect), so the share is announced again.
            "phone_share_request" -> if (sharing) service?.announce()
                else if (MainActivity.foreground) ask(app) else Notifier.shareRequest(app)
            "phone_share_stop" -> stop(app)
            "phone_keyframe" -> service?.keyframe()
            "phone_input" -> ControlService.instance?.input(ev.msg)
            "phone_fs" -> PhoneStorage.handle(app, ev.msg)
            "phone_switch" -> (ev.msg["pkg"] as? JsonPrimitive)?.content?.let { ControlService.instance?.switchTo(it) }
        }
    }

    /** Real pixel size of the screen in use now: the inner or cover screen of a foldable or flip phone. */
    @Suppress("DEPRECATION")
    fun screenSize(ctx: Context): Pair<Int, Int> {
        val p = android.graphics.Point()
        ctx.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY).getRealSize(p)
        return p.x to p.y
    }
}

/** Invisible: shows the system capture prompt and starts the share on yes. */
class ShareConsentActivity : ComponentActivity() {
    private val consent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        if (r.resultCode == Activity.RESULT_OK && r.data != null) {
            startForegroundService(Intent(this, ShareService::class.java)
                .putExtra(ShareService.EXTRA_CODE, r.resultCode).putExtra(ShareService.EXTRA_DATA, r.data))
        }
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        open = true
        if (savedInstanceState != null) return
        if (PhoneShare.sharing) { finish(); return }
        // A new token every time: the owner is asked on every share, never once for good.
        consent.launch(getSystemService(MediaProjectionManager::class.java).createScreenCaptureIntent())
    }

    override fun onDestroy() {
        open = false
        super.onDestroy()
    }

    companion object {
        @Volatile var open = false
    }
}

/**
 * The phone screen as H.264 to the PC: MediaProjection mirrors into a VirtualDisplay drawn
 * straight into the encoder's input surface. Rebuilds at the new size on rotation or fold.
 */
class ShareService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var encoder: MediaCodec? = null
    private var drain: Thread? = null
    @Volatile private var config: ByteArray? = null
    @Volatile private var dropping = false
    private var size = 0 to 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP || projection != null) {
            if (intent?.action == ACTION_STOP) stopSelf()
            return START_NOT_STICKY
        }
        startForeground(ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        val data = intent?.getParcelableExtra(EXTRA_DATA, Intent::class.java)
        val p = data?.let { getSystemService(MediaProjectionManager::class.java).getMediaProjection(intent.getIntExtra(EXTRA_CODE, 0), it) }
        if (p == null) { stopSelf(); return START_NOT_STICKY }
        projection = p
        p.registerCallback(object : MediaProjection.Callback() {
            // The owner stopped it from the status bar chip or the lock screen.
            override fun onStop() { stopSelf() }
        }, main)
        size = captureSize()
        val surface = startEncoder(size)
        Link.client.phoneShareStart(size.first, size.second, ControlService.instance != null)
        display = p.createVirtualDisplay("PocketDesk", size.first, size.second, resources.displayMetrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, surface, null, null)
        getSystemService(DisplayManager::class.java).registerDisplayListener(displayChanged, main)
        PhoneShare.service = this
        PhoneShare.sharing = true
        ControlService.instance?.sendApps()
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
            val oldDrain = drain
            val surface = startEncoder(next)
            display?.resize(next.first, next.second, resources.displayMetrics.densityDpi)
            display?.surface = surface
            stopEncoder(old, oldDrain)
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

    private fun startEncoder(s: Pair<Int, Int>): Surface {
        val f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, s.first, s.second).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, BITRATE)
            setInteger(MediaFormat.KEY_FRAME_RATE, 30)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            // A still screen produces no frames at all without this, and a new viewer would wait for one.
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000)
            setInteger(MediaFormat.KEY_PRIORITY, 0)
            setInteger(MediaFormat.KEY_LATENCY, 1)
        }
        val c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        c.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val surface = c.createInputSurface()
        c.start()
        encoder = c
        drain = Thread({
            val info = MediaCodec.BufferInfo()
            try {
                while (!Thread.currentThread().isInterrupted) {
                    val i = c.dequeueOutputBuffer(info, 100_000)
                    if (i < 0) continue
                    val buf = c.getOutputBuffer(i)
                    val bytes = ByteArray(info.size)
                    buf?.position(info.offset)
                    buf?.get(bytes)
                    c.releaseOutputBuffer(i, false)
                    val kind = when {
                        info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0 -> 0.also { config = bytes }
                        info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0 -> 1
                        else -> 2
                    }
                    if (bytes.isNotEmpty()) emit(kind, bytes)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                }
            } catch (_: IllegalStateException) {
                // Codec released under us during a rebuild or stop.
            }
        }, "share-encoder").also { it.start() }
        return surface
    }

    private fun emit(kind: Int, data: ByteArray) {
        val c = Link.client
        if (kind == 1) dropping = false
        if (kind == 2 && dropping) return
        // A link slower than the stream: skip to the next keyframe instead of queueing seconds of video.
        if (kind != 0 && c.uploadBacklog() > MAX_BACKLOG) { dropping = true; keyframe(); return }
        c.sendPhoneVideo(byteArrayOf(kind.toByte()) + data)
    }

    fun announce() {
        Link.client.phoneShareStart(size.first, size.second, ControlService.instance != null)
        keyframe()
        ControlService.instance?.sendApps()
    }

    /** A viewer joined or fell behind: send the held config, then make the next frame a keyframe. */
    fun keyframe() {
        config?.let { Link.client.sendPhoneVideo(byteArrayOf(0) + it) }
        runCatching { encoder?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }) }
    }

    private fun stopEncoder(c: MediaCodec?, t: Thread?) {
        t?.interrupt()
        t?.join(500)
        runCatching { c?.stop() }
        runCatching { c?.release() }
    }

    override fun onDestroy() {
        getSystemService(DisplayManager::class.java).unregisterDisplayListener(displayChanged)
        display?.release()
        display = null
        stopEncoder(encoder, drain)
        encoder = null
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
        private const val MAX_BACKLOG = 1_500_000L
    }
}

/**
 * Carries the PC's taps, swipes, keys and text into whatever app is in front, and tracks recent
 * apps for the PC's panes. Acts only while the screen is shared.
 */
class ControlService : AccessibilityService() {
    private val recent = ArrayList<String>()
    private var active: String? = null
    private var switchingTo: String? = null
    private var switchUntil = 0L

    override fun onServiceConnected() { instance = this }
    override fun onDestroy() { if (instance === this) instance = null; super.onDestroy() }
    override fun onInterrupt() {}

    private val main = Handler(Looper.getMainLooper())
    // Window events fire mid-transition, so the front app is read once they settle.
    private val settle = Runnable { foreground(rootInActiveWindow?.packageName?.toString()) }

    override fun onAccessibilityEvent(e: AccessibilityEvent) {
        main.removeCallbacks(settle)
        main.postDelayed(settle, SETTLE_MS)
    }

    private fun foreground(pkg: String?) {
        // The keyboard and the status bar open windows over an app without leaving it.
        if (pkg == null || pkg == "com.android.systemui" || pkg in keyboards()) return
        if (pkg == switchingTo) switchingTo = null
        if (pkg == active) return
        active = pkg
        if (pkg != packageName && packageManager.getLaunchIntentForPackage(pkg) != null && !isHome(pkg)) {
            recent.remove(pkg)
            recent.add(0, pkg)
            if (recent.size > 12) recent.removeAt(recent.size - 1)
        }
        sendApps()
    }

    fun sendApps() {
        if (!PhoneShare.sharing) return
        val a = active
        Link.client.phoneApps(a?.let { it to label(it) }, recent.filter { it != a }.map { it to label(it) })
    }

    private fun label(pkg: String) = runCatching {
        packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
    }.getOrDefault(pkg)

    private fun keyboards() = getSystemService(InputMethodManager::class.java).enabledInputMethodList.map { it.packageName }

    private fun isHome(pkg: String) = packageManager.resolveActivity(
        Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), 0)?.activityInfo?.packageName == pkg

    /** Brings a recent app to the front; input sent before it arrives is dropped, never replayed. */
    fun switchTo(pkg: String) {
        if (!PhoneShare.sharing) return
        val i = packageManager.getLaunchIntentForPackage(pkg) ?: return
        switchingTo = pkg
        switchUntil = SystemClock.uptimeMillis() + SWITCH_MS
        startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun input(m: JsonObject) {
        if (!PhoneShare.sharing) return
        if (switchingTo != null && SystemClock.uptimeMillis() < switchUntil) return
        switchingTo = null
        fun d(k: String) = (m[k] as? JsonPrimitive)?.doubleOrNull
        fun s(k: String) = (m[k] as? JsonPrimitive)?.content
        val (w, h) = PhoneShare.screenSize(this)
        fun at(fx: Double?, fy: Double?) = fx?.let { x -> fy?.let { y ->
            (x.coerceIn(0.0, 1.0) * (w - 1)).toFloat() to (y.coerceIn(0.0, 1.0) * (h - 1)).toFloat()
        } }
        when (s("kind")) {
            "tap" -> at(d("fx"), d("fy"))?.let { gesture(it, it, 50) }
            "press" -> at(d("fx"), d("fy"))?.let { gesture(it, it, 650) }
            "swipe" -> at(d("fx"), d("fy"))?.let { from ->
                at(d("tx"), d("ty"))?.let { to -> gesture(from, to, (d("ms") ?: 300.0).toLong().coerceIn(50, 3000)) }
            }
            "key" -> when (s("key")) {
                "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
                "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
                "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
                "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
                "enter" -> focused()?.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
                "backspace" -> edit { t, a, b -> if (a == b) (if (a == 0) null else t.removeRange(t.offsetByCodePoints(a, -1), a) to t.offsetByCodePoints(a, -1)) else t.removeRange(a, b) to a }
            }
            "text" -> s("text")?.takeIf { it.isNotEmpty() }?.let { add -> edit { t, a, b -> t.replaceRange(a, b, add) to a + add.length } }
        }
    }

    private fun gesture(from: Pair<Float, Float>, to: Pair<Float, Float>, ms: Long) {
        val path = Path().apply { moveTo(from.first, from.second); lineTo(to.first, to.second) }
        dispatchGesture(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, ms)).build(), null, null)
    }

    private fun focused() = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)

    /** Rewrites the focused field: [change] gets its text and selection, returns the new text and cursor. */
    private fun edit(change: (String, Int, Int) -> Pair<String, Int>?) {
        val n = focused() ?: return
        // A cached node keeps the text it had before our last set; fields like Chrome's omnibox read empty without this.
        n.refresh()
        val text = if (n.isShowingHintText) "" else n.text?.toString() ?: ""
        var a = n.textSelectionStart
        var b = n.textSelectionEnd
        if (a < 0 || b < 0 || a > text.length || b > text.length) { a = text.length; b = a }
        val (next, cursor) = change(text, minOf(a, b), maxOf(a, b)) ?: return
        n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, next)
        })
        n.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
        })
    }

    companion object {
        @Volatile var instance: ControlService? = null
            private set
        private const val SWITCH_MS = 2000L
        private const val SETTLE_MS = 250L
    }
}
