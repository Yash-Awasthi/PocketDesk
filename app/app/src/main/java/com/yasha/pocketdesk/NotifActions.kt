// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Base64
import android.widget.Toast
import androidx.core.app.RemoteInput

/**
 * The reply and dismiss actions on a session-end notification. Neither opens the app: a reply
 * takes the terminal composer's own send path, a dismiss cancels the note and clears unread.
 */
class NotifActions : BroadcastReceiver() {

    override fun onReceive(ctx: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_ID)?.takeIf { it.isNotEmpty() } ?: return
        when (intent.action) {
            ACTION_REPLY -> {
                val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_REPLY)?.toString()?.trim()
                if (text.isNullOrEmpty()) return
                if (!deliver(id, text.take(MAX_REPLY))) {
                    Toast.makeText(ctx, "Not connected to your PC", Toast.LENGTH_SHORT).show()
                }
            }
            ACTION_DISMISS -> Unit
            else -> return
        }
        Notifier.markRead(id)
        (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(Notifier.sessionNotificationId(id))
    }

    companion object {
        const val ACTION_REPLY = "com.yasha.pocketdesk.notif.reply"
        const val ACTION_DISMISS = "com.yasha.pocketdesk.notif.dismiss"
        const val EXTRA_ID = "session"
        const val KEY_REPLY = "reply"
        private const val MAX_REPLY = 4_000

        /** Set by a test to read the text without a PC; null sends through the live link. */
        internal var replySink: ((String, String) -> Boolean)? = null

        /** The terminal composer's path: the text plus Enter, base64, over the link. */
        internal fun deliver(id: String, text: String): Boolean =
            replySink?.invoke(id, text)
                ?: Link.client.sendInput(id, Base64.encodeToString((text + "\r").toByteArray(Charsets.UTF_8), Base64.NO_WRAP))
    }
}
