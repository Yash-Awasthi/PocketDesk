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
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.view.Display
import android.view.Surface
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
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
import kotlinx.serialization.json.intOrNull
import java.io.OutputStream
import java.util.concurrent.TimeUnit

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
        // Whole screen only: a single-app share would leave the recent-app panes blank.
        val mpm = getSystemService(MediaProjectionManager::class.java)
        consent.launch(if (Build.VERSION.SDK_INT >= 34) mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
            else mpm.createScreenCaptureIntent())
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
    private var encoder: Encoder? = null
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
        val data = intent?.getParcelableExtra(EXTRA_DATA, Intent::class.java)
        val p = data?.let { getSystemService(MediaProjectionManager::class.java).getMediaProjection(intent.getIntExtra(EXTRA_CODE, 0), it) }
        if (p == null) { stopSelf(); return START_NOT_STICKY }
        projection = p
        p.registerCallback(object : MediaProjection.Callback() {
            // The owner stopped it from the status bar chip or the lock screen.
            override fun onStop() { stopSelf() }
        }, main)
        size = captureSize()
        val enc = Encoder(size, 0, BITRATE).also { encoder = it }
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
            val enc = Encoder(next, 0, BITRATE).also { encoder = it }
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

/** One H.264 stream fed through [surface]; packets go out as [slot * 4 + kind, ...annexB], kind 0 config, 1 key, 2 delta. */
class Encoder(size: Pair<Int, Int>, private val slot: Int, bitrate: Int) {
    @Volatile private var config: ByteArray? = null
    @Volatile private var dropping = false
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
                    if (bytes.isNotEmpty()) emit(kind, bytes)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                }
            } catch (_: IllegalStateException) {
                // Codec released under us during a rebuild or stop.
            }
        }, "share-encoder-$slot").also { it.start() }
    }

    private fun emit(kind: Int, data: ByteArray) {
        if (kind == 1) dropping = false
        if (kind == 2 && dropping) return
        // A link slower than the stream: skip to the next keyframe instead of queueing seconds of video.
        if (kind != 0 && Link.client.uploadBacklog() > MAX_BACKLOG) { dropping = true; keyframe(); return }
        send(kind, data)
    }

    private fun send(kind: Int, data: ByteArray) = Link.client.sendPhoneVideo(byteArrayOf((slot * 4 + kind).toByte()) + data)

    fun keyframe() {
        config?.let { send(0, it) }
        runCatching { codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }) }
    }

    fun stop() {
        drain.interrupt()
        drain.join(500)
        runCatching { codec.stop() }
        runCatching { codec.release() }
        surface.release()
    }

    companion object {
        private const val MAX_BACKLOG = 1_500_000L
    }
}

/** A long-lived root shell on a phone rooted with su; commands go in one per line. */
object Root {
    private var shell: Process? = null
    private var ok: Boolean? = null

    /** Whether su gives root; asked once per run, since su may put a prompt in front of the owner. */
    @Synchronized fun available(): Boolean = ok ?: runCatching {
        val p = ProcessBuilder("su", "-c", "id").redirectErrorStream(true).start()
        p.waitFor(30, TimeUnit.SECONDS) && p.inputStream.bufferedReader().readText().contains("uid=0")
    }.getOrDefault(false).also { ok = it }

    /** Runs [cmd] as root and waits for it to finish. */
    fun exec(cmd: String) = runCatching { ProcessBuilder("su", "-c", cmd).redirectErrorStream(true).start().waitFor(10, TimeUnit.SECONDS) }

    @Synchronized fun run(cmd: String) {
        val p = shell?.takeIf { it.isAlive } ?: runCatching { ProcessBuilder("su").redirectErrorStream(true).start() }.getOrNull()?.also { p ->
            shell = p
            Thread { runCatching { p.inputStream.copyTo(OutputStream.nullOutputStream()) } }.start()
        } ?: return
        runCatching { p.outputStream.write((cmd + "\n").toByteArray()); p.outputStream.flush() }
    }
}

