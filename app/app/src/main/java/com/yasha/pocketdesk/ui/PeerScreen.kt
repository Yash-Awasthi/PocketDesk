package com.yasha.pocketdesk.ui

import android.graphics.Bitmap
import android.graphics.SurfaceTexture
import android.view.Surface
import android.view.TextureView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.yasha.pocketdesk.ControlService
import com.yasha.pocketdesk.Peer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Phone to phone, with no PC: show this phone's QR, or scan another phone's and drive it. */
@Composable
fun PeerScreen(onClose: () -> Unit) {
    val ctx = LocalContext.current
    val close = {
        Peer.stopHost(ctx)
        Peer.disconnect()
        Peer.view = null
        onClose()
    }
    BackHandler { close() }
    when (Peer.view) {
        "host" -> HostPanel(close)
        "join" -> JoinPanel(close)
        else -> Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Phone to phone", style = MaterialTheme.typography.headlineSmall)
            Text("Both phones on the same Wi-Fi, no PC needed.", style = MaterialTheme.typography.bodyMedium)
            Button(onClick = { Peer.view = "host"; Peer.startHost(ctx) }, modifier = Modifier.fillMaxWidth()) { Text("Show my QR: let a phone control this one") }
            FilledTonalButton(onClick = { Peer.view = "join"; scan(ctx) }, modifier = Modifier.fillMaxWidth()) { Text("Scan a phone's QR: control it") }
            TextButton(onClick = close) { Text("Close") }
        }
    }
}

private fun scan(ctx: android.content.Context) {
    val opts = com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions.Builder()
        .setBarcodeFormats(com.google.mlkit.vision.barcode.common.Barcode.FORMAT_QR_CODE).build()
    com.google.mlkit.vision.codescanner.GmsBarcodeScanning.getClient(ctx, opts).startScan()
        .addOnSuccessListener { Peer.connect(it.rawValue ?: "") }
        .addOnFailureListener { Peer.status = "Scanner unavailable: ${it.message}" }
}

private fun qrBitmap(text: String): Bitmap {
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 640, 640)
    val px = IntArray(m.width * m.height) { if (m.get(it % m.width, it / m.width)) 0xFF000000.toInt() else 0xFFFFFFFF.toInt() }
    return Bitmap.createBitmap(px, m.width, m.height, Bitmap.Config.ARGB_8888)
}

@Composable
private fun HostPanel(close: () -> Unit) {
    val ctx = LocalContext.current
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally) {
        Text("Let a phone control this one", style = MaterialTheme.typography.titleLarge)
        Peer.qr?.let { q ->
            val bmp = remember(q) { qrBitmap(q) }
            Image(bmp.asImageBitmap(), contentDescription = "QR for the other phone", modifier = Modifier.size(280.dp))
        }
        Text(Peer.status, style = MaterialTheme.typography.bodyMedium)
        if (ControlService.instance == null) {
            Text("View only until \"PocketDesk PC control\" is on in Accessibility; then the other phone can tap and type here too.",
                style = MaterialTheme.typography.bodySmall)
            OutlinedButton(onClick = { ctx.startActivity(android.content.Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS)) }) {
                Text("Open Accessibility settings")
            }
        }
        Text("To stop at any time: the red Stop pill at the top of the screen, Stop in the notification, or Stop here. " +
            "The QR works only while this screen is open, and a new one is made each time.", style = MaterialTheme.typography.bodySmall)
        Button(onClick = close) { Text("Stop") }
    }
}

