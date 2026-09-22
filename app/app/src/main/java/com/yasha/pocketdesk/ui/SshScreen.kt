package com.yasha.pocketdesk.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
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
import com.yasha.pocketdesk.SSH_SERVERS
import com.yasha.pocketdesk.SshProfile
import com.yasha.pocketdesk.WsClient

/**
 * Profiles, keys, known host keys and the daemon's own SSH listeners. The
 * connect secret is asked for per connect and never stored on a profile.
 */
@Composable
fun SshScreen(ws: WsClient, onClose: () -> Unit) {
    var name by remember { mutableStateOf("") }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("22") }
    var user by remember { mutableStateOf("") }
    var keyId by remember { mutableStateOf<String?>(null) }
    var keyName by remember { mutableStateOf("") }
    var keyPass by remember { mutableStateOf("") }
    var algo by remember { mutableStateOf("ed25519") }
    var banner by remember { mutableStateOf<String?>(null) }
    var connectTarget by remember { mutableStateOf<Pair<SshProfile, String>?>(null) }

    LaunchedEffect(Unit) { ws.sshRefresh() }
    LaunchedEffect(Unit) {
        ws.events.collect { ev ->
            when (ev) {
                is RhEvent.HostKeySeen -> banner = if (ev.changed) {
                    "HOST KEY CHANGED for ${ev.host} — now ${ev.fingerprint}. The connection was refused."
                } else {
                    "New host key trusted for ${ev.host}: ${ev.fingerprint}. Confirm it out of band."
                }
                is RhEvent.SshConnect -> banner = ev.detail
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
                Text("SSH", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                TextButton(onClick = { ws.sshRefresh() }) { Text("Refresh") }
                TextButton(onClick = onClose) { Text("Back") }
            }
        }
        banner?.let { text ->
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) {
                        Text(text, style = MaterialTheme.typography.bodyMedium)
                        TextButton(onClick = { banner = null }) { Text("Dismiss") }
                    }
                }
            }
        }

        item { Text("Profiles", style = MaterialTheme.typography.titleMedium) }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Name") }, singleLine = true)
                OutlinedTextField(host, { host = it }, Modifier.fillMaxWidth(), label = { Text("Host") }, singleLine = true)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedTextField(port, { port = it }, Modifier.weight(1f), label = { Text("Port") }, singleLine = true)
                    OutlinedTextField(user, { user = it }, Modifier.weight(2f), label = { Text("Username") }, singleLine = true)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedButton(onClick = { keyId = null }, enabled = keyId != null) { Text("Password auth") }
                    for (k in ws.sshKeys) {
                        OutlinedButton(onClick = { keyId = k.id }, enabled = keyId != k.id) { Text(k.name) }
                    }
                }
                OutlinedButton(
                    onClick = {
                        ws.profileCreate(name.ifBlank { host }, host.trim(), port.toIntOrNull() ?: 22, user.trim(), keyId)
                        name = ""
                        host = ""
                        user = ""
                    },
                    enabled = host.isNotBlank() && user.isNotBlank(),
                ) { Text("Add profile") }
            }
        }
        items(ws.sshProfiles.size, key = { ws.sshProfiles[it].id }) { i ->
            val p = ws.sshProfiles[i]
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(p.name, style = MaterialTheme.typography.titleMedium)
                    Text(
                        "${p.username}@${p.host}:${p.port} · ${if (p.keyId != null) "key" else "password"}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (proto in listOf("ssh", "sftp", "vnc")) {
                            TextButton(onClick = {
                                if (proto == "vnc") ws.profileConnect(p.id, proto, null, false)
                                else connectTarget = p to proto
                            }) { Text(proto) }
                        }
                        TextButton(onClick = { ws.profileDelete(p.id) }) { Text("Delete") }
                    }
                }
            }
        }

        item { Text("Keys", style = MaterialTheme.typography.titleMedium) }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (a in listOf("ed25519", "ecdsa", "rsa")) {
                        OutlinedButton(onClick = { algo = a }, enabled = algo != a) { Text(a) }
                    }
                }
                OutlinedTextField(keyName, { keyName = it }, Modifier.fillMaxWidth(), label = { Text("Key name") }, singleLine = true)
                OutlinedTextField(keyPass, { keyPass = it }, Modifier.fillMaxWidth(), label = { Text("Passphrase (optional)") }, singleLine = true)
                OutlinedButton(onClick = {
                    ws.sshKeyGenerate(algo, keyName.trim(), keyPass.ifBlank { null })
                    keyName = ""
                    keyPass = ""
                }) { Text("Generate key") }
            }
        }
        ws.lastGeneratedKey?.let { pub ->
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) {
                        Text("Paste into the host's authorized_keys", style = MaterialTheme.typography.bodySmall)
                        Text(pub, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
        items(ws.sshKeys.size, key = { ws.sshKeys[it].id }) { i ->
            val k = ws.sshKeys[i]
            Card(Modifier.fillMaxWidth()) {
                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("${k.name} · ${k.type}", style = MaterialTheme.typography.bodyMedium)
                        Text(
                            k.fingerprint,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    TextButton(onClick = { ws.sshKeyDelete(k.id) }) { Text("Delete") }
                }
            }
        }

        item { Text("Known host keys", style = MaterialTheme.typography.titleMedium) }
        if (ws.knownHosts.isEmpty()) {
            item { Text("no hosts seen yet", style = MaterialTheme.typography.bodySmall) }
        }
        items(ws.knownHosts.size, key = { ws.knownHosts[it].keyId }) { i ->
            val h = ws.knownHosts[i]
            Column {
                Text(h.keyId, style = MaterialTheme.typography.bodyMedium)
                Text(
                    "${h.type} · ${h.fingerprint}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        item { Text("SSH servers on the PC", style = MaterialTheme.typography.titleMedium) }
        item {
            Text(
                "These bind on the PC. Loopback only unless you mean to expose them to the LAN.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        items(SSH_SERVERS.size, key = { SSH_SERVERS[it] }) { i ->
            val kind = SSH_SERVERS[i]
            val stat = ws.sshServerStats[kind]
            val defaultPort = if (kind == "bastion") 2223 else 2222
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(kind, style = MaterialTheme.typography.titleMedium)
                    Text(
                        if (stat?.running == true) {
                            "running on ${stat.port} · ${stat.activeSessions} sessions · ${stat.totalUsers} users"
                        } else {
                            "stopped"
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        TextButton(onClick = { ws.serverStart(kind, defaultPort, "127.0.0.1") }) { Text("Start") }
                        TextButton(onClick = { ws.serverStop(kind) }) { Text("Stop") }
                    }
                }
            }
        }
    }

    connectTarget?.let { (profile, proto) ->
        SecretDialog(
            title = if (profile.keyId != null) {
                "Passphrase for ${profile.name}"
            } else {
                "Password for ${profile.username}@${profile.host}"
            },
            onDismiss = { connectTarget = null },
            onConfirm = { secret ->
                ws.profileConnect(profile.id, proto, secret, profile.keyId != null)
                connectTarget = null
            },
        )
    }
}

@Composable
private fun SecretDialog(title: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var secret by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { OutlinedTextField(secret, { secret = it }, Modifier.fillMaxWidth(), singleLine = true) },
        confirmButton = { TextButton(onClick = { onConfirm(secret) }) { Text("Connect") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
