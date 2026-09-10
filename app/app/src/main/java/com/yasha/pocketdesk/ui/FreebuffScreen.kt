package com.yasha.pocketdesk.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
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
import com.yasha.pocketdesk.FbConfig
import com.yasha.pocketdesk.FbSkill
import com.yasha.pocketdesk.WsClient

/**
 * Freebuff control from the phone: app status, skills (view/run), allowlisted
 * config files (view/deep-merge edit), and login/logout. The auth token never
 * reaches the phone — only logged-in state and expiry.
 */
@Composable
fun FreebuffScreen(ws: WsClient) {
    var viewSkill by remember { mutableStateOf<FbSkill?>(null) }
    var skillContent by remember { mutableStateOf<String?>(null) }
    var runSkill by remember { mutableStateOf<FbSkill?>(null) }
    var runArgs by remember { mutableStateOf("") }
    var editConfig by remember { mutableStateOf<FbConfig?>(null) }
    var configContent by remember { mutableStateOf<String?>(null) }
    var configError by remember { mutableStateOf<String?>(null) }
    var confirmLogout by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        ws.fbStatus(); ws.fbSkillList(); ws.fbConfigList(); ws.fbAuthStatus()
    }

    LazyColumn(
        Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Freebuff", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                IconButton(onClick = { ws.fbStatus(); ws.fbSkillList(); ws.fbConfigList(); ws.fbAuthStatus() }) {
                    Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                }
            }
        }
        item {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("App: ${when (ws.fbRunning) { true -> "running"; false -> "stopped"; null -> "—" }}", style = MaterialTheme.typography.titleMedium)
                    Text(ws.fbProfile ?: "", style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        "Login: ${when (ws.fbAuthLoggedIn) { true -> "logged in"; false -> "logged out"; null -> "—" }}" +
                            (ws.fbAuthExpiresAt?.let { " · token expires ${it.take(10)}" } ?: ""),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { ws.fbAppOpen() }) { Text("Open") }
                        OutlinedButton(onClick = { ws.fbAppQuit() }) { Text("Quit") }
                        OutlinedButton(onClick = { confirmLogout = true }) { Text("Logout") }
                    }
                }
            }
        }
        item { Text("Skills (${ws.fbSkills.size})", style = MaterialTheme.typography.titleMedium) }
        items(ws.fbSkills, key = { it.name }) { skill ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text(skill.name, style = MaterialTheme.typography.titleSmall)
                    if (skill.description.isNotBlank()) {
                        Text(skill.description, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { viewSkill = skill; skillContent = null; ws.fbSkillGet(skill.name) }) { Text("View") }
                        TextButton(onClick = { runSkill = skill; runArgs = "" }) { Text("Run") }
                    }
                }
            }
        }
        item { Text("Configs (${ws.fbConfigs.size})", style = MaterialTheme.typography.titleMedium) }
        items(ws.fbConfigs, key = { it.name }) { cfg ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text(cfg.name, style = MaterialTheme.typography.titleSmall)
                    Text("${cfg.size} bytes", style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = { editConfig = cfg; configContent = null; configError = null; ws.fbConfigGet(cfg.name) }) { Text("View / Edit") }
                }
            }
        }
    }

    // ── Dialogs ──
    viewSkill?.let { skill ->
        AlertDialog(
            onDismissRequest = { viewSkill = null },
            title = { Text(skill.name) },
            text = {
                Text(skillContent ?: "Loading…", style = MaterialTheme.typography.bodySmall, maxLines = 14, overflow = TextOverflow.Ellipsis)
            },
            confirmButton = { TextButton(onClick = { viewSkill = null }) { Text("Close") } },
        )
    }
    runSkill?.let { skill ->
        AlertDialog(
            onDismissRequest = { runSkill = null },
            title = { Text("Run ${skill.name}") },
            text = {
                Column {
                    Text("Runs this skill's instructions as a new chat with Claude Code.", style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(value = runArgs, onValueChange = { runArgs = it }, label = { Text("Task (optional)") }, modifier = Modifier.fillMaxWidth())
                }
            },
            confirmButton = {
                TextButton(onClick = { ws.fbSkillRun(skill.name, "claude", runArgs.ifBlank { null }); runSkill = null }) { Text("Run") }
            },
            dismissButton = { TextButton(onClick = { runSkill = null }) { Text("Cancel") } },
        )
    }
    editConfig?.let { cfg ->
        AlertDialog(
            onDismissRequest = { editConfig = null },
            title = { Text("Edit ${cfg.name}") },
            text = {
                Column {
                    if (configError != null) Text(configError!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(
                        value = configContent ?: "",
                        onValueChange = { configContent = it },
                        label = { Text("JSON patch (deep-merged)") },
                        modifier = Modifier.fillMaxWidth(),
                        minLines = 4,
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val patch = configContent.orEmpty().trim()
                    try {
                        kotlinx.serialization.json.Json.parseToJsonElement(patch)
                        ws.fbConfigSet(cfg.name, patch)
                        editConfig = null
                    } catch (e: Exception) {
                        configError = "Invalid JSON: ${e.message}"
                    }
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { editConfig = null }) { Text("Cancel") } },
        )
    }
    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("Clear Freebuff login?") },
            text = { Text("Clears the app's saved login on the PC (a backup is kept). Restart the app to show the login screen again.") },
            confirmButton = {
                TextButton(onClick = { ws.fbAuthLogout(true); confirmLogout = false }) { Text("Logout + restart app") }
            },
            dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text("Cancel") } },
        )
    }
}