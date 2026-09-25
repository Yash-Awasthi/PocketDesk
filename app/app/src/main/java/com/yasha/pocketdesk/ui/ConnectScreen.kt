package com.yasha.pocketdesk.ui

import com.yasha.pocketdesk.Wake
import kotlinx.coroutines.launch
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
import com.yasha.pocketdesk.Link
import com.yasha.pocketdesk.Pairing
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
        ws.connect(entry.url, entry.token, entry.pinnedFingerprint, entry.fallback)
    }

    androidx.compose.runtime.LaunchedEffect(ws.status) {
        if (ws.status == Status.Connected) {
            val w = ws.wakeInfo
            if (w != null) persist(servers.map { if (it.url == ws.activeUrl && it.wake != w) it.copy(wake = w) else it })
            onConnected()
        }
    }
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    androidx.compose.runtime.LaunchedEffect(Unit) {
        ws.events.collect { ev ->
            if (ev is RhEvent.TrustNeeded) trustFp = ev.fingerprint
        }
    }

    trustFp?.let { fp ->
        AlertDialog(
            onDismissRequest = { },
            title = { Text("⚠ Unverified certificate") },
            text = {
                Text(
                    "This address was typed by hand, so the connection is not pinned. " +
                        "Any device on the network could be presenting this certificate instead of your daemon — " +
                        "trusting it blindly opens you to a man-in-the-middle.\n\n" +
                        "SHA-256 fingerprint:\n" +
                        fp.chunked(2).joinToString(" ") + "\n\n" +
                        "Only trust it if this matches the fingerprint printed by the daemon on your PC. " +
                        "For a verified connection instead, pair with the QR code.",
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

    // A link can come from any app or web page, so it is shown before anything is saved.
    val pairing = Link.pendingPair
    if (pairing.isNotEmpty()) {
        AlertDialog(
            onDismissRequest = { Link.pendingPair = emptyList() },
            title = { Text("Pair with ${pairing.first().name}?") },
            text = {
                Text(
                    pairing.joinToString("\n") { it.url } +
                        (pairing.first().pinnedFingerprint?.let { "\n\nCertificate:\n" + it.chunked(2).joinToString(" ") } ?: "") +
                        "\n\nOnly accept a link you just scanned from your own PC.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val urls = pairing.map { it.url }.toSet()
                    persist(servers.filter { it.url !in urls } + pairing)
                    Link.pendingPair = emptyList()
                    startConnect(pairing.first())
                }) { Text("Pair and connect") }
            },
            dismissButton = { TextButton(onClick = { Link.pendingPair = emptyList() }) { Text("Cancel") } },
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
                        "Open https://localhost:8765/pair on the PC and scan the QR. The saved PC " +
                        "works on the same Wi-Fi and, through iroh, from any other network.",
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
                                    s.url.substringAfter("://").removeSuffix("/ws") + (if (s.fallback != null) " · anywhere" else ""),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            s.wake?.let { w ->
                                TextButton(onClick = {
                                    scope.launch {
                                        val n = Wake.send(w)
                                        android.widget.Toast.makeText(ctx,
                                            if (n > 0) "Wake sent. A PC on this network starts in about 20 s." else "Could not send on this network",
                                            android.widget.Toast.LENGTH_LONG).show()
                                    }
                                }) { Text("Wake") }
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
            // A PC that stopped answering keeps the app retrying; this frees the list again.
            if (ws.status == Status.Connecting || ws.status == Status.Reconnecting) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(if (ws.status == Status.Connecting) "Connecting…" else "Reconnecting…",
                        style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    TextButton(onClick = { ws.close() }) { Text("Stop") }
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
    // A pasted pairing link goes through the same confirmation as a scanned one.
    androidx.compose.runtime.LaunchedEffect(url) {
        val paired = Pairing.parse(url)
        if (paired.isNotEmpty()) {
            Link.pendingPair = paired
            onDismiss()
        }
    }
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
                    placeholder = { Text("ws://192.168.1.10:8765/ws · wss://… · iroh://… · pocketdesk://pair#…") },
                    singleLine = true,
                )
                OutlinedTextField(value = token, onValueChange = { token = it }, label = { Text("Token") }, singleLine = true)
            }
        },
        confirmButton = {
            TextButton(
                enabled = name.isNotBlank() && (url.startsWith("ws") || url.startsWith("iroh://")) && token.isNotBlank(),
                onClick = { onSave(ServerEntry(name.trim(), url.trim(), token.trim(), initial?.pinnedFingerprint, initial?.fallback)) },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