/**
 * Rooted phones only: up to [MAX] recent apps each run on a virtual display of their own, encoded
 * like the screen, so every pane on the PC stays live and takes input without switching apps.
 */
class RootPanes(private val ctx: Context, screen: Pair<Int, Int>) {
    private class Pane(val slot: Int, val pkg: String, val display: VirtualDisplay, val enc: Encoder)
    private val panes = HashMap<Int, Pane>()
    // Half the shared size at a density scaled to match: apps lay out as on the phone for a quarter of the pixels.
    private val size = screen.first / 2 / 8 * 8 to screen.second / 2 / 8 * 8
    private val dpi = ctx.resources.displayMetrics.densityDpi * size.first / PhoneShare.screenSize(ctx).first

    private var front: String? = null

    /** am start arguments that bring [pkg]'s existing task forward the way its launcher icon does. */
    private fun launch(pkg: String) = ctx.packageManager.getLaunchIntentForPackage(pkg)?.component?.flattenToShortString()
        ?.let { "-a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f 0x10200000 -n $it" }

    /** Brings the app on the phone's screen forward again, which also hands the focus back to that screen. */
    private fun frontAgain() = front?.let(::launch)?.let { "am start --display 0 $it" }

    /** Puts [apps] (most recent first, [front] being the app on the phone's screen) on panes; returns each one's slot. */
    @Synchronized fun show(front: String?, apps: List<String>): Map<String, Int> {
        this.front = front
        val want = apps.filter { launch(it) != null }.take(MAX)
        val gone = panes.values.filter { it.pkg !in want }
        gone.forEach { panes.remove(it.slot) }
        release(gone)
        // A pane's launch takes the focus to its display, where the owner's next app would open unseen.
        val added = want.filter { pkg -> panes.values.none { it.pkg == pkg } }
        for (pkg in added) {
            val slot = (1..MAX).first { it !in panes }
            val enc = Encoder(size, slot, BITRATE)
            val d = ctx.getSystemService(DisplayManager::class.java).createVirtualDisplay("PocketDesk pane $slot",
                size.first, size.second, dpi, enc.surface, DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY)
            panes[slot] = Pane(slot, pkg, d, enc)
            Root.run("am start --display ${d.display.displayId} ${launch(pkg)}")
        }
        if (added.isNotEmpty()) frontAgain()?.let(Root::run)
        return panes.values.associate { it.pkg to it.slot }
    }

    // A private display finishes the activities left on it, so its apps go back to the phone's screen first;
    // a moved task lands in front, so the app that was there is brought back over them.
    private fun release(gone: List<Pane>) {
        if (gone.isEmpty()) return
        val back = frontAgain()
        val moves = gone.joinToString("; ") { p ->
            "for t in $(am stack list | sed -n 's/^RootTask id=\\([0-9]*\\) .* displayId=${p.display.display.displayId} .*/\\1/p'); do am display move-stack \$t 0; done"
        }
        Thread {
            Root.exec(listOfNotNull(moves, back).joinToString("; "))
            gone.forEach { it.display.release(); it.enc.stop() }
        }.start()
    }

    fun keyframe() = synchronized(this) { panes.values.forEach { it.enc.keyframe() } }

    @Synchronized fun close() {
        release(panes.values.toList())
        panes.clear()
    }

    /** The PC's input for one pane, injected into that pane's display. */
    fun input(slot: Int, m: JsonObject) {
        val id = synchronized(this) { panes[slot] }?.display?.display?.displayId ?: return
        fun d(k: String) = (m[k] as? JsonPrimitive)?.doubleOrNull
        fun px(f: Double?, side: Int) = ((f ?: 0.5).coerceIn(0.0, 1.0) * (side - 1)).toInt()
        val x = px(d("fx"), size.first)
        val y = px(d("fy"), size.second)
        val cmd = when ((m["kind"] as? JsonPrimitive)?.content) {
            "tap" -> "tap $x $y"
            "press" -> "swipe $x $y $x $y 650"
            "swipe" -> "swipe $x $y ${px(d("tx"), size.first)} ${px(d("ty"), size.second)} ${(d("ms") ?: 300.0).toLong().coerceIn(50, 3000)}"
            "key" -> KEYS[(m["key"] as? JsonPrimitive)?.content]?.let { "keyevent $it" }
            // ponytail: `input text` types ASCII only; an IME bridge would be needed for the rest.
            "text" -> (m["text"] as? JsonPrimitive)?.content?.takeIf { it.isNotEmpty() }
                ?.let { "text '" + it.replace(" ", "%s").replace("'", "'\\''") + "'" }
            else -> null
        } ?: return
        Root.run("input -d $id $cmd")
    }

