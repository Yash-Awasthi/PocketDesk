// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.core.content.IntentCompat

/**
 * "PocketDesk" in any app's share menu: a link opens in the PC's browser, text lands on the PC's
 * clipboard, and files go to the PC's Downloads folder. Nothing to show; it hands off and closes.
 */
class SendToPcActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = applicationContext
        if (Link.client.status != Status.Connected) {
            Toast.makeText(app, "Connect PocketDesk to your PC first", Toast.LENGTH_LONG).show()
            return finish()
        }
        val uris = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else -> emptyList()
        }
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()
            ?.let { if (Regex("^https?://\\S+$").matches(it)) com.yasha.pocketdesk.hub.Media.withPosition(it) else it }
        if (uris.isEmpty() && !text.isNullOrEmpty()) {
            val json = kotlinx.serialization.json.buildJsonObject {
                put("type", kotlinx.serialization.json.JsonPrimitive("handoff")); put("text", kotlinx.serialization.json.JsonPrimitive(text))
                if (componentName.className.endsWith(".CopyToPc")) put("copy", kotlinx.serialization.json.JsonPrimitive(true))
            }.toString()
            Link.client.sendRaw(json)
            val opens = Regex("^https?://\\S+$").matches(text) && !componentName.className.endsWith(".CopyToPc")
            Toast.makeText(app, if (opens) "Opening on your PC" else "On your PC's clipboard", Toast.LENGTH_SHORT).show()
            return finish()
        }
        // "Copy to PC" (an alias of this activity) puts the files on the PC's clipboard instead of leaving them in Downloads.
        val copy = componentName.className.endsWith(".CopyToPc")
        val dir = if (copy) "~/Downloads/PocketDesk" else "~/Downloads"
        val done = java.util.Collections.synchronizedList(mutableListOf<String>())
        var left = uris.size
        for (uri in uris) {
            val name = displayName(uri).replace(Regex("[\\\\/:*?\"<>|]"), "_")
            Link.client.uploadFile("$dir/$name", { contentResolver.openInputStream(uri) }, null, {}) { err ->
                if (err == null) done.add("$dir/$name")
                val last = synchronized(done) { --left == 0 }
                if (copy && last && done.isNotEmpty()) Link.client.sendRaw(kotlinx.serialization.json.buildJsonObject {
                    put("type", kotlinx.serialization.json.JsonPrimitive("phone_copied"))
                    put("files", kotlinx.serialization.json.JsonArray(done.map { kotlinx.serialization.json.JsonPrimitive(it) }))
                }.toString())
                android.os.Handler(mainLooper).post {
                    Toast.makeText(app, err?.let { "$name: $it" } ?: if (copy) "$name is on the PC's clipboard" else "$name is in the PC's Downloads", Toast.LENGTH_SHORT).show()
                }
            }
        }
        if (uris.isNotEmpty()) Toast.makeText(app, "${if (copy) "Copying" else "Sending"} ${uris.size} file${if (uris.size > 1) "s" else ""} to your PC", Toast.LENGTH_SHORT).show()
        finish()
    }

    private fun displayName(uri: Uri): String = runCatching {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
    }.getOrNull() ?: uri.lastPathSegment?.substringAfterLast('/') ?: "shared-file"
}
