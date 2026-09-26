package com.yasha.pocketdesk.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.yasha.pocketdesk.WsClient

/** Daemon action names with their menu labels. */
val POWER_ACTIONS = listOf(
    "lock" to "Lock PC",
    "signout" to "Sign out",
    "sleep" to "Sleep",
    "restart" to "Restart",
    "shutdown" to "Shut down",
)

@Composable
fun PowerConfirmDialog(ws: WsClient, action: String, onDismiss: () -> Unit) {
    val label = POWER_ACTIONS.firstOrNull { it.first == action }?.second ?: action
    val note = when (action) {
        "lock" -> "The PC goes to its lock screen. Desktop viewing pauses until someone signs in."
        "signout" -> "Programs on the PC close without saving and running agents stop."
        "sleep" -> "The PC goes to sleep. Wake it again with Wake-on-LAN from the PC list."
        "restart" -> "The PC restarts in 5 seconds. The app reconnects once PocketDesk is running again, which needs a sign-in unless it runs as a service."
        else -> "The PC shuts down in 5 seconds. Wake-on-LAN can start it again if the PC supports it."
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("$label?") },
        text = { Text(note) },
        confirmButton = { TextButton(onClick = { ws.pcPower(action); onDismiss() }) { Text(label) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Row of power buttons for the Tools screen. */
@Composable
fun PowerRow(ws: WsClient) {
    var confirm by remember { mutableStateOf<String?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("PC power", style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            POWER_ACTIONS.take(3).forEach { (a, l) -> OutlinedButton(onClick = { confirm = a }) { Text(l) } }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            POWER_ACTIONS.drop(3).forEach { (a, l) -> OutlinedButton(onClick = { confirm = a }) { Text(l) } }
        }
    }
    confirm?.let { PowerConfirmDialog(ws, it) { confirm = null } }
}

/** Turn on or off the authenticator code a new device needs before it may pair with this PC. */
@Composable
fun TwoFactorSection(ws: WsClient) {
    val ctx = LocalContext.current
    LaunchedEffect(Unit) { ws.totp("status") }
    var code by remember { mutableStateOf("") }
    val offer = ws.totpOffer
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Two-factor pairing", style = MaterialTheme.typography.titleMedium)
        Text(
            when (ws.totpEnabled) {
                true -> "On: pairing a new device also needs a code from your authenticator app. Paired devices are not asked."
                false -> "Off: the pairing QR alone is enough to add a device."
                null -> "Checking…"
            },
            style = MaterialTheme.typography.bodySmall,
        )
        if (offer != null) {
            Text("Add this key to an authenticator app, then enter the code it shows.", style = MaterialTheme.typography.bodySmall)
            Text(offer.first.chunked(4).joinToString(" "), fontFamily = FontFamily.Monospace)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedButton(onClick = {
                    runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(offer.second))) }
                }) { Text("Open authenticator") }
                OutlinedButton(onClick = {
                    ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("key", offer.first))
                }) { Text("Copy key") }
            }
        }
        if (offer != null || ws.totpEnabled == true) {
            OutlinedTextField(
                value = code,
                onValueChange = { code = it.filter(Char::isDigit).take(6) },
                label = { Text("6-digit code") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            )
        }
        ws.totpError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        when {
            offer != null -> Button(onClick = { ws.totp("enable", code); code = "" }, enabled = code.length == 6) { Text("Turn on") }
            ws.totpEnabled == true -> OutlinedButton(onClick = { ws.totp("disable", code); code = "" }, enabled = code.length == 6) { Text("Turn off") }
            ws.totpEnabled == false -> Button(onClick = { ws.totp("setup") }) { Text("Set up") }
        }
    }
}

/** Shown when the PC refused to pair this device without an authenticator code. */
@Composable
fun PairCodeDialog(ws: WsClient) {
    if (!ws.totpNeeded) return
    var code by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = {},
        title = { Text("Two-factor code") },
        text = {
            OutlinedTextField(
                value = code,
                onValueChange = { code = it.filter(Char::isDigit).take(6) },
                label = { Text("Code from your authenticator app") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            )
        },
        confirmButton = { TextButton(onClick = { ws.pairWithCode(code) }, enabled = code.length == 6) { Text("Pair") } },
        dismissButton = { TextButton(onClick = { ws.dismissPairCode() }) { Text("Cancel") } },
    )
}
