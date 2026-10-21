package com.yasha.pocketdesk.ui

import android.app.KeyguardManager
import android.content.Context
import android.hardware.biometrics.BiometricManager.Authenticators
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yasha.pocketdesk.SavedAccount
import com.yasha.pocketdesk.WsClient

/** Agents whose logins the daemon can save and switch; the ids match their manifests. */
val ACCOUNT_AGENTS = setOf("claude", "codex", "gemini", "cursor", "antigravity")

/**
 * Runs [action] once the phone owner proves it is them (fingerprint, face or screen lock), for steps
 * that lose something: logging out, forgetting a saved login. A phone with no screen lock runs it directly.
 */
fun withOwner(ctx: Context, title: String, action: () -> Unit) {
    if (ctx.getSystemService(KeyguardManager::class.java)?.isDeviceSecure != true) { action(); return }
    BiometricPrompt.Builder(ctx)
        .setTitle(title)
        .setAllowedAuthenticators(Authenticators.BIOMETRIC_WEAK or Authenticators.DEVICE_CREDENTIAL)
        .build()
        .authenticate(CancellationSignal(), ctx.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = action()
        })
}

/**
 * The account an agent is signed in with on the PC and the ones saved there. Switching asks first and
 * keeps the replaced login; forgetting one needs the owner's fingerprint. Tokens stay on the PC.
 */
@Composable
fun AccountsSection(ws: WsClient, agent: String, name: String) {
    val ctx = LocalContext.current
    val a = ws.agentAccounts[agent]
    var switching by remember { mutableStateOf<SavedAccount?>(null) }
    var saving by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(agent) { ws.accountsList(agent) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Accounts", style = MaterialTheme.typography.titleMedium)
        Text(
            when {
                a == null -> "Checking…"
                !a.signedIn -> "Signed out on the PC"
                else -> "Signed in: " + (a.email ?: a.saved.firstOrNull { it.current }?.label ?: "account not saved yet")
            },
            style = MaterialTheme.typography.bodyMedium,
        )
        a?.saved?.forEach { s ->
            Card(Modifier.fillMaxWidth()) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(s.label + if (s.current) "  · current" else "", style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        s.email?.takeIf { it != s.label }?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    if (!s.current) TextButton(onClick = { switching = s }) { Text("Switch") }
                    TextButton(onClick = { withOwner(ctx, "Forget ${s.label} on the PC?") { ws.accountForget(agent, s.id) } }) {
                        Text("Forget", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
        if (a?.signedIn == true && a.saved.none { it.current }) {
            OutlinedButton(onClick = { saving = a.email ?: "" }) { Text("Save this account for switching") }
        }
    }
    switching?.let { s ->
        AlertDialog(
            onDismissRequest = { switching = null },
            title = { Text("Switch $name to ${s.label}?") },
            text = { Text("The account signed in now is saved first, so you can switch back. Close $name on the PC before switching if it is open.") },
            confirmButton = { TextButton(onClick = { ws.accountSwitch(agent, s.id); switching = null }) { Text("Switch") } },
            dismissButton = { TextButton(onClick = { switching = null }) { Text("Cancel") } },
        )
    }
    saving?.let { initial ->
        var label by remember { mutableStateOf(initial) }
        AlertDialog(
            onDismissRequest = { saving = null },
            title = { Text("Save this account") },
            text = { OutlinedTextField(label, { label = it }, singleLine = true, label = { Text("Name") }) },
            confirmButton = { TextButton(onClick = { ws.accountSave(agent, label.trim()); saving = null }, enabled = label.isNotBlank()) { Text("Save") } },
            dismissButton = { TextButton(onClick = { saving = null }) { Text("Cancel") } },
        )
    }
}
