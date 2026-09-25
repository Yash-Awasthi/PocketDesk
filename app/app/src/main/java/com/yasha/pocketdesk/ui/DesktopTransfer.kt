package com.yasha.pocketdesk.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.util.Base64
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import com.yasha.pocketdesk.PcFile
import com.yasha.pocketdesk.WsClient
import java.io.File

/** Where files sent from the phone land on the PC before they are pasted. */
const val PC_DROP_DIR = "~/Downloads/PocketDesk"

private const val MAX_CLIP_IMAGE = 12 shl 20

/** State of the desktop screen's file traffic, shown as one line above the picture. */
class DesktopTransfer {
    var status by mutableStateOf("")
    var pcFiles by mutableStateOf<List<PcFile>>(emptyList())
}

/**
 * Keeps the two clipboards in step while the desktop is open: a PC copy lands on the phone,
 * and whatever the phone copied goes to the PC when this screen regains focus.
 */
@Composable
fun DesktopClipboardSync(ws: WsClient, transfer: DesktopTransfer) {
    val context = LocalContext.current
    val cm = remember { context.getSystemService(ClipboardManager::class.java) }
    // The last clip exchanged either way, so neither side echoes it back.
    var seenStamp by remember { mutableLongStateOf(-1L) }
    var seenText by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        ws.pcClip.collect { c ->
            when (c.kind) {
                "text" -> c.text?.let {
                    seenText = it
                    cm.setPrimaryClip(ClipData.newPlainText("PC", it))
                    if (c.requested) Toast.makeText(context, "Copied from PC", Toast.LENGTH_SHORT).show()
                }
                "image" -> {
                    val uri = c.png?.let { clipImageUri(context, it) }
                    if (uri != null) cm.setPrimaryClip(ClipData.newUri(context.contentResolver, "PC image", uri))
                    else transfer.status = "Image copied on the PC is too large to bring over"
                }
                "files" -> transfer.pcFiles = c.files.filter { !it.dir }
            }
            seenStamp = cm.primaryClipDescription?.timestamp ?: seenStamp
        }
    }

    val window = LocalWindowInfo.current
    LaunchedEffect(window) {
        snapshotFlow { window.isWindowFocused }.collect { focused ->
            if (!focused) return@collect
            val desc = cm.primaryClipDescription ?: return@collect
            if (desc.timestamp == seenStamp) return@collect
            seenStamp = desc.timestamp
            val item = cm.primaryClip?.getItemAt(0) ?: return@collect
            val uri = item.uri
            if (uri != null && desc.hasMimeType("image/*")) {
                readLimited(context, uri, MAX_CLIP_IMAGE)?.let { ws.clipboardSetImage(Base64.encodeToString(it, Base64.NO_WRAP)) }
            } else {
                val text = item.coerceToText(context)?.toString()
                if (!text.isNullOrEmpty() && text != seenText) {
                    seenText = text
                    ws.clipboardSet(text, paste = false)
                }
            }
        }
    }
}

/** Picks files on the phone, uploads them to [PC_DROP_DIR] and pastes them into the focused PC window. */
@Composable
fun rememberSendFiles(ws: WsClient, transfer: DesktopTransfer): () -> Unit {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        val sent = mutableListOf<String>()
        fun next(i: Int) {
            if (i == uris.size) {
                ws.clipboardSetFiles(sent, paste = true)
                transfer.status = "Sent ${sent.size} file${if (sent.size == 1) "" else "s"} to $PC_DROP_DIR and pasted"
                return
            }
            val name = queryDisplayName(context, uris[i])
            val remote = "$PC_DROP_DIR/$name"
            ws.uploadFile(
                remotePath = remote,
                openSource = { context.contentResolver.openInputStream(uris[i]) },
                sizeHint = null,
                onProgress = { n -> transfer.status = "Sending $name (${i + 1}/${uris.size}) · ${n shr 10} KB" },
                onDone = { err ->
                    if (err != null) transfer.status = "Sending $name failed: $err"
                    else { sent += remote; next(i + 1) }
                },
            )
        }
        next(0)
    }
    return { launcher.launch(arrayOf("*/*")) }
}

/** One line for transfer progress, plus a save action when the PC has files on its clipboard. */
@Composable
fun DesktopTransferBar(ws: WsClient, transfer: DesktopTransfer) {
    val context = LocalContext.current
    val files = transfer.pcFiles
    if (transfer.status.isEmpty() && files.isEmpty()) return
    Row(Modifier.fillMaxWidth().background(Color(0xFF161B22)).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            if (files.isNotEmpty()) "${files.size} file${if (files.size == 1) "" else "s"} copied on the PC: ${files.joinToString { it.name }}" else transfer.status,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (files.isNotEmpty()) TextButton(onClick = {
            transfer.pcFiles = emptyList()
            fun next(i: Int) {
                if (i == files.size) { transfer.status = "Saved ${files.size} to Downloads"; return }
                val f = files[i]
                saveToDownloads(context, f.name) { out, finish ->
                    ws.downloadFile(
                        remotePath = f.path,
                        sink = out::write,
                        onProgress = { n, _ -> transfer.status = "Saving ${f.name} (${i + 1}/${files.size}) · ${n shr 10} KB" },
                        onDone = { err ->
                            finish(err)
                            if (err != null) transfer.status = "Saving ${f.name} failed: $err" else next(i + 1)
                        },
                    )
                }
            }
            next(0)
        }) { Text("Save to phone") }
        TextButton(onClick = { transfer.pcFiles = emptyList(); transfer.status = "" }) { Text("✕") }
    }
}

private fun clipImageUri(context: Context, pngB64: String): Uri? = runCatching {
    val dir = File(context.cacheDir, "clip").apply { mkdirs() }
    val file = File(dir, "pc-clip.png")
    file.writeBytes(Base64.decode(pngB64, Base64.NO_WRAP))
    FileProvider.getUriForFile(context, context.packageName + ".files", file)
}.getOrNull()

/** Null when unreadable or larger than [max]. */
private fun readLimited(context: Context, uri: Uri, max: Int): ByteArray? = runCatching {
    context.contentResolver.openInputStream(uri)?.use { input ->
        val out = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(64 shl 10)
        while (out.size() <= max) {
            val n = input.read(chunk)
            if (n < 0) break
            out.write(chunk, 0, n)
        }
        out.takeIf { it.size() <= max }?.toByteArray()
    }
}.getOrNull()
