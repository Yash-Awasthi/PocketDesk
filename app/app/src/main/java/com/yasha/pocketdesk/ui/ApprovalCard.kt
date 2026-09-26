package com.yasha.pocketdesk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yasha.pocketdesk.Proposal
import com.yasha.pocketdesk.WsClient
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** The oldest waiting tool call, with what it would do and Allow / Deny. Hidden when nothing waits. */
@Composable
fun ApprovalCard(ws: WsClient, modifier: Modifier = Modifier) {
    val p = ws.proposals.firstOrNull() ?: return
    var expanded by remember(p.id) { mutableStateOf(false) }
    val chat = ws.chats.firstOrNull { it.id == p.owner }
    Card(
        modifier.fillMaxWidth().padding(8.dp),
        colors = CardDefaults.cardColors(containerColor = Color(0xFF2D2A1E)),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val more = ws.proposals.size - 1
            Text(
                "${p.tool.ifEmpty { "Agent" }} wants approval" + (if (more > 0) " · $more more waiting" else ""),
                style = MaterialTheme.typography.titleSmall,
                color = Color(0xFFE3B341),
            )
            listOfNotNull(chat?.harnessId, (chat?.cwd ?: p.cwd).takeIf { it.isNotEmpty() }).joinToString(" · ").takeIf { it.isNotEmpty() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Column(
                Modifier.fillMaxWidth().heightIn(max = if (expanded) 420.dp else 160.dp)
                    .background(Color(0xFF0D1117)).clickable { expanded = !expanded }.verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()).padding(8.dp),
            ) {
                ToolPreview(p)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { ws.reject(p.id) }) { Text("Deny") }
                Button(onClick = { ws.approve(p.id) }) { Text("Allow") }
                if (p.agentSession.isNotEmpty()) {
                    Button(
                        onClick = { ws.approve(p.id, all = true) },
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.tertiary),
                    ) { Text("Allow all") }
                }
            }
        }
    }
}

private val Mono = FontFamily.Monospace
private val Removed = Color(0xFFF85149)
private val Added = Color(0xFF3FB950)

@Composable
private fun Code(text: String, color: Color = Color(0xFFE6EDF3)) {
    Text(text, fontFamily = Mono, fontSize = 12.sp, color = color, softWrap = false)
}

/** Edits as a red/green diff, commands and other calls as their raw arguments. */
@Composable
private fun ToolPreview(p: Proposal) {
    val input = p.input
    fun s(key: String, o: JsonObject = input) = (o[key] as? JsonPrimitive)?.contentOrNull
    when (p.tool) {
        "Bash" -> Code("$ " + (s("command") ?: p.summary))
        "Edit" -> {
            s("file_path")?.let { Code(it, Color(0xFF8B949E)) }
            Diff(s("old_string").orEmpty(), s("new_string").orEmpty())
        }
        "MultiEdit" -> {
            s("file_path")?.let { Code(it, Color(0xFF8B949E)) }
            (input["edits"] as? JsonArray)?.forEach { e ->
                val o = e as? JsonObject ?: return@forEach
                Diff(s("old_string", o).orEmpty(), s("new_string", o).orEmpty())
                Code("⋯", Color(0xFF8B949E))
            }
        }
        "Write" -> {
            s("file_path")?.let { Code("new file " + it, Color(0xFF8B949E)) }
            s("content")?.lines()?.forEach { Code("+ $it", Added) }
        }
        else -> input.forEach { (k, v) ->
            Code("$k: " + ((v as? JsonPrimitive)?.contentOrNull ?: v.toString()))
        }
    }
}

@Composable
private fun Diff(old: String, new: String) {
    old.lines().forEach { Code("- $it", Removed) }
    new.lines().forEach { Code("+ $it", Added) }
}
