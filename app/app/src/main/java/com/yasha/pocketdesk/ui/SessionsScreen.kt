package com.yasha.pocketdesk.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yasha.pocketdesk.RhEvent
import com.yasha.pocketdesk.ToolInfo
import com.yasha.pocketdesk.WsClient

@Composable
fun SessionsScreen(ws: WsClient, openTerminal: (String) -> Unit) {
    val installed = remember(ws.tools) { ws.tools.filter { it.installed == true } }
    var tool by remember { mutableStateOf<ToolInfo?>(null) }
    LaunchedEffect(installed) {
        if (tool == null || installed.none { it.manifest.id == tool?.manifest?.id }) {
            tool = installed.firstOrNull()
        }
    }

    var cwd by remember { mutableStateOf("") }
    var browsing by remember { mutableStateOf(false) }
    LaunchedEffect(browsing) {
        if (browsing) ws.browse(cwd.ifBlank { null })
    }

    LaunchedEffect(Unit) {
        ws.events.collect { ev ->
            if (ev is RhEvent.Created) openTerminal(ev.id)
        }
    }

    LazyColumn(
        Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Text("New session", style = MaterialTheme.typography.titleLarge)
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ToolPicker(installed, tool) { tool = it }
                OutlinedTextField(
                    value = cwd,
                    onValueChange = { cwd = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Project folder") },
                    placeholder = { Text("blank = home directory") },
                    singleLine = true,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { browsing = true }, enabled = tool != null) { Text("Browse") }
                    Button(
                        onClick = { ws.createSession(tool!!.manifest.id, cwd.trim()) },
                        enabled = tool != null,
                    ) { Text("Start session") }
                }
            }
        }
        item {
            Text("Live sessions", style = MaterialTheme.typography.titleLarge)
        }
        if (ws.sessions.isEmpty()) {
            item { Text("None", style = MaterialTheme.typography.bodySmall) }
        }
        items(ws.sessions, key = { it.id }) { s ->
            Card(Modifier.fillMaxWidth()) {
                Row(
                    Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(s.harnessId, style = MaterialTheme.typography.titleMedium)
                        Text(
                            s.cwd,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    TextButton(onClick = { openTerminal(s.id) }) { Text("Attach") }
                    IconButton(onClick = { ws.kill(s.id) }) {
                        Icon(Icons.Filled.Close, contentDescription = "Kill")
                    }
                }
            }
        }
    }

    if (browsing) {
        DirPickerDialog(ws, onSelect = {
            cwd = it
            browsing = false
        }, onDismiss = { browsing = false })
    }
}

@Composable
private fun ToolPicker(installed: List<ToolInfo>, selected: ToolInfo?, onPick: (ToolInfo) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }, Modifier.fillMaxWidth()) {
            Text(selected?.manifest?.name ?: if (installed.isEmpty()) "No tools installed" else "Pick a tool")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            installed.forEach { t ->
                DropdownMenuItem(text = { Text(t.manifest.name) }, onClick = {
                    onPick(t)
                    open = false
                })
            }
        }
    }
}

@Composable
private fun DirPickerDialog(ws: WsClient, onSelect: (String) -> Unit, onDismiss: () -> Unit) {
    val listing = ws.dirListing
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(listing?.path ?: "...", style = MaterialTheme.typography.titleSmall) },
        text = {
            Column {
                when (listing) {
                    null -> Text("Loading...")
                    else -> {
                        TextButton(onClick = { listing.parent?.let { ws.browse(it) } }) { Text(".. up") }
                        LazyColumn(Modifier.height(320.dp)) {
                            items(listing.items) { name ->
                                TextButton(onClick = { ws.browse(listing.path + "\\" + name) }) {
                                    Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { listing?.let { onSelect(it.path) } }, enabled = listing != null) {
                Text("Use this folder")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}
