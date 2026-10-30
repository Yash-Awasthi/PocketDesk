// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk.ui

import android.content.Context
import android.view.HapticFeedbackConstants
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.yasha.pocketdesk.WsClient
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** One Deck button: a key with modifiers, or a PC power action. */
@Serializable
internal data class DeckTile(val label: String, val vk: Int = 0, val mods: List<String> = emptyList(), val power: String? = null)

private val MEDIA = listOf(
    DeckTile("⏮ Previous", 0xB1), DeckTile("⏯ Play", 0xB3), DeckTile("⏭ Next", 0xB0),
    DeckTile("🔉 Vol −", 0xAE), DeckTile("🔊 Vol +", 0xAF), DeckTile("🔇 Mute", 0xAD),
)
private val WINDOWS = listOf(
    DeckTile("Show desktop", 'D'.code, listOf("win")), DeckTile("Task view", 0x09, listOf("win")), DeckTile("Switch app", 0x09, listOf("alt")),
    DeckTile("Close window", 0x73, listOf("alt")), DeckTile("Screenshot", 'S'.code, listOf("win", "shift")), DeckTile("Task Manager", 0x1B, listOf("ctrl", "shift")),
    DeckTile("Copy", 'C'.code, listOf("ctrl")), DeckTile("Paste", 'V'.code, listOf("ctrl")), DeckTile("Undo", 'Z'.code, listOf("ctrl")),
    DeckTile("Lock", power = "lock"), DeckTile("Sleep", power = "sleep"), DeckTile("Mic mute", 'K'.code, listOf("win", "alt")),
)

/** A letter, digit or F-key name to its virtual-key code. */
internal fun deckKey(name: String): Int? {
    val k = name.trim().uppercase()
    return when {
        k.length == 1 && (k[0] in 'A'..'Z' || k[0] in '0'..'9') -> k[0].code
        k.matches(Regex("F([1-9]|1[0-9]|2[0-4])")) -> 0x6F + k.drop(1).toInt()
        else -> mapOf("ENTER" to 13, "ESC" to 27, "TAB" to 9, "SPACE" to 32, "DELETE" to 46, "UP" to 38, "DOWN" to 40, "LEFT" to 37, "RIGHT" to 39,
            "HOME" to 36, "END" to 35, "PGUP" to 33, "PGDN" to 34)[k]
    }
}

/**
 * Stream Deck-style buttons for the PC: media keys, shortcuts and power, plus buttons of your own.
 * Each one acts at once, without opening the desktop view. Long-press one of yours to remove it.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun DeckScreen(ws: WsClient, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val view = LocalView.current
    val prefs = ctx.getSharedPreferences("pocketdesk", Context.MODE_PRIVATE)
    val custom = remember { mutableStateListOf<DeckTile>().apply { addAll(load(prefs.getString("deck", null))) } }
    var adding by remember { mutableStateOf(false) }
    androidx.compose.runtime.DisposableEffect(Unit) {
        ws.sendRaw("""{"type":"pc_media_watch","on":true}""")
        onDispose { ws.sendRaw("""{"type":"pc_media_watch","on":false}""") }
    }
    fun save() = prefs.edit().putString("deck", Json.encodeToString(custom.toList())).apply()
    fun run(t: DeckTile) {
        view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        if (t.power != null) ws.pcPower(t.power) else ws.sendRaw(Json.encodeToString(mapOf("type" to kotlinx.serialization.json.JsonPrimitive("deck_key"),
            "key" to kotlinx.serialization.json.JsonPrimitive(t.vk), "modifiers" to kotlinx.serialization.json.JsonArray(t.mods.map { kotlinx.serialization.json.JsonPrimitive(it) }))))
    }

    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onClose) { Text("Close") }
            Text("Deck", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = { adding = true }) { Text("＋ Button") }
        }
        LazyVerticalGrid(GridCells.Adaptive(104.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                val now = ws.pcMedia
                Column {
                    Text("Media", style = MaterialTheme.typography.labelLarge)
                    if (now != null) Text(
                        (if (now.third) "▶ " else "⏸ ") + now.first + (if (now.second.isNotBlank()) " · ${now.second}" else ""),
                        style = MaterialTheme.typography.bodyMedium, maxLines = 2, modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
            items(MEDIA) { Tile(it.label) { run(it) } }
            item(span = { GridItemSpan(maxLineSpan) }) { Text("Windows", style = MaterialTheme.typography.labelLarge) }
            items(WINDOWS) { Tile(it.label) { run(it) } }
            if (custom.isNotEmpty()) item(span = { GridItemSpan(maxLineSpan) }) { Text("Yours (long-press to remove)", style = MaterialTheme.typography.labelLarge) }
            items(custom.toList()) { t -> Tile(t.label, onLong = { custom.remove(t); save() }) { run(t) } }
        }
    }
    if (adding) AddTile(onDone = { t -> adding = false; if (t != null) { custom.add(t); save() } })
}

private fun load(json: String?): List<DeckTile> = json?.let { runCatching { Json.decodeFromString<List<DeckTile>>(it) }.getOrNull() } ?: emptyList()

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Tile(label: String, onLong: (() -> Unit)? = null, onClick: () -> Unit) {
    Box(
        Modifier.fillMaxWidth().aspectRatio(1.3f).clip(RoundedCornerShape(14.dp)).background(MaterialTheme.colorScheme.secondaryContainer)
            .combinedClickable(onClick = onClick, onLongClick = onLong),
        contentAlignment = Alignment.Center,
    ) { Text(label, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSecondaryContainer, modifier = Modifier.padding(6.dp)) }
}

@Composable
private fun AddTile(onDone: (DeckTile?) -> Unit) {
    var label by remember { mutableStateOf("") }
    var key by remember { mutableStateOf("") }
    val mods = remember { mutableStateListOf<String>() }
    val vk = deckKey(key)
    AlertDialog(
        onDismissRequest = { onDone(null) },
        title = { Text("New button") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(label, { label = it }, label = { Text("Name") }, singleLine = true)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (m in listOf("ctrl", "alt", "shift", "win")) FilterChip(m in mods, { if (m in mods) mods.remove(m) else mods.add(m) }, { Text(m) })
                }
                OutlinedTextField(key, { key = it }, label = { Text("Key: A–Z, 0–9, F1–F24, Enter, Esc, Tab…") }, singleLine = true, isError = key.isNotBlank() && vk == null)
            }
        },
        confirmButton = { TextButton(enabled = label.isNotBlank() && vk != null, onClick = { onDone(DeckTile(label.trim(), vk!!, mods.toList())) }) { Text("Add") } },
        dismissButton = { TextButton(onClick = { onDone(null) }) { Text("Cancel") } },
    )
}
