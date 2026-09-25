package com.yasha.pocketdesk.ui

import android.app.Activity
import android.content.pm.ActivityInfo
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.view.Surface
import android.view.TextureView
import android.widget.Toast
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.yasha.pocketdesk.DesktopFrame
import com.yasha.pocketdesk.WsClient

/**
 * Remote desktop from the phone. Touchpad mode (default): one finger moves the
 * PC cursor relatively and a tap left-clicks at it; direct mode clicks where you
 * tap. Two fingers pinch-zoom and pan in both modes. The L/R buttons click at the
 * cursor, Drag holds the left button, Apps launches anything installed on the PC.
 */
@Composable
fun DesktopScreen(ws: WsClient, onClose: () -> Unit, fullscreen: Boolean, onFullscreen: (Boolean) -> Unit) {
    val desktopError by ws._desktopError.collectAsState()
    var touchpad by remember { mutableStateOf(true) }
    var dragLock by remember { mutableStateOf(false) }
    var showKeys by remember { mutableStateOf(false) }
    var showApps by remember { mutableStateOf(false) }
    var cursor by remember { mutableStateOf<Offset?>(null) }
    var zoom by remember { mutableFloatStateOf(1f) }
    var pan by remember { mutableStateOf(Offset.Zero) }

    var videoSize by remember { mutableStateOf<IntSize?>(null) }
    var boxSize by remember { mutableStateOf(IntSize.Zero) }
    // The stream only runs while the app is visible; ON_START also fires on first attach.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_START) ws.desktopStartVideo()
            if (e == Lifecycle.Event.ON_STOP) ws.desktopStop()
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs); ws.desktopStop() }
    }
    BackHandler(enabled = fullscreen) { onFullscreen(false) }

    val video = ws.desktopMode == "h264"
    val frame = ws.desktopFrame
    val bitmap = remember(frame, video) {
        if (video) null
        else frame?.let { f -> Base64.decode(f.base64, Base64.NO_WRAP).let { BitmapFactory.decodeByteArray(it, 0, it.size) } }
    }
    val dims = if (video) videoSize else frame?.let { IntSize(it.width, it.height) }
    var rate by remember { mutableStateOf("") }
    LaunchedEffect(video) {
        var b = ws.videoBytes
        var f = ws.videoFrames
        while (video) {
            kotlinx.coroutines.delay(1000)
            rate = "%d fps · %.2f Mbit/s".format(ws.videoFrames - f, (ws.videoBytes - b) * 8 / 1e6)
            b = ws.videoBytes
            f = ws.videoFrames
        }
    }
    LaunchedEffect(dims) {
        if (cursor == null && dims != null) cursor = Offset(dims.width / 2f, dims.height / 2f)
    }
    val here = { cursor?.let { Pair(it.x.toInt(), it.y.toInt()) } }

    Column(Modifier.fillMaxSize().background(Color(0xFF0D1117))) {
        if (!fullscreen) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                Text(
                    "Desktop" + (if (ws.desktopStreaming) " · live" + (if (video) " · $rate" else "") else ""),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                if (video) TextButton(onClick = {
                    ws.desktopPreset = PRESETS[(PRESETS.indexOf(ws.desktopPreset) + 1) % PRESETS.size]
                    ws.desktopStartVideo()
                }) { Text(ws.desktopPreset.replaceFirstChar { it.uppercase() }) }
                TextButton(onClick = { touchpad = !touchpad }) { Text(if (touchpad) "Touchpad" else "Direct tap") }
            }
        }
        if (desktopError.isNotEmpty()) {
            Text(desktopError, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 12.dp))
        }

        Box(Modifier.fillMaxWidth().weight(1f).onSizeChanged { boxSize = it }) {
            if (video) {
                AndroidView(
                    factory = { ctx -> videoView(ctx, ws) { videoSize = it } },
                    update = { tv ->
                        val d = videoSize
                        if (d != null && boxSize.width > 0) {
                            val v = Viewport(d, boxSize.width.toFloat(), boxSize.height.toFloat(), zoom, pan)
                            tv.setTransform(Matrix().apply {
                                setScale(d.width * v.scale / boxSize.width, d.height * v.scale / boxSize.height)
                                postTranslate(v.left, v.top)
                            })
                        }
                    },
                    modifier = Modifier.fillMaxSize(),
                )
            }
            Canvas(
                Modifier
                    .fillMaxSize()
                    .pointerInput(dims, touchpad) {
                        val f = dims ?: return@pointerInput
                        awaitEachGesture {
                            val down = awaitFirstDown(requireUnconsumed = false)
                            val v = Viewport(f, size.width.toFloat(), size.height.toFloat(), zoom, pan)
                            if (!touchpad) v.toFrame(down.position)?.let { cursor = it }
                            var moved = 0f
                            var multi = false
                            var lastSent = 0L
                            val start = down.uptimeMillis
                            var end = start
                            while (true) {
                                val ev = awaitPointerEvent()
                                val pressed = ev.changes.filter { it.pressed }
                                if (pressed.isEmpty()) { end = ev.changes.first().uptimeMillis; break }
                                if (pressed.size >= 2) {
                                    multi = true
                                    zoom = (zoom * ev.calculateZoom()).coerceIn(1f, 6f)
                                    pan = Viewport(f, size.width.toFloat(), size.height.toFloat(), zoom, pan + ev.calculatePan()).clampedPan()
                                } else if (!multi) {
                                    val ch = pressed.first()
                                    val delta = ch.positionChange()
                                    moved += delta.getDistance()
                                    val vp = Viewport(f, size.width.toFloat(), size.height.toFloat(), zoom, pan)
                                    val next = if (touchpad) vp.clampFrame((cursor ?: Offset.Zero) + delta / vp.scale)
                                    else vp.toFrame(ch.position)
                                    if (next != null && moved > 8f) {
                                        cursor = next
                                        if (touchpad) pan = vp.follow(next)
                                        if (ch.uptimeMillis - lastSent >= 40) {
                                            lastSent = ch.uptimeMillis
                                            ws.desktopMove(next.x.toInt(), next.y.toInt())
                                        }
                                    }
                                }
                                ev.changes.forEach { it.consume() }
                            }
                            if (multi) return@awaitEachGesture
                            val c = cursor ?: return@awaitEachGesture
                            when {
                                moved > 8f -> ws.desktopMove(c.x.toInt(), c.y.toInt())
                                end - start >= 500 -> ws.desktopClick(c.x.toInt(), c.y.toInt(), "right")
                                else -> ws.desktopClick(c.x.toInt(), c.y.toInt(), "left")
                            }
                        }
                    },
            ) {
                val f = dims ?: return@Canvas
                val v = Viewport(f, size.width, size.height, zoom, pan)
                bitmap?.let { bmp ->
                    drawIntoCanvas { c ->
                        c.nativeCanvas.drawBitmap(bmp, null,
                            android.graphics.RectF(v.left, v.top, v.left + f.width * v.scale, v.top + f.height * v.scale), null)
                    }
                }
                cursor?.let { cur ->
                    val p = Offset(v.left + cur.x * v.scale, v.top + cur.y * v.scale)
                    drawCircle(Color.White, radius = 11f, center = p, style = Stroke(width = 4f))
                    drawCircle(Color(0xFFE53935), radius = 5f, center = p)
                }
            }
            if (fullscreen) {
                TextButton(onClick = { onFullscreen(false) }, modifier = Modifier.align(Alignment.TopEnd)) { Text("Exit ⛶") }
            }
        }

        // Mouse bar: always visible, in fullscreen too.
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            val pad = PaddingValues(horizontal = 4.dp)
            FilledTonalButton(onClick = { here()?.let { ws.desktopClick(it.first, it.second, "left") } },
                modifier = Modifier.weight(2f), contentPadding = pad) { Text("L") }
            FilledTonalButton(onClick = { here()?.let { ws.desktopClick(it.first, it.second, "right") } },
                modifier = Modifier.weight(2f), contentPadding = pad) { Text("R") }
            val dragButton: @Composable (Modifier) -> Unit = { m ->
                val toggle = {
                    here()?.let { ws.desktopPress(it.first, it.second, !dragLock) }
                    dragLock = !dragLock
                }
                if (dragLock) FilledTonalButton(onClick = toggle, modifier = m, contentPadding = pad) { Text("Drop") }
                else OutlinedButton(onClick = toggle, modifier = m, contentPadding = pad) { Text("Drag") }
            }
            dragButton(Modifier.weight(2f))
            OutlinedButton(onClick = { ws.desktopScroll(false) }, modifier = Modifier.weight(1f), contentPadding = pad) { Text("▲") }
            OutlinedButton(onClick = { ws.desktopScroll(true) }, modifier = Modifier.weight(1f), contentPadding = pad) { Text("▼") }
            OutlinedButton(onClick = { showKeys = !showKeys }, modifier = Modifier.weight(1f), contentPadding = pad) { Text("⌨") }
            OutlinedButton(onClick = { showApps = true }, modifier = Modifier.weight(1f), contentPadding = pad) { Text("▦") }
            OutlinedButton(onClick = { onFullscreen(!fullscreen) }, modifier = Modifier.weight(1f), contentPadding = pad) { Text("⛶") }
        }
        if (showKeys) KeyPanel(ws)
    }

    if (showApps) AppLauncher(ws, onDismiss = { showApps = false })
}

