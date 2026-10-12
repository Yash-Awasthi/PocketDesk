package com.yasha.pocketdesk.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
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

/** Shown when the PC requires a connection password before it will accept this device. */
@Composable
fun ConnectionPasswordDialog(ws: WsClient) {
    if (!ws.passwordNeeded) return
    var pw by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = {},
        title = { Text("Connection password") },
        text = {
            OutlinedTextField(
                value = pw,
                onValueChange = { pw = it },
                label = { Text("Password set on the PC") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            )
        },
        confirmButton = { TextButton(onClick = { ws.submitConnectionPassword(pw) }, enabled = pw.isNotEmpty()) { Text("Connect") } },
        dismissButton = { TextButton(onClick = { ws.dismissPassword() }) { Text("Cancel") } },
    )
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
