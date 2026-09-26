package com.yasha.pocketdesk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yasha.pocketdesk.ChatItem
import com.yasha.pocketdesk.ChatSummary
import com.yasha.pocketdesk.ToolInfo
import com.yasha.pocketdesk.WsClient

@Composable
fun ChatScreen(ws: WsClient) {
    var openChatId by remember { mutableStateOf<String?>(null) }

    if (openChatId != null) {
        ChatConversation(ws, openChatId!!) { openChatId = null }
    } else {
        ChatList(ws) { openChatId = it }
    }
}

@Composable
private fun ChatList(ws: WsClient, openChat: (String) -> Unit) {
    var showCreate by remember { mutableStateOf(false) }
    val installed = ws.tools.filter { it.installed == true && it.manifest.chat }

    LazyColumn(
        Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Chats", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                IconButton(onClick = { ws.rescan() }) {
                    Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                }
            }
        }
        item {
            OutlinedButton(onClick = { showCreate = true }, Modifier.fillMaxWidth()) {
                Text("New chat")
            }
        }
        if (ws.chats.isEmpty()) {
            item { Text("No active chats", style = MaterialTheme.typography.bodySmall) }
        }
        items(ws.chats, key = { it.id }) { chat ->
            ChatCard(chat) { openChat(chat.id) }
        }
    }

    if (showCreate) {
        CreateChatDialog(ws, installed, onCreate = { showCreate = false }, onDismiss = { showCreate = false })
    }
}

@Composable
private fun ChatCard(chat: ChatSummary, onClick: () -> Unit) {
    Card(
        Modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(chat.harnessId, style = MaterialTheme.typography.titleMedium)
                if (chat.preview.isNotBlank()) {
                    Text(
                        chat.preview,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            val running = chat.state == "running"
            if (running) CircularProgressIndicator(Modifier.size(18.dp))
            else Text(chat.state, style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun CreateChatDialog(ws: WsClient, installed: List<ToolInfo>, onCreate: () -> Unit, onDismiss: () -> Unit) {
    var tool by remember { mutableStateOf<ToolInfo?>(installed.firstOrNull()) }
    var cwd by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }
    var toolOpen by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New chat") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Box {
                    OutlinedButton(onClick = { toolOpen = true }, Modifier.fillMaxWidth()) {
                        Text(tool?.manifest?.name ?: "Pick a tool")
                    }
                    DropdownMenu(expanded = toolOpen, onDismissRequest = { toolOpen = false }) {
                        installed.forEach { t ->
                            DropdownMenuItem(
                                text = { Text(t.manifest.name) },
                                onClick = { tool = t; toolOpen = false },
                            )
                        }
                    }
                }
                OutlinedTextField(
                    value = cwd,
                    onValueChange = { cwd = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Project folder") },
                    placeholder = { Text("blank = home directory") },
                    singleLine = true,
                )
                OutlinedTextField(
                    value = prompt,
                    onValueChange = { prompt = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("First message (optional)") },
                    placeholder = { Text("e.g. Fix the build errors") },
                    minLines = 2,
                    maxLines = 4,
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val t = tool ?: return@TextButton
                    ws.createChat(t.manifest.id, cwd.trim(), prompt.ifBlank { null })
                    onCreate()
                },
                enabled = tool != null,
            ) { Text("Start") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun ChatConversation(ws: WsClient, chatId: String, onClose: () -> Unit) {
    val transcript = ws.chatTranscript[chatId] ?: emptyList()
    val chatState = ws.chatStates[chatId] ?: "idle"
    val running = chatState == "running"
    val chat = ws.chats.firstOrNull { it.id == chatId }

    var input by remember { mutableStateOf("") }
    var modelMenuOpen by remember { mutableStateOf(false) }
    var customModelOpen by remember { mutableStateOf(false) }
    var customModel by remember { mutableStateOf("") }
    if (customModelOpen) {
        AlertDialog(
            onDismissRequest = { customModelOpen = false },
            title = { Text("Model name") },
            text = {
                OutlinedTextField(value = customModel, onValueChange = { customModel = it.trim() }, singleLine = true,
                    placeholder = { Text("e.g. gpt-5.5 or anthropic/claude-sonnet-5") })
            },
            confirmButton = {
                TextButton(onClick = {
                    if (customModel.isNotEmpty()) ws.chatModelSet(chatId, customModel)
                    customModelOpen = false
                }) { Text("Use") }
            },
            dismissButton = { TextButton(onClick = { customModelOpen = false }) { Text("Cancel") } },
        )
    }
    val listState = rememberLazyListState()

    // Attach on open so the daemon replays the transcript and streams deltas
    // (without attach only the creating client ever sees a chat's content).
    LaunchedEffect(chatId) {
        ws.attach(chatId)
        ws.modelList(chatId)
    }
    LaunchedEffect(chatId, ws.chatCurrentModel[chatId]) {
        ws.modelList(chatId)
    }

    // Auto-scroll to bottom when new items arrive
    LaunchedEffect(transcript.size) {
        if (transcript.isNotEmpty()) {
            listState.scrollToItem(transcript.lastIndex)
        }
    }

    Scaffold(
        topBar = {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onClose) {
                    Icon(Icons.Filled.Close, contentDescription = "Back")
                }
                Column(Modifier.weight(1f)) {
                    Text(chat?.harnessId ?: chatId, style = MaterialTheme.typography.titleMedium)
                    Text(
                        chatState,
                        style = MaterialTheme.typography.bodySmall,
                        color = if (running) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (running) {
                    IconButton(onClick = { ws.cancelChat(chatId) }) {
                        Icon(Icons.Filled.Close, contentDescription = "Stop", tint = MaterialTheme.colorScheme.error)
                    }
                }
                if (chat?.harnessId == "claude") {
                    var permOpen by remember { mutableStateOf(false) }
                    Box {
                        TextButton(onClick = { permOpen = true }) {
                            Text(PERMISSION_MODES.firstOrNull { it.first == ws.chatPermission[chatId] }?.second ?: "Permissions")
                        }
                        DropdownMenu(expanded = permOpen, onDismissRequest = { permOpen = false }) {
                            PERMISSION_MODES.forEach { (mode, label) ->
                                DropdownMenuItem(text = { Text(label) }, onClick = { ws.setChatPermission(chatId, mode); permOpen = false })
                            }
                        }
                    }
                }
                // Model picker — per-chat model selection (where the CLI offers it).
                val models = ws.chatModels[chatId] ?: emptyList()
                val custom = chatId in ws.chatModelCustom
                if (models.isNotEmpty() || custom) {
                    Box {
                        TextButton(onClick = { modelMenuOpen = true }) {
                            Text(ws.chatCurrentModel[chatId] ?: "model: default")
                        }
                        DropdownMenu(expanded = modelMenuOpen, onDismissRequest = { modelMenuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text("(default)") },
                                onClick = {
                                    ws.chatModelSet(chatId, null)
                                    modelMenuOpen = false
                                },
                            )
                            models.forEach { mdl ->
                                DropdownMenuItem(
                                    text = { Text(mdl) },
                                    onClick = {
                                        ws.chatModelSet(chatId, mdl)
                                        modelMenuOpen = false
                                    },
                                )
                            }
                            if (custom) {
                                DropdownMenuItem(
                                    text = { Text("Custom…") },
                                    onClick = {
                                        customModelOpen = true
                                        modelMenuOpen = false
                                    },
                                )
                            }
                        }
                    }
                }
            }
        },
        floatingActionButton = {
            if (!running && input.isNotBlank()) {
                FloatingActionButton(onClick = {
                    if (input.isNotBlank()) {
                        ws.sendChatMessage(chatId, input.trim())
                        input = ""
                    }
                }) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
                }
            }
        },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).imePadding()) {
            // Message list
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).padding(horizontal = 12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                items(transcript.size) { idx ->
                    val item = transcript[idx]
                    when (item) {
                        is ChatItem.User -> UserBubble(item.text)
                        is ChatItem.Assistant -> AssistantBubble(item.text, idx == transcript.lastIndex && running)
                        is ChatItem.Tool -> ToolBubble(item.name, item.detail)
                        is ChatItem.ToolResult -> ToolResultBubble(item.text)
                        is ChatItem.System -> SystemBubble(item.text)
                    }
                }
                item { Spacer(Modifier.height(4.dp)) }
            }

            // Input bar
            Row(
                Modifier.fillMaxWidth().padding(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Type a message...") },
                    singleLine = true,
                    enabled = !running,
                )
                Spacer(Modifier.width(8.dp))
                IconButton(
                    onClick = {
                        if (input.isNotBlank()) {
                            ws.sendChatMessage(chatId, input.trim())
                            input = ""
                        }
                    },
                    enabled = !running && input.isNotBlank(),
                ) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
                }
            }
        }
    }
}

