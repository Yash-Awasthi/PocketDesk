package com.yasha.pocketdesk.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yasha.pocketdesk.RhEvent
import com.yasha.pocketdesk.ServerBook
import com.yasha.pocketdesk.ServerEntry
import com.yasha.pocketdesk.Status
import com.yasha.pocketdesk.WsClient

@Composable
fun ConnectScreen(ws: WsClient, onConnected: () -> Unit) {
    val ctx = LocalContext.current
    val book = remember { ServerBook(ctx) }
    var servers by remember { mutableStateOf(book.load()) }
    var editing by remember { mutableStateOf<ServerEntry?>(null) }
    var adding by remember { mutableStateOf(false) }
    var trustFp by remember { mutableStateOf<String?>(null) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {}

    fun persist(list: List<ServerEntry>) {
        servers = list
        book.save(list)
    }

    fun startConnect(entry: ServerEntry) {
        if (Build.VERSION.SDK_INT >= 33) {
            permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        ws.connect(entry.url, entry.token, entry.pinnedFingerprint)
    }

    androidx.compose.runtime.LaunchedEffect(ws.status) {
        if (ws.status == Status.Connected) onConnected()
    }
    androidx.compose.runtime.LaunchedEffect(Unit) {
        ws.events.collect { ev ->
            if (ev is RhEvent.TrustNeeded) trustFp = ev.fingerprint
        }
    }

    trustFp?.let { fp ->
        AlertDialog(
            onDismissRequest = { },
            title = { Text("Unknown certificate") },
            text = {
                Text(
                    "The daemon's TLS certificate is not pinned yet.\n\n" +
                        "SHA-256 fingerprint:\n" +
                        fp.chunked(2).joinToString(" ") + "\n\n" +
                        "Compare it with the value printed by the daemon, then trust.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val updated = servers.map {
                        if (it.url == ws.activeUrl) it.copy(pinnedFingerprint = fp) else it
                    }
                    persist(updated)
                    ws.resolveTrust(true)
                    trustFp = null
                }) { Text("Trust and connect") }
            },
            dismissButton = {
                TextButton(onClick = {
                    ws.resolveTrust(false)
                    trustFp = null
                }) { Text("Reject") }
            },
        )
    }

    Scaffold(
        floatingActionButton = {
            FloatingActionButton(onClick = { adding = true }) {
                Icon(Icons.Filled.Add, contentDescription = "Add server")
            }
        },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("PocketDesk", style = MaterialTheme.typography.headlineMedium)
            if (servers.isEmpty()) {
                Text(
                    "No PCs saved yet. Tap + to add one. On the PC run: cd daemon && npm start\n\n" +
                        "Same Wi-Fi: ws://<pc-ip>:8765/ws\n" +
                        "Kilometers away: relay://<relay-host>:8790/<channel> — the PC dials OUT " +
                        "to the relay, so no port forwarding is needed. Start the PC side with " +
                        "RH_RELAY_PORT=8790 npm start.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(servers, key = { it.url }) { s ->
                    Card(Modifier.fillMaxWidth()) {
                        Row(
                            Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(s.name, style = MaterialTheme.typography.titleMedium)
                                Text(
                                    s.url,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            IconButton(onClick = { editing = s }) {
                                Icon(Icons.Filled.Settings, contentDescription = "Edit")
                            }
                            IconButton(onClick = { persist(servers - s) }) {
                                Icon(Icons.Filled.Close, contentDescription = "Delete")
                            }
                            TextButton(onClick = { startConnect(s) }, enabled = ws.status == Status.Disconnected) {
                                Text(if (ws.status == Status.Connecting || ws.status == Status.AwaitingTrust) "..." else "Connect")
                            }
                        }
                    }
                }
            }
            ws.lastError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        }
    }

    val showForm = adding || editing != null
    if (showForm) {
        ServerFormDialog(
            initial = editing,
            onSave = { entry ->
                persist(if (editing != null) servers.map { if (it == editing) entry else it } else servers + entry)
                adding = false
                editing = null
            },
            onDismiss = {
                adding = false
                editing = null
            },
        )
    }
}

@Composable
private fun ServerFormDialog(initial: ServerEntry?, onSave: (ServerEntry) -> Unit, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf(initial?.name ?: "") }
    var url by remember { mutableStateOf(initial?.url ?: "") }
    var token by remember { mutableStateOf(initial?.token ?: "") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (initial == null) "Add server" else "Edit server") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, singleLine = true)
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it },
                    label = { Text("URL") },
                    placeholder = { Text("ws://192.168.1.10:8765/ws · wss://… · relay://host:8790/channel") },
                    singleLine = true,
                )
                OutlinedTextField(value = token, onValueChange = { token = it }, label = { Text("Token") }, singleLine = true)
            }
        },
        confirmButton = {
            TextButton(
                enabled = name.isNotBlank() && url.startsWith("ws") && token.isNotBlank(),
                onClick = { onSave(ServerEntry(name.trim(), url.trim(), token.trim(), initial?.pinnedFingerprint)) },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
