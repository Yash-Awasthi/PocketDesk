package com.yasha.pocketdesk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yasha.pocketdesk.WsClient
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class Mod(val wire: String) { Ctrl("ctrl"), Shift("shift"), Alt("alt"), Win("win") }

/** Off, held for the next key only, or locked until tapped again. */
private enum class Latch { Off, Once, Locked }

private val KEY_BG = Color(0xFF21262D)
private val KEY_PRESSED = Color(0xFF3A424D)
private val KEY_SPECIAL = Color(0xFF161B22)
private val KEY_BORDER = Color(0xFF30363D)
private val KEY_TEXT = Color(0xFFE6EDF3)
private val ONCE_BG = Color(0xFF1F6FEB)
private val LOCKED_BG = Color(0xFFF0883E)

/** Windows virtual keys for the US layout; the Boolean says whether Shift produces the character. */
internal val CHAR_VK: Map<Char, Pair<Int, Boolean>> = buildMap {
    for (c in 'a'..'z') put(c, c.uppercaseChar().code to false)
    for (c in 'A'..'Z') put(c, c.code to true)
    for (c in '0'..'9') put(c, c.code to false)
    val base = mapOf('-' to 0xBD, '=' to 0xBB, '[' to 0xDB, ']' to 0xDD, '\\' to 0xDC, ';' to 0xBA,
        '\'' to 0xDE, ',' to 0xBC, '.' to 0xBE, '/' to 0xBF, '`' to 0xC0)
    base.forEach { (c, vk) -> put(c, vk to false) }
    "!@#$%^&*()".forEachIndexed { i, c -> put(c, ('1' + i).let { if (it > '9') '0' else it }.code to true) }
    mapOf('_' to '-', '+' to '=', '{' to '[', '}' to ']', '|' to '\\', ':' to ';', '"' to '\'',
        '<' to ',', '>' to '.', '?' to '/', '~' to '`').forEach { (c, b) -> put(c, base.getValue(b) to true) }
    put(' ', VK_SPACE to false)
    put('\n', VK_ENTER to false)
    put('\t', VK_TAB to false)
}

internal const val VK_BACK = 8
private const val VK_TAB = 9
private const val VK_ENTER = 13
private const val VK_SPACE = 32

/** What one change of the phone keyboard's text means on the PC. */
internal sealed interface Stroke {
    /** A key press; modifiers held on the bar apply to it. */
    data class Vk(val vk: Int, val shift: Boolean = false) : Stroke
    /** Text with no key on a US layout (accents, emoji): typed as it is. */
    data class Text(val text: String) : Stroke
}

/** The input field always holds [IME_SENTINEL]; text added after it is typed, and each character removed from it is a Backspace. */
internal const val IME_SENTINEL = "        "

internal fun imeStrokes(text: String): List<Stroke> = when {
    text.length < IME_SENTINEL.length -> List(IME_SENTINEL.length - text.length) { Stroke.Vk(VK_BACK) }
    // Anything else (an autocorrect rewriting the sentinel) is not a keystroke.
    !text.startsWith(IME_SENTINEL) -> emptyList()
    else -> text.drop(IME_SENTINEL.length).map { c -> CHAR_VK[c]?.let { (vk, shift) -> Stroke.Vk(vk, shift) } ?: Stroke.Text(c.toString()) }
}

/** Keys a phone keyboard lacks compared with a full-size PC keyboard. */
private val NAV_KEYS = listOf(
    "←" to 37, "↑" to 38, "↓" to 40, "→" to 39, "Home" to 36, "End" to 35, "PgUp" to 33, "PgDn" to 34,
    "Ins" to 45, "Del" to 46, "PrtSc" to 44, "Caps" to 20, "NumLk" to 144, "ScrLk" to 145, "Pause" to 19,
    "Menu" to 93, "⏮" to 0xB1, "⏯" to 0xB3, "⏭" to 0xB0, "Vol−" to 0xAE, "Vol+" to 0xAF, "Mute" to 0xAD,
)
private val F_KEYS = (1..12).map { "F$it" to 111 + it }
private val REPEATING = setOf(VK_BACK, 37, 38, 39, 40, 33, 34, 46, 0xAE, 0xAF)

/**
 * Desktop typing: the phone's own keyboard types into a hidden field and every keystroke goes to
 * the PC at once, as a virtual key so shortcuts work. The bar above adds sticky Ctrl, Shift, Alt and
 * Win (tap: next key only, tap again: locked), Fn for F1–F12, and the navigation, lock and media keys.
 */
