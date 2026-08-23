package com.yasha.pocketdesk.ui

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.yasha.pocketdesk.Status
import com.yasha.pocketdesk.WsClient

@Composable
fun ConnectScreen(ws: WsClient, onConnected: () -> Unit) {
    val ctx = LocalContext.current
    val prefs = remember { ctx.getSharedPreferences("pocketdesk", Context.MODE_PRIVATE) }
    var host by remember { mutableStateOf(prefs.getString("host", "") ?: "") }
    var token by remember { mutableStateOf(prefs.getString("token", "") ?: "") }

    LaunchedEffect(ws.status) {
        if (ws.status == Status.Connected) onConnected()
    }

    Column(
        Modifier.fillMaxSize().padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("PocketDesk", style = MaterialTheme.typography.headlineMedium)
        OutlinedTextField(
            value = host,
            onValueChange = { host = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Daemon URL") },
            placeholder = { Text("ws://192.168.1.10:8765/ws") },
            singleLine = true,
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Token") },
            singleLine = true,
        )
        Button(
            onClick = {
                prefs.edit().putString("host", host.trim()).putString("token", token.trim()).apply()
                ws.connect(host.trim(), token.trim())
            },
            enabled = host.isNotBlank() && token.isNotBlank() && ws.status != Status.Connecting,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (ws.status == Status.Connecting) "Connecting..." else "Connect")
        }
        ws.lastError?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.weight(1f))
        Text(
            "PC: cd daemon && npm start — the token prints in its console.",
            style = MaterialTheme.typography.bodySmall,
        )
    }
}
