package com.yasha.pocketdesk.ui

import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.yasha.pocketdesk.RhEvent
import com.yasha.pocketdesk.WsClient

class TermBridge(
    private val onInput: (String) -> Unit,
    private val onResize: (Int, Int) -> Unit,
) {
    @JavascriptInterface
    fun input(dataB64: String) = onInput(dataB64)

    @JavascriptInterface
    fun resize(cols: Int, rows: Int) = onResize(cols, rows)
}

private val EXTRA_KEYS = listOf(
    "Esc" to "\u001b",
    "Tab" to "\t",
    "^C" to "\u0003",
    "^D" to "\u0004",
    "^Z" to "\u001a",
    "↑" to "\u001b[A",
    "↓" to "\u001b[B",
    "←" to "\u001b[D",
    "→" to "\u001b[C",
    "Home" to "\u001b[H",
    "End" to "\u001b[F",
    "PgUp" to "\u001b[5~",
    "PgDn" to "\u001b[6~",
    "/" to "/",
    "-" to "-",
    "_" to "_",
    "|" to "|",
)

private fun b64(text: String): String =
    android.util.Base64.encodeToString(text.toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun TerminalScreen(ws: WsClient, sessionId: String, onClose: () -> Unit) {
    val holder = remember { arrayOfNulls<WebView>(1) }
    val pending = remember { mutableListOf<String>() }
    var ended by remember { mutableStateOf<Int?>(null) }

    DisposableEffect(ws, sessionId) {
        val sink: (String, String) -> Unit = { id, b64 ->
            if (id == sessionId) {
                val wv = holder[0]
                if (wv == null) {
                    synchronized(pending) { pending += b64 }
                } else {
                    wv.post { wv.evaluateJavascript("window.termOut('$b64')", null) }
                }
            }
        }
        ws.onTerminalData = sink
        ws.attach(sessionId)
        onDispose {
            if (ws.onTerminalData === sink) ws.onTerminalData = null
            ws.detach(sessionId)
        }
    }

    LaunchedEffect(ws, sessionId) {
        ws.events.collect { ev ->
            if (ev is RhEvent.Exit && ev.id == sessionId) ended = ev.code
        }
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onClose) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Leave terminal")
            }
            Text(
                sessionId,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            IconButton(onClick = { ws.kill(sessionId) }, enabled = ended == null) {
                Icon(Icons.Filled.Close, contentDescription = "Kill session")
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                items(EXTRA_KEYS, key = { it.first }) { (label, seq) ->
                    TextButton(
                        onClick = { ws.sendInput(sessionId, b64(seq)) },
                        enabled = ended == null,
                        contentPadding = PaddingValues(horizontal = 8.dp),
                    ) { Text(label) }
                }
            }
        }
        Box(Modifier.weight(1f)) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    if (ctx.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
                        WebView.setWebContentsDebuggingEnabled(true)
                    }
                    WebView(ctx).apply {
                        // Without explicit params the page's layout viewport is 0px tall and xterm fits one row.
                        layoutParams = android.view.ViewGroup.LayoutParams(
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                        settings.javaScriptEnabled = true
                        addJavascriptInterface(
                            TermBridge(
                                onInput = { b64 -> ws.sendInput(sessionId, b64) },
                                onResize = { c, r -> ws.sendResize(sessionId, c, r) },
                            ),
                            "Android",
                        )
                        webViewClient = object : WebViewClient() {
                            override fun onPageFinished(view: WebView, url: String) {
                                holder[0] = view
                                val flush: List<String>
                                synchronized(pending) {
                                    flush = pending.toList()
                                    pending.clear()
                                }
                                for (b64 in flush) {
                                    view.evaluateJavascript("window.termOut('$b64')", null)
                                }
                            }
                        }
                        loadUrl("file:///android_asset/terminal.html")
                    }
                },
                onRelease = { it.destroy() },
            )
            ended?.let { code ->
                Column(
                    Modifier.align(Alignment.Center),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("Session ended (exit $code)", style = MaterialTheme.typography.titleMedium)
                }
            }
        }
    }
}
