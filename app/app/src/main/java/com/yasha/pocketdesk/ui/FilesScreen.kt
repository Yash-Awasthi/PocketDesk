package com.yasha.pocketdesk.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import com.yasha.pocketdesk.WsClient
import com.yasha.pocketdesk.childPath
import java.io.File

/** A row in the file manager, from a folder listing or a search result. */
private data class FileRow(val path: String, val name: String, val dir: Boolean, val size: Long?, val mtime: Long?)

/** Browse the PC's files: open, share, save, upload, rename, delete and search. */
@Composable
fun FilesScreen(ws: WsClient) {
    val ctx = LocalContext.current
    val listing = ws.dirListing
    var hidden by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    var searching by rememberSaveable { mutableStateOf(false) }
    var status by remember { mutableStateOf("") }
    var menuFor by remember { mutableStateOf<FileRow?>(null) }
    var renaming by remember { mutableStateOf<FileRow?>(null) }
    var deleting by remember { mutableStateOf<FileRow?>(null) }
    var creating by remember { mutableStateOf(false) }

    fun refresh() { listing?.path?.let { ws.browse(it, hidden) } }
    fun open(path: String?) { searching = false; ws.fsFound = null; ws.browse(path, hidden) }

    LaunchedEffect(Unit) { ws.browse(listing?.path, hidden) }
    LaunchedEffect(Unit) {
        ws.fsResults.collect { r ->
            val name = r.path.substringAfterLast('\\').substringAfterLast('/')
            status = if (r.ok) when (r.op) {
                "delete" -> "Deleted $name"
                "rename" -> "Renamed $name"
                else -> "Created $name"
            } else "Could not ${r.op} $name: ${r.error}"
            refresh()
        }
    }
    BackHandler(enabled = searching) { searching = false; ws.fsFound = null }
    // Back walks up the folders until the home folder, then leaves the tab as usual.
    BackHandler(enabled = !searching && listing != null && listing.home != null && listing.path != listing.home) {
        listing?.parent?.let { open(it) }
    }

    val upload = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val dir = listing?.path ?: return@rememberLauncherForActivityResult
        fun next(i: Int) {
            if (i == uris.size) { status = "Uploaded ${uris.size} to ${dir.substringAfterLast('\\').substringAfterLast('/')}"; refresh(); return }
            val name = queryDisplayName(ctx, uris[i])
            ws.uploadFile(
                remotePath = childPath(dir, name),
                openSource = { ctx.contentResolver.openInputStream(uris[i]) },
                sizeHint = null,
                onProgress = { n -> status = "Uploading $name (${i + 1}/${uris.size}) · ${sizeText(n)}" },
                onDone = { err -> if (err != null) { status = "Uploading $name failed: $err"; refresh() } else next(i + 1) },
            )
        }
        if (uris.isNotEmpty()) next(0)
    }

    val rows: List<FileRow> = if (searching) {
        ws.fsFound?.items?.map { FileRow(it.path, it.name, it.dir, it.size, null) } ?: emptyList()
    } else {
        listing?.items?.map { FileRow(childPath(listing.path, it.name), it.name, it.isDir, it.size, it.mtime) } ?: emptyList()
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { if (searching) open(listing?.path) else listing?.parent?.let { open(it) } }) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Up")
            }
            Text(
                if (searching) "Search in ${listing?.path.orEmpty()}" else listing?.path ?: "Loading…",
                style = MaterialTheme.typography.titleSmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = { open(null) }) { Icon(Icons.Filled.Home, contentDescription = "Home folder") }
            IconButton(onClick = ::refresh) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
            var more by remember { mutableStateOf(false) }
            Box {
                IconButton(onClick = { more = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More") }
                DropdownMenu(expanded = more, onDismissRequest = { more = false }) {
                    DropdownMenuItem(text = { Text("Upload files here") }, onClick = { more = false; upload.launch(arrayOf("*/*")) })
                    DropdownMenuItem(text = { Text("New folder") }, onClick = { more = false; creating = true })
                    DropdownMenuItem(text = { Text(if (hidden) "Hide hidden files" else "Show hidden files") }, onClick = {
                        more = false; hidden = !hidden; listing?.path?.let { ws.browse(it, hidden) }
                    })
                    DropdownMenuItem(text = { Text("Copy folder path") }, onClick = { more = false; listing?.path?.let { copyText(ctx, it); status = "Path copied" } })
                }
            }
        }
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            placeholder = { Text("Search names in this folder") },
            singleLine = true,
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            trailingIcon = {
                if (query.isNotEmpty() || searching) IconButton(onClick = { query = ""; searching = false; ws.fsFound = null }) {
                    Icon(Icons.Filled.Close, contentDescription = "Clear search")
                }
            },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = {
                val dir = listing?.path ?: return@KeyboardActions
                if (query.isBlank()) return@KeyboardActions
                ws.fsFound = null; searching = true; ws.searchFiles(dir, query.trim())
            }),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
        )
        val note = when {
            ws.fsError != null -> ws.fsError
            searching && ws.fsFound == null -> "Searching…"
            searching && ws.fsFound?.items?.isEmpty() == true -> "No matches"
            searching && ws.fsFound?.truncated == true -> "${rows.size} matches (search stopped early; narrow the folder or the name)"
            listing != null && !searching && rows.isEmpty() -> "Empty folder"
            else -> status.ifEmpty { null }
        }
        note?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp), maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
            items(rows, key = { it.path }) { row ->
                Row(
                    Modifier.fillMaxWidth()
                        .clickable { if (row.dir) open(row.path) else menuFor = row }
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Icon(if (row.dir) FolderIcon else FileIcon, contentDescription = if (row.dir) "Folder" else "File",
                        tint = if (row.dir) Color(0xFFE3B341) else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(24.dp))
                    Column(Modifier.weight(1f)) {
                        Text(row.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val detail = if (searching) row.path else listOfNotNull(row.size?.let(::sizeText), row.mtime?.let(::dateText)).joinToString(" · ")
                        if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    IconButton(onClick = { menuFor = row }) { Icon(Icons.Filled.MoreVert, contentDescription = "Actions for ${row.name}") }
                }
                HorizontalDivider()
            }
        }
    }

    menuFor?.let { row ->
        fun fetch(verb: String, then: (File) -> Unit) {
            menuFor = null
            val dir = File(ctx.cacheDir, "open").apply { deleteRecursively(); mkdirs() }
            val file = File(dir, row.name)
            val out = file.outputStream()
            ws.downloadFile(
                remotePath = row.path,
                sink = out::write,
                onProgress = { n, total -> status = "$verb ${row.name} · ${sizeText(n)}${total?.let { " of " + sizeText(it) } ?: ""}" },
                onDone = { err ->
                    runCatching { out.close() }
                    if (err != null) status = "$verb ${row.name} failed: $err" else { status = ""; then(file) }
                },
            )
        }
        AlertDialog(
            onDismissRequest = { menuFor = null },
            title = { Text(row.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            text = {
                Column {
                    if (!row.dir) {
                        MenuAction("Open") { fetch("Opening") { launchFile(ctx, it, Intent.ACTION_VIEW) } }
                        MenuAction("Share") { fetch("Preparing") { launchFile(ctx, it, Intent.ACTION_SEND) } }
                        MenuAction("Save to phone Downloads") {
                            menuFor = null
                            saveToDownloads(ctx, row.name) { out, finish ->
                                ws.downloadFile(row.path, out::write,
                                    onProgress = { n, _ -> status = "Saving ${row.name} · ${sizeText(n)}" },
                                    onDone = { err -> finish(err); status = err?.let { "Saving ${row.name} failed: $it" } ?: "Saved ${row.name} to Downloads" })
                            }
                        }
                    } else {
                        MenuAction("Open folder") { menuFor = null; open(row.path) }
                    }
                    MenuAction("Copy path") { menuFor = null; copyText(ctx, row.path); status = "Path copied" }
                    MenuAction("Rename") { menuFor = null; renaming = row }
                    MenuAction("Delete") { menuFor = null; deleting = row }
                }
            },
            confirmButton = { TextButton(onClick = { menuFor = null }) { Text("Close") } },
        )
    }

    renaming?.let { row ->
        NameDialog("Rename", row.name, onDismiss = { renaming = null }) { name ->
            renaming = null
            ws.fileOp("rename", row.path, childPath(row.path.substring(0, row.path.length - row.name.length).trimEnd('\\', '/'), name))
        }
    }
    if (creating) {
        NameDialog("New folder", "", onDismiss = { creating = false }) { name ->
            creating = false
            listing?.path?.let { ws.fileOp("mkdir", childPath(it, name)) }
        }
    }
    deleting?.let { row ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete ${row.name}?") },
            text = { Text(if (row.dir) "The folder and everything in it goes to the Recycle Bin on a Windows PC, and is deleted outright elsewhere." else "The file goes to the Recycle Bin on a Windows PC, and is deleted outright elsewhere.") },
            confirmButton = { TextButton(onClick = { deleting = null; ws.fileOp("delete", row.path) }) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun MenuAction(label: String, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.fillMaxWidth()) { Text(label, modifier = Modifier.fillMaxWidth()) }
}

@Composable
private fun NameDialog(title: String, initial: String, onDismiss: () -> Unit, onDone: (String) -> Unit) {
    var name by remember { mutableStateOf(initial) }
    val valid = name.isNotBlank() && name.none { it in "\\/:*?\"<>|" } && name != "." && name != ".."
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { OutlinedTextField(value = name, onValueChange = { name = it }, singleLine = true, isError = name.isNotEmpty() && !valid) },
        confirmButton = { TextButton(onClick = { onDone(name.trim()) }, enabled = valid) { Text("OK") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

private fun launchFile(ctx: Context, file: File, action: String) {
    val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".files", file)
    val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: "*/*"
    val intent = Intent(action).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    if (action == Intent.ACTION_SEND) intent.setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
    else intent.setDataAndType(uri, mime)
    runCatching { ctx.startActivity(Intent.createChooser(intent, file.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

private fun copyText(ctx: Context, text: String) {
    ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("PC path", text))
}

internal fun sizeText(n: Long): String = when {
    n >= 1L shl 30 -> "%.1f GB".format(n.toDouble() / (1L shl 30))
    n >= 1 shl 20 -> "%.1f MB".format(n.toDouble() / (1 shl 20))
    n >= 1 shl 10 -> "%.0f KB".format(n.toDouble() / (1 shl 10))
    else -> "$n B"
}

private fun dateText(ms: Long): String =
    java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT).format(java.util.Date(ms))

private fun icon(name: String, path: String) = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
    .addPath(pathData = addPathNodes(path), fill = SolidColor(Color.Black)).build()

internal val FolderIcon = icon("Folder", "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z")
private val FileIcon = icon("File", "M6 2c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z")
