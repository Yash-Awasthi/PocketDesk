package com.yasha.pocketdesk.ui

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.yasha.pocketdesk.RhEvent
import com.yasha.pocketdesk.WsClient
import kotlin.math.abs
import kotlin.math.ceil
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive

class TermBridge(private val onInput: (String) -> Unit) {
    @JavascriptInterface
    fun input(dataB64: String) = onInput(dataB64)
}

/** The cell the terminal declares for a font size; the page draws one glyph per cell. */
data class CellMetrics(val fontPx: Int, val widthPx: Int, val heightPx: Int) {
    /** xterm's row is a multiple of the font size, so the declared cell height divides back out. */
    val lineHeight: Float get() = heightPx.toFloat() / fontPx

    fun cols(viewportPx: Int): Int = (viewportPx / widthPx).coerceAtLeast(1)

    fun rows(viewportPx: Int): Int = (viewportPx / heightPx).coerceAtLeast(1)
}

/**
 * The terminal's font size: three bounded steps, remembered between sessions, and never smaller
 * than [MIN_PX]. The cell is derived here and sent to the page, so the grid follows the font and
 * not only the glyphs.
 */
object TerminalFont {
    const val MIN_PX = 12
    const val DEFAULT_PX = 13
    const val PREF_KEY = "terminal_font_px"

    /** Three steps a thumb can cycle through; the first is the readable minimum's neighbourhood. */
    val STEPS = listOf(13, 17, 22)

    // A monospace glyph advances about 0.6 em and a terminal row is 1.2 em tall.
    private const val WIDTH_EM = 0.6
    private const val HEIGHT_EM = 1.2

    fun metrics(px: Int): CellMetrics {
        val size = nearestStep(px)
        return CellMetrics(size, ceil(size * WIDTH_EM).toInt(), ceil(size * HEIGHT_EM).toInt())
    }

    /** Snaps any stored value onto a real step, so a stale or tiny preference still opens readable. */
    fun nearestStep(px: Int): Int = STEPS.minBy { abs(it - px) }

    fun larger(px: Int): Int = STEPS.firstOrNull { it > nearestStep(px) } ?: STEPS.last()

    fun smaller(px: Int): Int = STEPS.lastOrNull { it < nearestStep(px) } ?: STEPS.first()

    fun load(prefs: SharedPreferences): Int = nearestStep(prefs.getInt(PREF_KEY, DEFAULT_PX))

    fun save(prefs: SharedPreferences, px: Int) {
        prefs.edit().putInt(PREF_KEY, nearestStep(px)).apply()
    }

    /** The page gets the size and the cell, because a font alone would leave the grid behind. */
    fun pageScript(px: Int): String {
        val m = metrics(px)
        return "window.termFont(${m.fontPx},${m.widthPx},${m.heightPx})"
    }
}

/**
 * Extra keys for one thumb: Ctrl and Alt arm the next character, the rest send their own bytes.
 * [ROW] is the order the user sees, most used first.
 */
enum class ExtraKey(val label: String) {
    CTRL("Ctrl"),
    ALT("Alt"),
    ESC("Esc"),
    TAB("Tab"),
    UP("\u2191"),
    DOWN("\u2193"),
    LEFT("\u2190"),
    RIGHT("\u2192"),
    ;

    val isModifier: Boolean get() = this == CTRL || this == ALT

    /** Bytes on the wire. Modifiers arm instead, so they send nothing on their own. */
    val bytes: String
        get() = when (this) {
            CTRL, ALT -> ""
            ESC -> "\u001b"
            TAB -> "\t"
            UP -> "\u001b[A"
            DOWN -> "\u001b[B"
            LEFT -> "\u001b[D"
            RIGHT -> "\u001b[C"
        }

    companion object {
        val ROW = listOf(CTRL, ALT, ESC, TAB, UP, DOWN, LEFT, RIGHT)
    }
}

/**
 * Ctrl and Alt stay armed for exactly one key and then fall back to plain typing. Typed characters
 * and the key row both go through [apply], so the wire sees the same control byte either way.
 */
class ModifierArmer {
    var ctrl by mutableStateOf(false)
        private set
    var alt by mutableStateOf(false)
        private set

    fun toggle(key: ExtraKey) {
        when (key) {
            ExtraKey.CTRL -> ctrl = !ctrl
            ExtraKey.ALT -> alt = !alt
            else -> Unit
        }
    }

    fun clear() {
        ctrl = false
        alt = false
    }

    /**
     * Applies the armed modifiers to the first character and disarms. Control keys and arrows pass
     * through untouched: Alt+arrow is not ESC ESC[ and xterm supplies its own encoding for those.
     */
    fun apply(text: String): String {
        if (text.isEmpty() || (!ctrl && !alt)) return text
        val wasCtrl = ctrl
        val wasAlt = alt
        val first = text[0]
        clear()
        if (first.code < 0x20 || first.code == 0x7f) return text
        return buildString {
            if (wasAlt) append('\u001b')
            append(if (wasCtrl) control(first) else first)
            append(text, 1, text.length)
        }
    }