/** TextureView fed by a hardware decoder; each new surface asks the daemon for a fresh keyframe. */
private fun videoView(ctx: android.content.Context, ws: WsClient, onSize: (IntSize) -> Unit) = TextureView(ctx).apply {
    surfaceTextureListener = object : TextureView.SurfaceTextureListener {
        var player: H264Player? = null
        var surface: Surface? = null
        override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) {
            val s = Surface(st).also { surface = it }
            val p = H264Player(s, onSize = { vw, vh -> onSize(IntSize(vw, vh)) }, onLost = { ws.desktopStartVideo() })
            player = p
            ws.videoSink = p::feed
            ws.desktopStartVideo()
        }
        override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
            ws.videoSink = null
            player?.release()
            surface?.release()
            return true
        }
        override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {}
        override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
    }
}

/** Letterboxed, zoomable placement of the frame inside the view. */
private class Viewport(val f: IntSize, val viewW: Float, val viewH: Float, val zoom: Float, val pan: Offset) {
    val scale = minOf(viewW / f.width, viewH / f.height) * zoom
    val left = (viewW - f.width * scale) / 2f + pan.x
    val top = (viewH - f.height * scale) / 2f + pan.y

    fun toFrame(p: Offset): Offset? {
        val fx = (p.x - left) / scale
        val fy = (p.y - top) / scale
        return if (fx < 0 || fy < 0 || fx > f.width || fy > f.height) null else Offset(fx, fy)
    }

