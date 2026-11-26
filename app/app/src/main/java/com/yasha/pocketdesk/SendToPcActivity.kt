// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk

import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.core.content.IntentCompat

/**
 * "PocketDesk" in any app's share menu: a link opens in the PC's browser, text lands on the PC's
 * clipboard, and files go to the live session, or to the folder picked last time.
 */
class SendToPcActivity : ComponentActivity() {
    private val main = Handler(android.os.Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = applicationContext
        // "Copy to PC" (an alias of this activity) puts the files on the PC's clipboard instead.
        val copy = componentName?.className?.endsWith(".CopyToPc") == true
        val uris = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else -> emptyList()
        }
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()
        if (uris.isEmpty()) {
            if (text.isNullOrEmpty()) return finish()
            ShareRouter.sendText(app, text, copy,
                done = { finish() },
                notice = { msg -> toast(msg) })
            return
        }
        ShareRouter.share(
            ctx = app,
            uris = uris,
            copy = copy,
            ask = { options, pick -> ask(options, pick) },
            done = { main.post { finish() } },
            notice = { msg -> toast(msg) },
        )
    }

    private fun ask(options: List<ShareDestination>, pick: (ShareDestination) -> Unit) {
        val labels = options.map { d ->
            when {
                d.sessionId != null -> "Session ${d.sessionId}"
                else -> "Folder ${d.folder}"
            }
        }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Send to PC")
            .setItems(labels) { _, which -> pick(options[which]) }
            .setOnCancelListener { finish() }
            .show()
    }

    private fun toast(msg: String) = main.post {
        Toast.makeText(applicationContext, msg, Toast.LENGTH_SHORT).show()
    }
}

