package com.yasha.pocketdesk.ui

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yasha.pocketdesk.WsClient
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class Layer { Letters, Numbers, Symbols }
private enum class Mod(val wire: String, val label: String) { Ctrl("ctrl", "Ctrl"), Shift("shift", "Shift"), Alt("alt", "Alt"), Win("win", "Win") }

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
    for (c in '0'..'9') put(c, c.code to false)
    val base = mapOf('-' to 0xBD, '=' to 0xBB, '[' to 0xDB, ']' to 0xDD, '\\' to 0xDC, ';' to 0xBA,
        '\'' to 0xDE, ',' to 0xBC, '.' to 0xBE, '/' to 0xBF, '`' to 0xC0)
    base.forEach { (c, vk) -> put(c, vk to false) }
    "!@#$%^&*()".forEachIndexed { i, c -> put(c, ('1' + i).let { if (it > '9') '0' else it }.code to true) }
    mapOf('_' to '-', '+' to '=', '{' to '[', '}' to ']', '|' to '\\', ':' to ';', '"' to '\'',
        '<' to ',', '>' to '.', '?' to '/', '~' to '`').forEach { (c, b) -> put(c, base.getValue(b) to true) }
}

private const val VK_BACK = 8
private const val VK_TAB = 9
private const val VK_ENTER = 13
private const val VK_ESC = 27
private const val VK_SPACE = 32
private const val VK_DEL = 46

private val NAV_KEYS = listOf(
    "Esc" to VK_ESC, "Tab" to VK_TAB, "Del" to VK_DEL, "Home" to 36, "End" to 35, "PgUp" to 33, "PgDn" to 34,
    "PrtSc" to 44,
) + (1..12).map { "F$it" to 111 + it }
private val ARROWS = listOf("←" to 37, "↑" to 38, "↓" to 40, "→" to 39)
private val REPEATING = setOf(VK_BACK, VK_DEL, VK_SPACE, 37, 38, 39, 40)

private val LETTER_ROWS = listOf("qwertyuiop", "asdfghjkl", "zxcvbnm")
private val NUMBER_ROWS = listOf("789/", "456*", "123-", "0.=+")
private val SYMBOL_ROWS = listOf("!@#$%^&*()", "-_=+[]{}\\|", ";:'\",.<>/?", "`~")

/**
 * The desktop keyboard: every key goes to the PC as a virtual key, so shortcuts
 * work like on a real keyboard. Letters, a numpad and symbols are separate layers;
 * the modifier row stays on every layer (tap: next key only, tap again: locked).
 */