    fun clampFrame(p: Offset) = Offset(p.x.coerceIn(0f, f.width - 1f), p.y.coerceIn(0f, f.height - 1f))

    /** Keeps the image covering the view once zoomed past it. */
    fun clampedPan(): Offset {
        val maxX = maxOf(0f, (f.width * scale - viewW) / 2f)
        val maxY = maxOf(0f, (f.height * scale - viewH) / 2f)
        return Offset(pan.x.coerceIn(-maxX, maxX), pan.y.coerceIn(-maxY, maxY))
    }

    /** Pans just enough to keep the cursor on screen while zoomed. */
    fun follow(cur: Offset): Offset {
        val margin = 48f
        val px = left + cur.x * scale
        val py = top + cur.y * scale
        var dx = 0f
        var dy = 0f
        if (px < margin) dx = margin - px else if (px > viewW - margin) dx = viewW - margin - px
        if (py < margin) dy = margin - py else if (py > viewH - margin) dy = viewH - margin - py
        return Viewport(f, viewW, viewH, zoom, pan + Offset(dx, dy)).clampedPan()
    }
}

/**
 * Landscape without system bars while the desktop is fullscreen. Deliberately no
 * undo on dispose: rotating recreates the activity, and an undo there flips it back.
 */
@Composable
fun DesktopFullscreenEffect(fullscreen: Boolean) {
    val view = LocalView.current
    val activity = LocalContext.current as? Activity ?: return
    LaunchedEffect(fullscreen) {
        val controller = WindowCompat.getInsetsController(activity.window, view)
        if (fullscreen) {
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }
}

private val PRESETS = listOf("saver", "balanced", "quality")
private val FN_KEYS = listOf(
    "esc" to 27, "⇥" to 9, "⌫" to 8, "del" to 46, "⏎" to 13, "←" to 37, "↑" to 38, "↓" to 40, "→" to 39,
    "home" to 36, "end" to 35, "pgup" to 33, "pgdn" to 34, "⊞" to 91, "prtsc" to 44,
) + (1..12).map { "F$it" to 111 + it }
private val OEM_VK = mapOf(
    '-' to 0xBD, '=' to 0xBB, '[' to 0xDB, ']' to 0xDD, '\\' to 0xDC, ';' to 0xBA,
    '\'' to 0xDE, ',' to 0xBC, '.' to 0xBE, '/' to 0xBF, '`' to 0xC0,
)
private val ROWS = listOf("`1234567890-=", "qwertyuiop[]\\", "asdfghjkl;'", "zxcvbnm,./")

/**
 * Own keyboard, US layout, every key sent as a virtual key. Ctrl/Shift/Alt/Win latch
 * on tap and release after the next key, so ctrl then c sends ctrl+c.
 */
@Composable
private fun KeyPanel(ws: WsClient) {
    var text by remember { mutableStateOf("") }
    var mods by remember { mutableStateOf(emptySet<String>()) }
    val press = { vk: Int -> ws.desktopKey(vk, mods.toList()); mods = emptySet() }
    val shift = "shift" in mods
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    LaunchedEffect(Unit) {
        ws.pcClipboard.collect {
            clipboard.setText(AnnotatedString(it))
            Toast.makeText(context, "Copied from PC", Toast.LENGTH_SHORT).show()
        }
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 2.dp)) {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            Key("paste → PC", Modifier) { clipboard.getText()?.text?.let { ws.clipboardSet(it, paste = true) } }
            Key("copy ← PC", Modifier) { ws.clipboardGet() }
            FN_KEYS.forEach { (label, vk) -> Key(label, Modifier) { press(vk) } }
        }
        ROWS.forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                row.forEach { ch ->
                    val vk = OEM_VK[ch] ?: ch.uppercaseChar().code
                    Key(if (shift) ch.uppercase() else ch.toString(), Modifier.weight(1f)) { press(vk) }
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            listOf("ctrl" to "Ctrl", "shift" to "Shift", "alt" to "Alt", "win" to "Win").forEach { (m, label) ->
                Key(label, Modifier.weight(1.3f), active = m in mods) { mods = if (m in mods) mods - m else mods + m }
            }
            Key("space", Modifier.weight(3f)) { press(32) }
        }
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Type to PC…") },
                singleLine = true,
            )
            TextButton(onClick = { if (text.isNotEmpty()) { ws.desktopType(text); text = "" } }) { Text("Send") }
        }
    }
}

