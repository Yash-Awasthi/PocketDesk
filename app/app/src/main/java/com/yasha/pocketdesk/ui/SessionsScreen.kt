package com.yasha.pocketdesk.ui

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.yasha.pocketdesk.FsEntry
import com.yasha.pocketdesk.RhEvent
import com.yasha.pocketdesk.ToolInfo
import com.yasha.pocketdesk.WsClient
import com.yasha.pocketdesk.childPath

@Composable
fun SessionsScreen(ws: WsClient, openTerminal: (String) -> Unit) {
    // A session is a PTY: a GUI application has no terminal to attach to.
    val installed = ws.tools.filter { it.installed == true && !it.manifest.isGui }
    var tool by remember { mutableStateOf<ToolInfo?>(null) }
    LaunchedEffect(installed) {
        if (tool == null || installed.none { it.manifest.id == tool?.manifest?.id }) {
            tool = installed.firstOrNull()
        }
    }

    var cwd by remember { mutableStateOf("") }
    var browsing by remember { mutableStateOf(false) }
    LaunchedEffect(browsing) {
        if (browsing) ws.browse(cwd.ifBlank { null })
    }

    LaunchedEffect(Unit) {
        ws.events.collect { ev ->
            if (ev is RhEvent.Created) openTerminal(ev.id)
        }
    }

    LazyColumn(
        Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Text("New session", style = MaterialTheme.typography.titleLarge)
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ToolPicker(installed, tool) { tool = it }
                OutlinedTextField(
                    value = cwd,
                    onValueChange = { cwd = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Project folder") },
                    placeholder = { Text("blank = home directory") },
                    singleLine = true,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { browsing = true }, enabled = tool != null) { Text("Browse") }
                    Button(
                        onClick = { ws.createSession(tool!!.manifest.id, cwd.trim()) },
                        enabled = tool != null,
                    ) { Text("Start session") }
                }
            }
        }
        item {
            Text("Live sessions", style = MaterialTheme.typography.titleLarge)
        }
        if (ws.sessions.isEmpty()) {
            item { Text("None", style = MaterialTheme.typography.bodySmall) }
        }
        items(ws.sessions, key = { it.id }) { s ->
            Card(Modifier.fillMaxWidth()) {
                Row(
                    Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(s.harnessId, style = MaterialTheme.typography.titleMedium)
                        Text(
                            s.cwd,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    TextButton(onClick = { openTerminal(s.id) }) { Text("Attach") }
                    IconButton(onClick = { ws.kill(s.id) }) {
                        Icon(Icons.Filled.Close, contentDescription = "Kill")
                    }
                }
            }
        }
    }

    if (browsing) {
        DirPickerDialog(
            ws = ws,
            onSelect = {
                cwd = it
                browsing = false
            },
            onDismiss = { browsing = false },
        )
    }
}

@Composable
private fun ToolPicker(installed: List<ToolInfo>, selected: ToolInfo?, onPick: (ToolInfo) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }, Modifier.fillMaxWidth()) {
            Text(selected?.manifest?.name ?: if (installed.isEmpty()) "No tools installed" else "Pick a tool")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            installed.forEach { t ->
                DropdownMenuItem(text = { Text(t.manifest.name) }, onClick = {
                    onPick(t)
                    open = false
                })
            }
        }
    }
}

private fun humanBytes(n: Long?): String = when {
    n == null -> ""
    n >= 1 shl 20 -> "%.1f MB".format(n.toDouble() / (1 shl 20))
    n >= 1 shl 10 -> "%.1f KB".format(n.toDouble() / (1 shl 10))
    else -> "$n B"
}