@Composable
fun DesktopKeyboard(ws: WsClient) {
    var layer by remember { mutableStateOf(Layer.Letters) }
    var latches by remember { mutableStateOf(Mod.entries.associateWith { Latch.Off }) }
    var typing by remember { mutableStateOf(false) }
    var text by remember { mutableStateOf("") }
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    LaunchedEffect(Unit) {
        ws.pcClipboard.collect {
            clipboard.setText(AnnotatedString(it))
            Toast.makeText(context, "Copied from PC", Toast.LENGTH_SHORT).show()
        }
    }

    fun active(m: Mod) = latches.getValue(m) != Latch.Off
    fun send(vk: Int, extraShift: Boolean = false) {
        val mods = Mod.entries.filter { active(it) || (it == Mod.Shift && extraShift) }.map { it.wire }
        ws.desktopKey(vk, mods)
        latches = latches.mapValues { (_, l) -> if (l == Latch.Once) Latch.Off else l }
    }
    fun sendChar(c: Char) {
        val (vk, shifted) = CHAR_VK[c] ?: return
        send(vk, shifted)
    }
    val upper = active(Mod.Shift)

    Column(Modifier.fillMaxWidth().background(Color(0xFF0D1117)).padding(horizontal = 3.dp, vertical = 2.dp)) {
        // Navigation, function keys and clipboard: one scrollable row.
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Key("✎", Modifier.width(52.dp), height = 44.dp, special = true, highlight = typing) { typing = !typing }
            Key("Paste", Modifier.width(64.dp), height = 44.dp, special = true) {
                clipboard.getText()?.text?.let { ws.clipboardSet(it, paste = true) }
            }
            Key("Copy", Modifier.width(60.dp), height = 44.dp, special = true) { ws.clipboardGet() }
            NAV_KEYS.forEach { (label, vk) -> Key(label, Modifier.width(56.dp), height = 44.dp, special = true, repeat = vk in REPEATING) { send(vk) } }
        }
        if (typing) {
            Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(value = text, onValueChange = { text = it }, modifier = Modifier.weight(1f),
                    placeholder = { Text("Type a line to send to the PC") }, singleLine = true)
                TextButton(onClick = { if (text.isNotEmpty()) { ws.desktopType(text); text = "" } }) { Text("Send") }
            }
        }
        // Modifiers are on every layer.
        KeyRow {
            Mod.entries.forEach { m ->
                val l = latches.getValue(m)
                Key(m.label + if (l == Latch.Locked) " ■" else "", Modifier.weight(1f), special = true,
                    background = when (l) { Latch.Off -> null; Latch.Once -> ONCE_BG; Latch.Locked -> LOCKED_BG }) {
                    latches = latches + (m to when (l) { Latch.Off -> Latch.Once; Latch.Once -> Latch.Locked; Latch.Locked -> Latch.Off })
                }
            }
            ARROWS.forEach { (label, vk) -> Key(label, Modifier.weight(0.8f), special = true, repeat = true) { send(vk) } }
        }
        when (layer) {
            Layer.Letters -> LETTER_ROWS.forEachIndexed { i, row ->
                KeyRow {
                    // Every row spans ten key widths so the columns line up.
                    if (i == 1) Box(Modifier.weight(0.5f))
                    if (i == 2) Box(Modifier.weight(1f))
                    row.forEach { c -> Key(if (upper) c.uppercase() else c.toString(), Modifier.weight(1f), big = true) { sendChar(c) } }
                    if (i == 1) Box(Modifier.weight(0.5f))
                    if (i == 2) Key("⌫", Modifier.weight(2f), big = true, special = true, repeat = true) { send(VK_BACK) }
                }
            }
            Layer.Numbers -> NUMBER_ROWS.forEachIndexed { i, row ->
                KeyRow {
                    row.forEach { c -> Key(c.toString(), Modifier.weight(1f), big = true) { sendChar(c) } }
                    if (i == 0) Key("⌫", Modifier.weight(1f), big = true, special = true, repeat = true) { send(VK_BACK) }
                    if (i == 1) Key(",", Modifier.weight(1f), big = true) { sendChar(',') }
                    if (i == 2) Key("(", Modifier.weight(1f), big = true) { sendChar('(') }
                    if (i == 3) Key(")", Modifier.weight(1f), big = true) { sendChar(')') }
                }
            }
            Layer.Symbols -> SYMBOL_ROWS.forEachIndexed { i, row ->
                KeyRow {
                    row.forEach { c -> Key(c.toString(), Modifier.weight(1f), big = true) { sendChar(c) } }
                    if (i == 3) {
                        Box(Modifier.weight(6.5f))
                        Key("⌫", Modifier.weight(1.5f), big = true, special = true, repeat = true) { send(VK_BACK) }
                    }
                }
            }
        }
        KeyRow {
            listOf(Layer.Letters to "abc", Layer.Numbers to "123", Layer.Symbols to "#+=").forEach { (l, label) ->
                if (l != layer) Key(label, Modifier.weight(1.2f), special = true) { layer = l }
            }
            Key("space", Modifier.weight(4f), special = true, repeat = true) { send(VK_SPACE) }
            Key("⏎", Modifier.weight(1.4f), big = true, special = true) { send(VK_ENTER) }
        }
    }
}

@Composable
private fun KeyRow(content: @Composable RowScope.() -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), content = content)
}

/**
 * One key. Pressed state shows as an instant colour change (no ripple), with a
 * light tick; [repeat] keys fire again every 60 ms while held.
 */
@Composable
private fun Key(
    label: String,
    modifier: Modifier,
    height: Dp = 48.dp,
    big: Boolean = false,
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
        Text(label, maxLines = 1, color = KEY_TEXT,
            fontSize = if (big) 20.sp else 15.sp, fontWeight = if (big) FontWeight.Normal else FontWeight.Medium)
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