    private fun control(c: Char): Char = when (c) {
        in 'a'..'z' -> (c - 'a' + 1).toChar()
        in 'A'..'Z' -> (c - 'A' + 1).toChar()
        '@', ' ' -> '\u0000'
        '[' -> '\u001b'
        '\\' -> '\u001c'
        ']' -> '\u001d'
        '^' -> '\u001e'
        '_' -> '\u001f'
        '?' -> '\u007f'
        else -> c
    }
}

/** Where a copy lands: the Android clipboard in the app, a recording fake in tests. */
fun interface ClipboardSink {
    fun copy(text: String)
}

/**
 * Copies the terminal's own selection and leaves it in place. The selection is only ever read, so
 * the confirmation cannot clear what the user selected while it shows.
 */
fun copySelection(selection: () -> String, clipboard: ClipboardSink, confirmed: () -> Unit): Boolean {
    val text = selection()
    if (text.isEmpty()) return false
    clipboard.copy(text)
    confirmed()
    return true
}

/** The bridge's chunk with Ctrl/Alt applied, so the socket carries the control byte. */
fun armedInput(dataB64: String, armer: ModifierArmer): String {
    val text = String(Base64.decode(dataB64, Base64.NO_WRAP), Charsets.UTF_8)
    return b64(armer.apply(text))
}

fun b64(text: String): String =
    Base64.encodeToString(text.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)

/** evaluateJavascript hands back a JSON value, and a selection can carry quotes and newlines. */
internal fun jsString(json: String?): String? {
    // evaluateJavascript answers "null" for nothing and an unquoted literal for a non-string; only
    // a quoted value is a selection.
    if (json == null || !json.startsWith("\"")) return null
    return runCatching { Json.parseToJsonElement(json).jsonPrimitive.content }.getOrNull()
}

/** Three bounded steps; the label is the declared size so the user sees what the cell does. */
@Composable
fun TerminalFontControl(
    fontPx: Int,
    enabled: Boolean,
    onSmaller: () -> Unit,
    onLarger: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        TextButton(
            onClick = onSmaller,
            enabled = enabled && fontPx > TerminalFont.STEPS.first(),
            modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).testTag("terminalFontSmaller"),
            contentPadding = PaddingValues(horizontal = 4.dp),
        ) { Text("A-") }
        Text(
            "${TerminalFont.metrics(fontPx).fontPx}px",
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.testTag("terminalFontLabel"),
        )
        TextButton(
            onClick = onLarger,
            enabled = enabled && fontPx < TerminalFont.STEPS.last(),
            modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).testTag("terminalFontLarger"),
            contentPadding = PaddingValues(horizontal = 4.dp),
        ) { Text("A+") }
    }
}

/**
 * The thumb row: every target is at least 48 dp, the armed modifier stays lit, and the row scrolls
 * sideways on a phone too narrow for all eight keys instead of shrinking them.
 */
@Composable
fun TerminalKeyRow(
    ctrl: Boolean,
    alt: Boolean,
    enabled: Boolean,
    onKey: (ExtraKey) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (key in ExtraKey.ROW) {
            val armed = (key == ExtraKey.CTRL && ctrl) || (key == ExtraKey.ALT && alt)
            TextButton(
                onClick = { onKey(key) },
                enabled = enabled,
                modifier = Modifier
                    .sizeIn(minWidth = 48.dp, minHeight = 48.dp)
                    .testTag("terminalKey.${key.label}"),
                contentPadding = PaddingValues(horizontal = 4.dp),
                colors = if (armed) {
                    ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.primary)
                } else {
                    ButtonDefaults.textButtonColors()
                },
            ) { Text(key.label) }
        }
    }
}

/**
 * Everything above the terminal: session, font size, copy and kill, then the extra key row. The
 * row is the last child, so it sits against the IME.
 */
@Composable
fun TerminalChrome(
    sessionId: String,
    fontPx: Int,
    ctrl: Boolean,
    alt: Boolean,
    enabled: Boolean,
    onFontSmaller: () -> Unit,
    onFontLarger: () -> Unit,
    onCopy: () -> Unit,
    onKey: (ExtraKey) -> Unit,
    onClose: () -> Unit,
    onKill: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onClose) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Leave terminal")
            }
            Text(
                sessionId,
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            TerminalFontControl(fontPx, enabled, onFontSmaller, onFontLarger)
            TextButton(
                onClick = onCopy,
                enabled = enabled,
                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).testTag("terminalCopy"),
            ) { Text("Copy") }
            IconButton(onClick = onKill, enabled = enabled) {
                Icon(Icons.Filled.Close, contentDescription = "Kill session")
            }
        }
        TerminalKeyRow(ctrl, alt, enabled, onKey)
    }
}

/**
 * The terminal's own drawing at [fontPx], for review: the same declared cell the page uses, so a
 * golden shows whether the size change reached the grid or only the text.
 */