@Composable
internal fun DirPickerDialog(ws: WsClient, onSelect: (String) -> Unit, onDismiss: () -> Unit) {
    val listing = ws.dirListing
    val ctx = LocalContext.current
    var transfer by remember { mutableStateOf<String?>(null) }
    var pendingDownload by remember { mutableStateOf<FsEntry?>(null) }


    val uploadLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent(),
    ) { uri: Uri? ->
        val dir = listing?.path ?: return@rememberLauncherForActivityResult
        if (uri == null) return@rememberLauncherForActivityResult
        val display = queryDisplayName(ctx, uri)
        val remote = childPath(dir, display)
        transfer = "uploading $display..."
        ws.uploadFile(
            remotePath = remote,
            openSource = { ctx.contentResolver.openInputStream(uri) },
            sizeHint = null,
            onProgress = { sent -> transfer = "uploading $display... ${humanBytes(sent)}" },
            onDone = { err ->
                transfer = if (err != null) "upload failed: $err" else "uploaded $display"
                ws.browse(dir)
            },
        )
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(listing?.path ?: "...", style = MaterialTheme.typography.titleSmall) },
        text = {
            Column {
                when (listing) {
                    null -> Text("Loading...")
                    else -> {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = { listing.parent?.let { ws.browse(it) } }) { Text(".. up") }
                            TextButton(onClick = { uploadLauncher.launch("*/*") }) { Text("Upload here") }
                        }
                        transfer?.let {
                            Text(
                                it,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        LazyColumn(Modifier.height(320.dp)) {
                            items(listing.items, key = { it.name }) { e ->
                                TextButton(onClick = {
                                    if (e.isDir) ws.browse(childPath(listing.path, e.name)) else pendingDownload = e
                                }) {
                                    Text(
                                        if (e.isDir) e.name else "${e.name}  (${humanBytes(e.size)})",
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { listing?.let { onSelect(it.path) } }, enabled = listing != null) {
                Text("Use this folder")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )

    pendingDownload?.let { entry ->
        val remote = listing?.let { childPath(it.path, entry.name) } ?: return@let
        AlertDialog(
            onDismissRequest = { pendingDownload = null },
            title = { Text("Download ${entry.name}?") },
            text = { Text("${humanBytes(entry.size)} will be saved to your device's Downloads.") },
            confirmButton = {
                TextButton(onClick = {
                    pendingDownload = null
                    transfer = "downloading ${entry.name}..."
                    saveToDownloads(ctx, entry.name) { out, finish ->
                        ws.downloadFile(
                            remotePath = remote,
                            sink = out::write,
                            onProgress = { sent, total ->
                                transfer = "downloading ${entry.name}... ${humanBytes(sent)}/${humanBytes(total)}"
                            },
                            onDone = { err ->
                                finish(err)
                                transfer = if (err != null) "download failed: $err" else "saved ${entry.name}"
                            },
                        )
                    }
                }) { Text("Download") }
            },
            dismissButton = { TextButton(onClick = { pendingDownload = null }) { Text("Cancel") } },
        )
    }
}

private fun queryDisplayName(ctx: Context, uri: Uri): String {
    ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
            val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (idx >= 0) return c.getString(idx)
        }
    }
    return uri.lastPathSegment ?: "upload.bin"
}

/** Opens a sink in the public Downloads collection and hands back a finish() that closes it. */
private inline fun saveToDownloads(ctx: Context, fileName: String, crossinline use: (java.io.OutputStream, (String?) -> Unit) -> Unit) {
    val values = android.content.ContentValues().apply {
        put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, fileName)
        put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream")
    }
    val uri = ctx.contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
    if (uri == null) {
        use(NullOutputStream()) { "could not create download entry" }
        return
    }
    val out = ctx.contentResolver.openOutputStream(uri)
    if (out == null) {
        use(NullOutputStream()) { "could not open output stream" }
        return
    }
    use(out) { err ->
        try {
            out.close()
        } catch (_: java.io.IOException) {
        }
        if (err != null) ctx.contentResolver.delete(uri, null, null)
    }
}

private class NullOutputStream : java.io.OutputStream() {
    override fun write(b: Int) {}
    override fun write(b: ByteArray, off: Int, len: Int) {}
}