@Composable
private fun Key(label: String, modifier: Modifier, active: Boolean = false, onClick: () -> Unit) {
    val shape = RoundedCornerShape(6.dp)
    Box(
        modifier.padding(vertical = 2.dp).heightIn(min = 40.dp).clip(shape)
            .background(if (active) MaterialTheme.colorScheme.primary else Color(0xFF21262D))
            .border(1.dp, Color(0xFF30363D), shape)
            .clickable(onClick = onClick).padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, maxLines = 1, style = MaterialTheme.typography.bodyMedium,
            color = if (active) MaterialTheme.colorScheme.onPrimary else Color(0xFFE6EDF3))
    }
}

/** Launches any installed PC app (Start Menu, /Applications, .desktop) in the desktop view. */
@Composable
private fun AppLauncher(ws: WsClient, onDismiss: () -> Unit) {
    var q by remember { mutableStateOf("") }
    LaunchedEffect(q) { ws.discoverApps(q) }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
        title = { Text("Open on PC") },
        text = {
            Column {
                OutlinedTextField(value = q, onValueChange = { q = it }, singleLine = true,
                    placeholder = { Text("Search apps…") }, modifier = Modifier.fillMaxWidth())
                LazyColumn(Modifier.heightIn(max = 360.dp)) {
                    items(ws.apps.filter { it.isGui }) { app ->
                        Text(app.name, modifier = Modifier.fillMaxWidth()
                            .clickable { ws.guiOpenPath(app.path); onDismiss() }
                            .padding(vertical = 12.dp))
                    }
                }
            }
        },
    )
}