@Composable
fun DesktopKeyboard(ws: WsClient) {
    var latches by remember { mutableStateOf(Mod.entries.associateWith { Latch.Off }) }
    var fn by remember { mutableStateOf(false) }
    val clipboard = LocalClipboard.current
    val clipScope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }
    val ime = LocalSoftwareKeyboardController.current

    fun active(m: Mod) = latches.getValue(m) != Latch.Off
    fun send(vk: Int, extraShift: Boolean = false) {
        val mods = Mod.entries.filter { active(it) || (it == Mod.Shift && extraShift) }.map { it.wire }
        ws.desktopKey(vk, mods)
        latches = latches.mapValues { (_, l) -> if (l == Latch.Once) Latch.Off else l }
    }
    fun apply(s: Stroke) = when (s) {
        is Stroke.Vk -> send(s.vk, s.shift)
        is Stroke.Text -> { ws.desktopType(s.text) }
    }

    var field by remember { mutableStateOf(TextFieldValue(IME_SENTINEL, TextRange(IME_SENTINEL.length))) }
    LaunchedEffect(Unit) { focus.requestFocus(); ime?.show() }

    // imePadding keeps the bar right above the phone keyboard, with the picture shrinking to fit.
    Column(Modifier.fillMaxWidth().background(Color(0xFF0D1117)).imePadding().padding(horizontal = 3.dp, vertical = 2.dp)) {
        // Password type: no suggestions, autocorrect or composing, so every key reaches onValueChange as typed.
        BasicTextField(
            value = field,
            onValueChange = { v ->
                imeStrokes(v.text).forEach(::apply)
                field = TextFieldValue(IME_SENTINEL, TextRange(IME_SENTINEL.length))
            },
            modifier = Modifier.size(1.dp).alpha(0f).focusRequester(focus),
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password, autoCorrectEnabled = false,
                capitalization = KeyboardCapitalization.None, imeAction = ImeAction.Send,
            ),
            keyboardActions = KeyboardActions(onSend = { send(VK_ENTER) }),
        )
        Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Mod.entries.forEach { m ->
                val l = latches.getValue(m)
                Key(modLabel(ws.targetOs, m.wire) + if (l == Latch.Locked) " ■" else "", Modifier.weight(1f), special = true,
                    background = when (l) { Latch.Off -> null; Latch.Once -> ONCE_BG; Latch.Locked -> LOCKED_BG }) {
                    latches = latches + (m to when (l) { Latch.Off -> Latch.Once; Latch.Once -> Latch.Locked; Latch.Locked -> Latch.Off })
                }
            }
            Key("Fn", Modifier.weight(0.8f), special = true, highlight = fn) { fn = !fn }
            Key("Esc", Modifier.weight(0.9f), special = true) { send(27) }
            Key("Tab", Modifier.weight(0.9f), special = true) { send(VK_TAB) }
            Key("⌨", Modifier.weight(0.8f), special = true) { focus.requestFocus(); ime?.show() }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            (if (fn) F_KEYS else NAV_KEYS).forEach { (label, vk) ->
                Key(label, Modifier.width(54.dp), special = true, repeat = vk in REPEATING) { send(vk) }
            }
            Key("Paste", Modifier.width(64.dp), special = true) {
                clipScope.launch {
                    val clip = clipboard.getClipEntry()?.clipData?.takeIf { it.itemCount > 0 } ?: return@launch
                    clip.getItemAt(0).text?.toString()?.let { ws.clipboardSet(it, paste = true) }
                }
            }
            Key("Copy", Modifier.width(60.dp), special = true) { ws.clipboardGet() }
        }
    }
}

/**
 * One key. Pressed state shows as an instant colour change (no ripple), with a
 * light tick; [repeat] keys fire again every 60 ms while held.
 */
@Composable
private fun Key(
    label: String,
    modifier: Modifier,
    height: Dp = 44.dp,
    special: Boolean = false,
    highlight: Boolean = false,
    repeat: Boolean = false,
    background: Color? = null,
    onClick: () -> Unit,
) {
    var pressed by remember { mutableStateOf(false) }
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val action by rememberUpdatedState(onClick)
    val shape = RoundedCornerShape(6.dp)
    val bg = when {
        pressed -> KEY_PRESSED
        background != null -> background
        highlight -> ONCE_BG
        special -> KEY_SPECIAL
        else -> KEY_BG
    }
    Box(
        modifier.height(height).clip(shape).background(bg).border(1.dp, KEY_BORDER, shape)
            .pointerInput(repeat) {
                detectTapGestures(onPress = {
                    pressed = true
                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    action()
                    var repeater: Job? = null
                    if (repeat) repeater = scope.launch { delay(400); while (true) { action(); delay(60) } }
                    tryAwaitRelease()
                    repeater?.cancel()
                    pressed = false
                })
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(label, maxLines = 1, color = KEY_TEXT, fontSize = 14.sp, fontWeight = FontWeight.Medium)
    }
}

/** Material "desktop windows" glyph; the core icon set has no monitor. */
val MonitorIcon: androidx.compose.ui.graphics.vector.ImageVector =
    androidx.compose.ui.graphics.vector.ImageVector.Builder("Monitor", 24.dp, 24.dp, 24f, 24f).addPath(
        pathData = androidx.compose.ui.graphics.vector.addPathNodes(
            "M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H3V4h18v12z",
        ),
        fill = androidx.compose.ui.graphics.SolidColor(Color.Black),
    ).build()
