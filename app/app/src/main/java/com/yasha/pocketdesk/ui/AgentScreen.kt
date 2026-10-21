package com.yasha.pocketdesk.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yasha.pocketdesk.AgentDoc
import com.yasha.pocketdesk.WsClient

/** Agents the daemon has a panel for; the ids match their manifests. */
val AGENT_PANELS = setOf("claude", "codex", "gemini", "qwen", "opencode", "copilot", "cline")

/**
 * Everything one agent keeps on the PC: recent conversations, skills, custom slash commands and its
 * settings and memory files. Skills and commands run as a new phone chat when the agent can chat.
 */
@Composable
fun AgentScreen(ws: WsClient, agent: String, onClose: () -> Unit, openChats: () -> Unit) {
    val tool = ws.tools.firstOrNull { it.manifest.id == agent }
    val canChat = tool?.manifest?.chat == true && tool.installed == true
    val p = ws.agentPanels[agent]
    var editing by remember { mutableStateOf<AgentDoc?>(null) }
    var viewing by remember { mutableStateOf<AgentDoc?>(null) }
    // Cursor and Antigravity have accounts but no panel; asking for one would only report an error.
    LaunchedEffect(agent) { if (agent in AGENT_PANELS) ws.agentPanel(agent); ws.historyList() }
    // A doc arrives for whichever dialog asked: files open for editing, skills and commands for reading.
    LaunchedEffect(agent) { ws.agentDocs.collect { d -> if (d.agent == agent) { if (d.kind == "file") editing = d else viewing = d } } }
    fun run(command: String) { ws.createChat(agent, "", "/$command"); openChats() }

    LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(tool?.manifest?.name ?: agent, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                TextButton(onClick = { ws.agentPanel(agent); ws.historyList() }) { Text("Refresh") }
                TextButton(onClick = onClose) { Text("Back") }
            }
        }
        val recent = ws.history.filter { it.agent == agent }.take(5)
        if (recent.isNotEmpty()) {
            item { Text("Recent conversations", style = MaterialTheme.typography.titleMedium) }
            recent.forEach { e ->
                item(key = "h:" + e.id) {
                    Card(Modifier.fillMaxWidth().clickable { ws.historyGet(e); openChats() }) {
                        Text(e.title.ifBlank { "(untitled)" }, Modifier.padding(12.dp), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        if (agent in ACCOUNT_AGENTS) item { AccountsSection(ws, agent, tool?.manifest?.name ?: agent) }
        if (p == null && agent in AGENT_PANELS) item { Text("Loading…", style = MaterialTheme.typography.bodySmall) }
        p?.let { panel ->
            section("Skills", panel.skills, "skill", ws, agent, canChat, ::run)
            section("Custom commands", panel.commands, "command", ws, agent, canChat, ::run)
            item { Text("Settings and memory files", style = MaterialTheme.typography.titleMedium) }
            panel.files.forEach { f ->
                item(key = "f:" + f.name) {
                    Card(Modifier.fillMaxWidth()) {
                        Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(f.name, style = MaterialTheme.typography.bodyMedium)
                                Text(if (f.exists) sizeText(f.size) else "not created yet", style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            TextButton(onClick = { ws.agentDoc(agent, "file", f.name) }) { Text(if (f.exists) "Edit" else "Create") }
                        }
                    }
                }
            }
        }
    }

    viewing?.let { d ->
        AlertDialog(
            onDismissRequest = { viewing = null },
            title = { Text("/" + d.name) },
            text = { Text(d.content, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace,
                modifier = Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) },
            confirmButton = {
                if (canChat) TextButton(onClick = { viewing = null; run(d.name) }) { Text("Run in a chat") }
            },
            dismissButton = { TextButton(onClick = { viewing = null }) { Text("Close") } },
        )
    }
    editing?.let { d ->
        var text by remember(d) { mutableStateOf(d.content) }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text(d.name) },
            text = {
                OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth().heightIn(min = 200.dp, max = 420.dp),
                    textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
            },
            confirmButton = { TextButton(onClick = { ws.agentFileSet(agent, d.name, text); editing = null }) { Text("Save on PC") } },
            dismissButton = { TextButton(onClick = { editing = null }) { Text("Cancel") } },
        )
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.section(
    title: String, rows: List<Pair<String, String>>, kind: String, ws: WsClient, agent: String, canChat: Boolean, run: (String) -> Unit,
) {
    if (rows.isEmpty()) return
    item { Text("$title (${rows.size})", style = MaterialTheme.typography.titleMedium) }
    rows.forEach { (name, desc) ->
        item(key = "$kind:$name") {
            Card(Modifier.fillMaxWidth()) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("/$name", style = MaterialTheme.typography.bodyMedium)
                        if (desc.isNotBlank()) Text(desc, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    TextButton(onClick = { ws.agentDoc(agent, kind, name) }) { Text("View") }
                    if (canChat) TextButton(onClick = { run(name) }) { Text("Run") }
                }
            }
        }
    }
}
