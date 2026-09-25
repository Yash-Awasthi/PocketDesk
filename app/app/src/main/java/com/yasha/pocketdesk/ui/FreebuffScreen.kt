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
 * Freebuff control from the phone: app status, accounts, skills (view/run) and
 * allowlisted config files (view/deep-merge edit). Session tokens never reach
 * the phone — only account email and name.
 */
@Composable
fun FreebuffScreen(ws: WsClient, openDesktop: () -> Unit) {
    var viewSkill by remember { mutableStateOf<FbSkill?>(null) }
    var skillContent by remember { mutableStateOf<String?>(null) }
    var runSkill by remember { mutableStateOf<FbSkill?>(null) }
    var runArgs by remember { mutableStateOf("") }
    var editConfig by remember { mutableStateOf<FbConfig?>(null) }
    var configContent by remember { mutableStateOf<String?>(null) }
    var configError by remember { mutableStateOf<String?>(null) }

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
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { ws.fbAppOpen() }) { Text("Open") }
                        OutlinedButton(onClick = { ws.fbAppQuit() }) { Text("Quit") }
                    }
                    FreebuffAccounts(ws, openDesktop)
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
}

/**
 * Signed-in Freebuff account plus every account used before on this PC. Switch
 * swaps the saved session in and reopens the app; Add account signs out and
 * opens the Desktop view to finish the login in the app.
 */
@Composable
fun FreebuffAccounts(ws: WsClient, openDesktop: () -> Unit) {
    var confirm by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { ws.fbAuthStatus(); ws.fbAccountsList() }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            when (ws.fbAuthLoggedIn) {
                true -> "Signed in: ${ws.fbAuthEmail ?: "unknown account"}"
                false -> "Signed out"
                null -> "Account: checking…"
            },
            style = MaterialTheme.typography.bodyMedium,
        )
        ws.fbAccounts.filter { !it.current }.forEach { acc ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(acc.email, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f),
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                TextButton(onClick = { ws.fbAccountSwitch(acc.email) }) { Text("Switch") }
                TextButton(onClick = { confirm = "forget:${acc.email}" }) { Text("Forget") }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { confirm = "add" }) { Text("Add account") }
            if (ws.fbAuthLoggedIn == true) OutlinedButton(onClick = { confirm = "logout" }) { Text("Log out") }
        }
    }
    confirm?.let { op ->
        val forget = op.startsWith("forget:")
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text(when { forget -> "Forget ${op.removePrefix("forget:")}?"; op == "add" -> "Add a Freebuff account?"; else -> "Log out of Freebuff?" }) },
            text = {
                Text(when {
                    forget -> "Removes its saved session from the PC. Signing in to it again needs the browser."
                    op == "add" -> "Freebuff signs out and reopens at its login screen; the current account stays saved for Switch. Finish the login in the Desktop view."
                    else -> "Freebuff restarts signed out. The account stays saved, so Switch brings it back."
                })
            },
            confirmButton = {
                TextButton(onClick = {
                    when {
                        forget -> ws.fbAccountForget(op.removePrefix("forget:"))
                        op == "add" -> { ws.fbAuthLogout(); openDesktop() }
                        else -> ws.fbAuthLogout()
                    }
                    confirm = null
                }) { Text(if (forget) "Forget" else "Continue") }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Cancel") } },
        )
    }
}
