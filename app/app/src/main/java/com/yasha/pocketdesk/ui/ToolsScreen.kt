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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yasha.pocketdesk.ToolInfo
import com.yasha.pocketdesk.WsClient

@Composable
fun ToolsScreen(ws: WsClient) {
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Coding tools", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            IconButton(onClick = { ws.rescan() }) {
                Icon(Icons.Filled.Refresh, contentDescription = "Rescan")
            }
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(ws.tools, key = { it.manifest.id }) { tool ->
                ToolCard(tool, ws)
            }
        }
    }
}

@Composable
private fun ToolCard(tool: ToolInfo, ws: WsClient) {
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
                        "${tool.manifest.bin} · $state",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                when {
                    tool.installing -> CircularProgressIndicator(Modifier.size(22.dp))
                    tool.installed == true -> Icon(
                        Icons.Filled.Check,
                        contentDescription = "Installed",
                        tint = MaterialTheme.colorScheme.primary,
                    )
                    else -> androidx.compose.material3.TextButton(onClick = { ws.install(tool.manifest.id) }) {
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