@Composable
fun TerminalFontPreview(fontPx: Int, modifier: Modifier = Modifier) {
    val cell = TerminalFont.metrics(fontPx)
    Column(modifier.fillMaxSize().background(Color(0xFF14161A)).padding(8.dp)) {
        val lines = listOf(
            "yash@pc:~/src$ git status",
            "On branch main",
            "Your branch is up to date with 'origin/main'.",
            "nothing to commit, working tree clean",
            "yash@pc:~/src$",
        )
        for (line in lines) {
            Text(
                line,
                color = Color(0xFFD7DEE8),
                fontFamily = FontFamily.Monospace,
                fontSize = cell.fontPx.sp,
                lineHeight = cell.heightPx.sp,
            )
        }
        Text(
            "font ${cell.fontPx}px, cell ${cell.widthPx}x${cell.heightPx}px",
            color = Color(0xFF8A94A6),
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(top = 12.dp).testTag("terminalMetrics"),
        )
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun TerminalScreen(ws: WsClient, sessionId: String, onClose: () -> Unit) {
    val holder = remember { arrayOfNulls<WebView>(1) }
    val pending = remember { mutableListOf<String>() }
    var ended by remember { mutableStateOf<Int?>(null) }

    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("pocketdesk", Context.MODE_PRIVATE) }
    var fontPx by remember { mutableStateOf(TerminalFont.load(prefs)) }
    val fontNow = remember { arrayOf(TerminalFont.DEFAULT_PX) }
    val armer = remember { ModifierArmer() }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val clipboard = remember(context) {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        ClipboardSink { text -> manager.setPrimaryClip(ClipData.newPlainText("Terminal selection", text)) }
    }

    SideEffect { fontNow[0] = fontPx }

    DisposableEffect(ws, sessionId) {
        // Under the lock, so output arriving while the page finishes is neither lost nor reordered.
        val sink: (String, String) -> Unit = { id, data ->
            if (id == sessionId) toPage(holder, pending, "window.termOut('$data')")
        }
        val sizer: (String, Int, Int) -> Unit = { id, c, r ->
            if (id == sessionId) toPage(holder, pending, "window.termSize($c,$r)")
        }
        ws.onTerminalData = sink
        ws.onTerminalSize = sizer
        ws.attach(sessionId)
        onDispose {
            if (ws.onTerminalData === sink) ws.onTerminalData = null
            if (ws.onTerminalSize === sizer) ws.onTerminalSize = null
            ws.detach(sessionId)
        }
    }

    LaunchedEffect(ws, sessionId) {
        ws.events.collect { ev ->
            if (ev is RhEvent.Exit && ev.id == sessionId) ended = ev.code
        }
    }

    // Every font change reaches the page, which sets the size and the cell together.
    LaunchedEffect(fontPx) {
        toPage(holder, pending, TerminalFont.pageScript(fontPx))
    }

    fun setFont(next: Int) {
        val size = TerminalFont.nearestStep(next)
        fontPx = size
        TerminalFont.save(prefs, size)
    }

    fun copySelectionNow() {
        val view = holder[0] ?: return
        view.evaluateJavascript("window.termSelection()") { json ->
            val selected = jsString(json) ?: ""
            copySelection({ selected }, clipboard) {
                scope.launch { snackbar.showSnackbar("Copied ${selected.length} characters") }
            }
        }
    }

    fun press(key: ExtraKey) {
        if (key.isModifier) {
            armer.toggle(key)
            return
        }
        if (ended != null) return
        ws.sendInput(sessionId, b64(armer.apply(key.bytes)))
    }

    Box(Modifier.fillMaxSize().imePadding()) {
        Column(Modifier.fillMaxSize()) {
            TerminalChrome(
                sessionId = sessionId,
                fontPx = fontPx,
                ctrl = armer.ctrl,
                alt = armer.alt,
                enabled = ended == null,
                onFontSmaller = { setFont(TerminalFont.smaller(fontPx)) },
                onFontLarger = { setFont(TerminalFont.larger(fontPx)) },
                onCopy = { copySelectionNow() },
                onKey = { press(it) },
                onClose = onClose,
                onKill = { ws.kill(sessionId) },
            )
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
                            // Pinch zoom: the PC-sized grid can stay larger than the phone.
                            settings.builtInZoomControls = true
                            settings.displayZoomControls = false
                            addJavascriptInterface(
                                TermBridge(onInput = { data ->
                                    ws.sendInput(sessionId, armedInput(data, armer))
                                }),
                                "Android",
                            )
                            webViewClient = object : WebViewClient() {
                                // Any other page would inherit the Android bridge and could type into the PC shell.
                                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                                    !request.url.toString().startsWith("file:///android_asset/")

                                override fun onPageFinished(view: WebView, url: String) {
                                    val flush: List<String>
                                    synchronized(pending) {
                                        holder[0] = view
                                        flush = pending.toList()
                                        pending.clear()
                                    }
                                    for (js in flush) view.evaluateJavascript(js, null)
                                    view.evaluateJavascript(TerminalFont.pageScript(fontNow[0]), null)
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
        // Above the keys and the IME, and it never touches the terminal's selection.
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
    }
}

private fun toPage(holder: Array<WebView?>, pending: MutableList<String>, js: String) =
    synchronized(pending) {
        val view = holder[0]
        if (view == null) pending += js else view.post { view.evaluateJavascript(js, null) }
    }