@Composable
private fun UserBubble(text: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Text(
            text,
            Modifier
                .clip(RoundedCornerShape(12.dp, 12.dp, 4.dp, 12.dp))
                .background(MaterialTheme.colorScheme.primaryContainer)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            color = MaterialTheme.colorScheme.onPrimaryContainer,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
private fun AssistantBubble(text: String, streaming: Boolean) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
        Text(
            text + if (streaming) "..." else "",
            Modifier
                .clip(RoundedCornerShape(12.dp, 12.dp, 12.dp, 4.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
private fun ToolBubble(name: String, detail: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
        Text(
            "🔧 $name: $detail",
            Modifier
                .clip(RoundedCornerShape(8.dp))
                .background(MaterialTheme.colorScheme.tertiaryContainer)
                .padding(horizontal = 10.dp, vertical = 6.dp),
            color = MaterialTheme.colorScheme.onTertiaryContainer,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun ToolResultBubble(text: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
        Text(
            text,
            Modifier
                .clip(RoundedCornerShape(8.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                .padding(horizontal = 10.dp, vertical = 6.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun SystemBubble(text: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
        Text(
            text,
            Modifier.padding(vertical = 4.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelSmall,
        )
    }
}

/** Claude Code permission modes as the daemon names them; "ask" sends each prompt to this phone. */
private val PERMISSION_MODES = listOf(
    "ask" to "Ask on phone",
    "autopilot" to "Auto-accept edits",
    "readonly" to "Plan only",
    "yolo" to "Full access",
)
