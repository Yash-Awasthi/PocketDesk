package com.yasha.pocketdesk.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
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
import com.yasha.pocketdesk.AppEntry
import com.yasha.pocketdesk.RhEvent
import com.yasha.pocketdesk.ToolInfo
import com.yasha.pocketdesk.WsClient
import kotlinx.coroutines.delay

@Composable
fun ToolsScreen(ws: WsClient, openDesktop: () -> Unit, openTerminal: (String) -> Unit) {
    // One project folder for everything started from this screen: an IDE opens
    // it, a CLI tool runs in it.
    var cwd by remember { mutableStateOf("") }
    var browsing by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }

    LaunchedEffect(browsing) {
        if (browsing) ws.browse(cwd.ifBlank { null })
    }
    LaunchedEffect(query) {
        // The daemon searches its whole index, so let typing settle first.
        delay(250)
        ws.discoverApps(query.trim())
    }
    LaunchedEffect(Unit) {
        ws.events.collect { ev ->
            when (ev) {
                // A GUI app has no terminal: it is watched on the desktop view.
                is RhEvent.GuiOpened -> openDesktop()
                is RhEvent.Created -> openTerminal(ev.id)
                else -> {}
            }
        }
    }

    LazyColumn(
        Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Coding tools", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                IconButton(onClick = {
                    ws.rescan()
                    ws.discoverApps(query.trim(), refresh = true)
                }) {
                    Icon(Icons.Filled.Refresh, contentDescription = "Rescan")
                }
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = cwd,
                    onValueChange = { cwd = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Project folder") },
                    placeholder = { Text("blank = home directory") },
                    singleLine = true,
                )
                OutlinedButton(onClick = { browsing = true }) { Text("Browse") }
            }
        }
        items(ws.tools, key = { it.manifest.id }) { tool ->
            ToolCard(tool, ws, cwd)
        }
        item {
            Text("Everything installed", style = MaterialTheme.typography.titleLarge)
        }
        item {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Search apps and commands") },
                singleLine = true,
            )
        }
        items(ws.apps, key = { it.path }) { app ->
            AppCard(app, ws, cwd)
        }
    }

    if (browsing) {
        DirPickerDialog(
            ws = ws,
            onSelect = {
                cwd = it
                browsing = false
            },
            onDismiss = { browsing = false },
        )
    }
}

@Composable
private fun AppCard(app: AppEntry, ws: WsClient, cwd: String) {
    Card(Modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(app.name, style = MaterialTheme.typography.titleMedium)
                Text(
                    app.path,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            TextButton(onClick = {
                if (app.isGui) ws.guiOpenPath(app.path, cwd.trim()) else ws.createSessionAt(app.path, cwd.trim())
            }) {
                Text(if (app.isGui) "Open" else "Run")
            }
        }
    }
}

@Composable
private fun ToolCard(tool: ToolInfo, ws: WsClient, cwd: String) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(tool.manifest.name, style = MaterialTheme.typography.titleMedium)
                    val state = when {
                        tool.installing -> "installing..."
                        tool.installed == true -> tool.version?.let { "installed · $it" } ?: "installed"
                        else -> "not installed"
                    }
                    Text(
                        if (tool.manifest.isGui) state else "${tool.manifest.bin} · $state",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                when {
                    tool.installing -> CircularProgressIndicator(Modifier.size(22.dp))
                    tool.manifest.isGui -> if (tool.installed == true) {
                        TextButton(onClick = { ws.guiOpen(tool.manifest.id, cwd.trim()) }) {
                            Text("Open")
                        }
                    }
                    tool.installed == true -> Icon(
                        Icons.Filled.Check,
                        contentDescription = "Installed",
                        tint = MaterialTheme.colorScheme.primary,
                    )
                    else -> TextButton(onClick = { ws.install(tool.manifest.id) }) {
                        Text("Install")
                    }
                }
            }
            ws.progress[tool.manifest.id]?.let { lines ->
                Text(
                    lines.lines().takeLast(4).joinToString("\n"),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 4,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