    companion object {
        const val MAX = 3
        private const val BITRATE = 2_000_000
        private val KEYS = mapOf("back" to 4, "home" to 3, "recents" to 187, "enter" to 66, "backspace" to 67)
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
    private val settle = Runnable { foreground(mainRoot()?.packageName?.toString()) }

    /** The app window in front on the phone's own screen; an app starting on a pane's display takes the focus there. */
    private fun mainRoot(): AccessibilityNodeInfo? = if (PhoneShare.service?.panes == null) rootInActiveWindow
        else windowsOnAllDisplays[Display.DEFAULT_DISPLAY]?.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }?.root

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
        val others = recent.filter { it != a }
        val slots = PhoneShare.service?.panes?.show(a, others).orEmpty()
        Link.client.phoneApps(a?.let { it to label(it) }, others.map { Triple(it, label(it), slots[it]) })
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
        (m["slot"] as? JsonPrimitive)?.intOrNull?.takeIf { it > 0 }?.let { PhoneShare.service?.panes?.input(it, m); return }
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
                "enter" -> { written = null; focused()?.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id) }
                "backspace" -> edit { t, a, b -> if (a == b) (if (a == 0) null else t.removeRange(t.offsetByCodePoints(a, -1), a) to t.offsetByCodePoints(a, -1)) else t.removeRange(a, b) to a }
            }
            "text" -> s("text")?.takeIf { it.isNotEmpty() }?.let { add -> edit { t, a, b -> t.replaceRange(a, b, add) to a + add.length } }
        }
    }

    private fun gesture(from: Pair<Float, Float>, to: Pair<Float, Float>, ms: Long) {
        val path = Path().apply { moveTo(from.first, from.second); lineTo(to.first, to.second) }
        dispatchGesture(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, ms)).build(), null, null)
    }

    private fun focused() = mainRoot()?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)

    /** Rewrites the focused field: [change] gets its text and selection, returns the new text and cursor. */
    private fun edit(change: (String, Int, Int) -> Pair<String, Int>?) {
        val n = focused() ?: return
        // A cached node keeps the text it had before our last set; fields like Chrome's omnibox read empty without this.
        n.refresh()
        var text = if (n.isShowingHintText) "" else n.text?.toString() ?: ""
        var a = n.textSelectionStart
        var b = n.textSelectionEnd
        // Fast typing outruns the field: until it shows our last write, build on that write instead.
        written?.takeIf { it.first == n && SystemClock.uptimeMillis() - writtenAt < WRITE_LAG_MS && it.second != text }
            ?.let { text = it.second; a = it.third; b = a }
        if (a < 0 || b < 0 || a > text.length || b > text.length) { a = text.length; b = a }
        val (next, cursor) = change(text, minOf(a, b), maxOf(a, b)) ?: return
        n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, next)
        })
        n.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
        })
        written = Triple(n, next, cursor)
        writtenAt = SystemClock.uptimeMillis()
    }
    private var written: Triple<AccessibilityNodeInfo, String, Int>? = null
    private var writtenAt = 0L

    companion object {
        @Volatile var instance: ControlService? = null
            private set
        private const val SWITCH_MS = 2000L
        private const val SETTLE_MS = 250L
        // ponytail: fixed window; an app that rewrites the field within it loses that rewrite to ours.
        private const val WRITE_LAG_MS = 1000L
    }
}
