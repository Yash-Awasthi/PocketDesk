package com.yasha.pocketdesk.ui

import androidx.compose.foundation.background
import androidx.compose.material3.FilterChip
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
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
import com.yasha.pocketdesk.HistoryEntry
import com.yasha.pocketdesk.RhEvent
import com.yasha.pocketdesk.ToolInfo
import com.yasha.pocketdesk.WsClient

@Composable
fun ChatScreen(ws: WsClient, openTerminal: (String) -> Unit) {
    var openChatId by remember { mutableStateOf<String?>(null) }
    // A started or resumed chat opens straight away, also when another screen started it; a
    // conversation resumed in a terminal opens that terminal.
    LaunchedEffect(ws.pendingChat) { ws.pendingChat?.let { ws.historyOpen = null; openChatId = it; ws.pendingChat = null } }
    LaunchedEffect(Unit) {
        ws.events.collect { ev -> if (ev is RhEvent.Created) { ws.historyOpen = null; openTerminal(ev.id) } }
    }
    val reading = ws.historyOpen
    when {
        openChatId != null -> ChatConversation(ws, openChatId!!) { openChatId = null }
        reading != null -> HistoryConversation(ws, reading.first, reading.second) { ws.historyOpen = null }
        else -> ChatList(ws) { openChatId = it }
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
        historySection(ws)
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
    LaunchedEffect(chatId) { ws.attach(chatId) }
    androidx.compose.runtime.DisposableEffect(chatId) {
        ws.viewingChat = chatId
        onDispose { if (ws.viewingChat == chatId) ws.viewingChat = null }
    }
    // Model and permission mode for the next message only; null keeps the chat's own setting.
    var nextModel by remember { mutableStateOf<String?>(null) }
    var nextMode by remember { mutableStateOf<String?>(null) }
    fun send() {
        if (input.isBlank()) return
        ws.sendChatMessage(chatId, input.trim(), nextModel, nextMode)
        input = ""; nextModel = null; nextMode = null
    }
    LaunchedEffect(chatId, ws.chatCurrentModel[chatId]) { ws.modelList(chatId) }

    // Follows new items and the streaming growth of the last one.
    LaunchedEffect(transcript.size, transcript.lastOrNull()) {
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
                            Text(PERMISSION_MODES.firstOrNull { it.first == ws.chatPermission[chatId] }?.second
                                ?: ws.chatInfo[chatId]?.permissionMode?.let { "PC: $it" } ?: "Permissions")
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
                            // Claude's report is what the last turn ran with, which a one-message model may have changed.
                            Text(ws.chatCurrentModel[chatId] ?: ws.chatInfo[chatId]?.model?.let { "last: $it" } ?: "model: default")
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
                // Approvals for this chat sit where the agent stopped, not in the overlay.
                val waiting = ws.proposals.filter { it.owner == chatId }
                items(waiting.size) { i -> ProposalCard(ws, waiting[i]) }
                item { Spacer(Modifier.height(4.dp)) }
            }

            SlashSuggestions(input, ws.chatInfo[chatId]) { input = "/$it " }
            NextMessageChips(
                models = ws.chatModels[chatId].orEmpty(),
                custom = chatId in ws.chatModelCustom,
                modes = chat?.harnessId == "claude",
                model = nextModel, mode = nextMode,
                onModel = { nextModel = it }, onMode = { nextMode = it },
            )
            // Input bar
            Row(
                Modifier.fillMaxWidth().padding(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = { input = "/" }, enabled = !running, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 4.dp)) {
                    Text("/", style = MaterialTheme.typography.titleLarge)
                }
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Message, or / for commands") },
                    singleLine = true,
                    enabled = !running,
                )
                Spacer(Modifier.width(8.dp))
                IconButton(
                    onClick = { send() },
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

private val AGENT_NAMES = mapOf(
    "claude" to "Claude Code", "codex" to "Codex", "copilot" to "Copilot", "cline" to "Cline",
    "roo" to "Roo Code", "cursor" to "Cursor", "antigravity" to "Antigravity",
)

/** "Claude Code · VS Code", or just the agent when it is its own app. */
private fun HistoryEntry.label(): String {
    val agentName = AGENT_NAMES[agent] ?: agent
    return if (app.isEmpty() || app == agentName) agentName else "$agentName · $app"
}

/** Conversations every agent saved on the PC, filtered by agent and app. */
private fun androidx.compose.foundation.lazy.LazyListScope.historySection(ws: WsClient) {
    item {
        var picked by remember { mutableStateOf(false) }
        var chosen by remember { mutableStateOf<String?>(null) }
        LaunchedEffect(Unit) { ws.historyList() }
        val groups = ws.history.map { it.label() }.distinct()
        // Claude Code first: until a chip is tapped, the list opens on its conversations.
        val group = if (picked) chosen else groups.firstOrNull { it.startsWith("Claude Code") }
        fun pick(g: String?) { picked = true; chosen = g }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("On this PC", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                IconButton(onClick = { ws.historyList() }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh history") }
            }
            if (groups.size > 1) Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip(selected = group == null, onClick = { pick(null) }, label = { Text("All") })
                groups.forEach { g -> FilterChip(selected = group == g, onClick = { pick(g) }, label = { Text(g) }) }
            }
            val shown = ws.history.filter { group == null || it.label() == group }
            if (shown.isEmpty()) Text("No saved conversations found", style = MaterialTheme.typography.bodySmall)
            shown.take(100).forEach { e ->
                Card(Modifier.fillMaxWidth().clickable { ws.historyGet(e) }) {
                    Column(Modifier.padding(12.dp)) {
                        Text(e.title.ifBlank { "(untitled)" }, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(
                            listOfNotNull(e.label(), e.cwd.takeIf { it.isNotEmpty() }?.let(::lastSegment), e.updated.takeIf { it > 0 }?.let(::shortDate)).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

private fun lastSegment(p: String) = p.trimEnd('\\', '/').substringAfterLast('\\').substringAfterLast('/')

private fun shortDate(ms: Long): String =
    java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(java.util.Date(ms))

/** A saved conversation, read-only; Claude Code and Codex ones continue here or in their terminal UI. */
@Composable
private fun HistoryConversation(ws: WsClient, e: HistoryEntry, items: List<ChatItem>, onClose: () -> Unit) {
    androidx.activity.compose.BackHandler(onBack = onClose)
    val listState = rememberLazyListState()
    LaunchedEffect(items.size) { if (items.isNotEmpty()) listState.scrollToItem(items.lastIndex) }
    val ide = e.gui?.let { id -> ws.tools.firstOrNull { it.manifest.id == id && it.installed == true } }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onClose) { Icon(Icons.Filled.Close, contentDescription = "Back") }
            Column(Modifier.weight(1f)) {
                Text(e.title.ifBlank { e.label() }, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(listOf(e.label(), e.cwd).filter { it.isNotEmpty() }.joinToString(" · "), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        LazyColumn(state = listState, modifier = Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (items.isEmpty()) item { Text("Loading…", style = MaterialTheme.typography.bodySmall) }
            items(items.size) { i ->
                when (val it = items[i]) {
                    is ChatItem.User -> UserBubble(it.text)
                    is ChatItem.Assistant -> AssistantBubble(it.text, false)
                    is ChatItem.Tool -> ToolBubble(it.name, it.detail)
                    is ChatItem.ToolResult -> ToolResultBubble(it.text)
                    is ChatItem.System -> SystemBubble(it.text)
                }
            }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (e.resumable && e.inUse()) Text("Still in use on the PC: continue it there, or here once it is closed.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.align(Alignment.CenterVertically))
            else if (e.resumable) {
                androidx.compose.material3.Button(onClick = { ws.historyResume(e, terminal = false) }) { Text("Continue in chat") }
                OutlinedButton(onClick = { ws.historyResume(e, terminal = true) }) { Text("Resume in terminal") }
            }
            if (ide != null) OutlinedButton(onClick = { ws.guiOpen(ide.manifest.id, e.cwd) }) { Text("Open in ${ide.manifest.name}") }
        }
    }
}

/**
 * While the input is a bare "/word", the commands that start with it: the daemon's own first (they win
 * over an agent command of the same name), then the agent's commands and skills.
 */
@Composable
private fun SlashSuggestions(input: String, info: com.yasha.pocketdesk.ChatInfo?, onPick: (String) -> Unit) {
    if (!input.startsWith("/") || input.contains(' ')) return
    val q = input.drop(1).lowercase()
    val own = info?.pocketdesk.orEmpty().filter { it.first.startsWith(q) }
    val ownNames = own.map { it.first }.toSet()
    val agent = info?.commands.orEmpty().filter { it !in ownNames && (it.lowercase().startsWith(q) || it.substringAfter(':').lowercase().startsWith(q)) }
    if (own.isEmpty() && agent.isEmpty()) {
        Text(if (info == null) "Commands appear once the chat has started on the PC" else "No command matches",
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp))
        return
    }
    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 220.dp).padding(horizontal = 8.dp)) {
        items(own.size) { i ->
            val (name, desc) = own[i]
            SlashRow("/$name", "PocketDesk · $desc") { onPick(name) }
        }
        items(agent.size) { i -> SlashRow("/${agent[i]}", "agent") { onPick(agent[i]) } }
    }
}

@Composable
private fun SlashRow(name: String, note: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(name, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(note, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * "Next message" choices: a model and a permission mode for the coming message only; the header
 * menus keep setting the chat's own defaults. Shown only where the agent offers either.
 */
@Composable
private fun NextMessageChips(
    models: List<String>, custom: Boolean, modes: Boolean,
    model: String?, mode: String?, onModel: (String?) -> Unit, onMode: (String?) -> Unit,
) {
    if (models.isEmpty() && !custom && !modes) return
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Next message:", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (models.isNotEmpty()) {
            var open by remember { mutableStateOf(false) }
            Box {
                FilterChip(selected = model != null, onClick = { open = true },
                    label = { Text(when (model) { null -> "chat model"; "" -> "default"; else -> model }) })
                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    DropdownMenuItem(text = { Text("Chat's model") }, onClick = { onModel(null); open = false })
                    DropdownMenuItem(text = { Text("CLI default") }, onClick = { onModel(""); open = false })
                    models.forEach { m -> DropdownMenuItem(text = { Text(m) }, onClick = { onModel(m); open = false }) }
                }
            }
        }
        if (modes) {
            var open by remember { mutableStateOf(false) }
            Box {
                FilterChip(selected = mode != null, onClick = { open = true },
                    label = { Text(PERMISSION_MODES.firstOrNull { it.first == mode }?.second ?: "chat mode") })
                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    DropdownMenuItem(text = { Text("Chat's mode") }, onClick = { onMode(null); open = false })
                    PERMISSION_MODES.forEach { (key, label) -> DropdownMenuItem(text = { Text(label) }, onClick = { onMode(key); open = false }) }
                }
            }
        }
    }
}