@Composable
private fun JoinPanel(close: () -> Unit) {
    val ctx = LocalContext.current
    val r = Peer.remote
    if (r == null) {
        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally) {
            Text(Peer.status.ifEmpty { "Scan the QR on the other phone" }, style = MaterialTheme.typography.bodyLarge)
            FilledTonalButton(onClick = { scan(ctx) }) { Text("Scan again") }
            TextButton(onClick = close) { Text("Close") }
        }
        return
    }
    val send = { o: kotlinx.serialization.json.JsonObject -> Peer.input(o) }
    fun key(k: String) = send(buildJsonObject { put("type", "phone_input"); put("kind", "key"); put("key", k) })
    var typed by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().background(Color.Black)) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            var view by remember { mutableStateOf(IntSize.Zero) }
            val ratio = if (r.first > 0 && r.second > 0) r.first.toFloat() / r.second else 9f / 19f
            val frac = { o: Offset -> (o.x / view.width).coerceIn(0f, 1f).toDouble() to (o.y / view.height).coerceIn(0f, 1f).toDouble() }
            var from by remember { mutableStateOf<Pair<Double, Double>?>(null) }
            var startAt by remember { mutableStateOf(0L) }
            var to by remember { mutableStateOf<Pair<Double, Double>?>(null) }
            AndroidView(
                factory = { c -> peerVideo(c) },
                modifier = Modifier.aspectRatio(ratio, matchHeightConstraintsFirst = ratio < 1f)
                    .onSizeChanged { view = it }
                    .pointerInput(r) {
                        detectTapGestures(
                            onTap = { val (x, y) = frac(it); send(buildJsonObject { put("type", "phone_input"); put("kind", "tap"); put("fx", x); put("fy", y) }) },
                            onLongPress = { val (x, y) = frac(it); send(buildJsonObject { put("type", "phone_input"); put("kind", "press"); put("fx", x); put("fy", y) }) },
                        )
                    }
                    .pointerInput(r) {
                        // A drag goes over as one swipe when the finger lifts: accessibility gestures are whole strokes.
                        detectDragGestures(
                            onDragStart = { from = frac(it); to = from; startAt = System.currentTimeMillis() },
                            onDrag = { change, _ -> to = frac(change.position) },
                            onDragEnd = {
                                val a = from; val b = to
                                if (a != null && b != null) send(buildJsonObject {
                                    put("type", "phone_input"); put("kind", "swipe"); put("fx", a.first); put("fy", a.second)
                                    put("tx", b.first); put("ty", b.second); put("ms", (System.currentTimeMillis() - startAt).coerceIn(80, 3000))
                                })
                                from = null
                            },
                        )
                    },
            )
        }
        if (!r.third) Text("View only: the other phone has not turned on PocketDesk control in Accessibility.",
            color = Color(0xFFE6EDF3), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(8.dp))
        Row(Modifier.fillMaxWidth().padding(6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(typed, { typed = it }, Modifier.weight(1f), singleLine = true, placeholder = { Text("Type there") })
            FilledTonalButton(onClick = {
                if (typed.isNotEmpty()) send(buildJsonObject { put("type", "phone_input"); put("kind", "text"); put("text", typed) }) else key("enter")
                typed = ""
            }) { Text(if (typed.isEmpty()) "⏎" else "Send") }
            FilledTonalButton(onClick = { key("backspace") }) { Text("⌫") }
        }
        Row(Modifier.fillMaxWidth().padding(6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FilledTonalButton(onClick = { key("back") }, Modifier.weight(1f)) { Text("Back") }
            FilledTonalButton(onClick = { key("home") }, Modifier.weight(1f)) { Text("Home") }
            FilledTonalButton(onClick = { key("recents") }, Modifier.weight(1f)) { Text("Recents") }
            FilledTonalButton(onClick = { key("notifications") }, Modifier.weight(1f)) { Text("Alerts") }
            OutlinedButton(onClick = close) { Text("✕") }
        }
    }
    DisposableEffect(Unit) { onDispose { Peer.videoSink = null } }
}

/** Hardware decode of the other phone's screen; a new surface asks it for a fresh keyframe. */
private fun peerVideo(ctx: android.content.Context) = TextureView(ctx).apply {
    surfaceTextureListener = object : TextureView.SurfaceTextureListener {
        var player: H264Player? = null
        var surface: Surface? = null
        override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) {
            val s = Surface(st).also { surface = it }
            val p = H264Player(s, onSize = { _, _ -> }, onLost = { Peer.requestKeyframe() })
            player = p
            Peer.videoSink = p::feed
            Peer.requestKeyframe()
        }
        override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
            Peer.videoSink = null
            player?.release()
            surface?.release()
            return true
        }
        override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {}
        override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
    }
}
