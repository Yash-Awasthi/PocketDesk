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
import com.yasha.pocketdesk.LINE_BREAK
import com.yasha.pocketdesk.RhEvent
import com.yasha.pocketdesk.ToolInfo
import com.yasha.pocketdesk.WsClient
import kotlinx.coroutines.delay

@Composable
fun ToolsScreen(ws: WsClient, openDesktop: () -> Unit, openTerminal: (String) -> Unit, openSsh: () -> Unit) {
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
    LaunchedEffect(Unit) { ws.runDoctor() }
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
                TextButton(onClick = openSsh) { Text("SSH") }
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
        item { GitSection(ws, cwd) }
        item { DoctorSection(ws) }
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

@Composable
private fun GitSection(ws: WsClient, cwd: String) {
    // The git panel works on the project folder chosen at the top of the screen.
    val status = ws.gitStatus
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Git", style = MaterialTheme.typography.titleLarge)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedButton(onClick = { ws.gitLoad(cwd.trim()) }, enabled = cwd.isNotBlank()) { Text("Load") }
            OutlinedButton(onClick = { ws.gitLog(cwd.trim()) }, enabled = status?.ok == true) { Text("Log") }
            OutlinedButton(onClick = { ws.gitDiff(cwd.trim()) }, enabled = status?.ok == true) { Text("Diff") }
        }
        when {
            status == null -> Text(
                "pick a project folder above, then Load",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            !status.ok -> Text(
                status.error ?: "not a git repository",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
            else -> {
                Text(
                    listOfNotNull(status.branch, status.upstream?.let { "↔ " + it }).joinToString(" "),
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (status.files.isEmpty()) {
                    Text("working tree clean", style = MaterialTheme.typography.bodySmall)
                } else {
                    for (f in status.files.take(30)) {
                        Text(
                            f.state.ifBlank { "·" } + "  " + f.path,
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
        if (ws.gitOutput.isNotBlank()) {
            Text(
                ws.gitOutput.lines().take(40).joinToString(LINE_BREAK),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun DoctorSection(ws: WsClient) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Doctor", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            OutlinedButton(onClick = { ws.runDoctor() }) { Text("Run checks") }
        }
        for (c in ws.doctorChecks) {
            Text(
                (if (c.ok) "✅" else "❌") + " " + c.name + " — " + c.detail,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            c.hint?.takeIf { !c.ok }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
