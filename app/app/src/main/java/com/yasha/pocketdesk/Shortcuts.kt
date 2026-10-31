// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.widget.RemoteViews
import android.widget.Toast
import androidx.activity.ComponentActivity
import com.yasha.pocketdesk.hub.ClipSync
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Sends the phone's clipboard to the PC. Android hands the clipboard only to the app in focus, so
 * this invisible activity takes focus for a moment, reads it, sends it and closes.
 */
class ClipSendActivity : ComponentActivity() {
    private var done = false

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || done) return
        done = true
        val app = applicationContext
        if (Link.client.status != Status.Connected) { Toast.makeText(app, "Connect PocketDesk to your PC first", Toast.LENGTH_SHORT).show(); return finish() }
        val clip = getSystemService(ClipboardManager::class.java).primaryClip
        val item = clip?.getItemAt(0)
        val sensitive = clip?.description?.extras?.getBoolean("android.content.extra.IS_SENSITIVE") == true
        val isImage = clip != null && (0 until clip.description.mimeTypeCount).any { clip.description.getMimeType(it).startsWith("image/") }
        when {
            item == null -> Toast.makeText(app, "The clipboard is empty", Toast.LENGTH_SHORT).show()
            sensitive -> Toast.makeText(app, "Passwords stay on the phone", Toast.LENGTH_SHORT).show()
            isImage && item.uri != null -> {
                val uri = item.uri
                Thread { ClipSync.picture(app, uri)?.let { ClipSync.sendPicture(it, paste = true) } }.start()
                Toast.makeText(app, "Picture sent to the PC's clipboard", Toast.LENGTH_SHORT).show()
            }
            else -> {
                val text = item.coerceToText(this)?.toString().orEmpty()
                if (text.isEmpty()) Toast.makeText(app, "The clipboard is empty", Toast.LENGTH_SHORT).show()
                else {
                    Link.client.sendRaw(buildJsonObject { put("type", "handoff"); put("text", text.take(200_000)); put("copy", true) }.toString())
                    Toast.makeText(app, "On your PC's clipboard", Toast.LENGTH_SHORT).show()
                }
            }
        }
        finish()
    }
}

// Android 11-13 have only the Intent form; the PendingIntent one arrived in 14.
@android.annotation.SuppressLint("StartActivityAndCollapseDeprecated")
private fun TileService.launch(intent: Intent) {
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this, intent.component.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE))
    else @Suppress("DEPRECATION") startActivityAndCollapse(intent)
}

private fun TileService.paint(label: String) {
    val t = qsTile ?: return
    t.state = if (Link.client.status == Status.Connected) Tile.STATE_INACTIVE else Tile.STATE_UNAVAILABLE
    t.label = label
    t.updateTile()
}

/** Quick Settings: the phone's clipboard to the PC. */
class ClipTile : TileService() {
    override fun onStartListening() = paint("Clipboard to PC")
    override fun onClick() = launch(Intent(this, ClipSendActivity::class.java))
}

/** Quick Settings: a photo straight onto the PC's clipboard. */
class PhotoTile : TileService() {
    override fun onStartListening() = paint("Photo to PC")
    override fun onClick() = launch(Intent(this, CaptureActivity::class.java).putExtra("mode", "photo"))
}

/** Home-screen widget: whether the PC is linked, and one tap for the clipboard, a photo, a scan or the Remote. */
class LinkWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) = paint(ctx, mgr, ids)

    companion object {
        fun refresh(ctx: Context) {
            val mgr = AppWidgetManager.getInstance(ctx)
            val ids = mgr.getAppWidgetIds(ComponentName(ctx, LinkWidget::class.java))
            if (ids.isNotEmpty()) paint(ctx, mgr, ids)
        }

        private fun pi(ctx: Context, code: Int, intent: Intent) =
            PendingIntent.getActivity(ctx, code, intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        private fun paint(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
            val c = Link.client
            val text = when (c.status) {
                Status.Connected -> "Linked to your PC"
                Status.Connecting, Status.Reconnecting -> "Connecting…"
                else -> "Not linked · tap to open"
            }
            val v = RemoteViews(ctx.packageName, R.layout.widget_link).apply {
                setTextViewText(R.id.w_status, text)
                setOnClickPendingIntent(R.id.w_status, pi(ctx, 1, Intent(ctx, MainActivity::class.java)))
                setOnClickPendingIntent(R.id.w_clip, pi(ctx, 2, Intent(ctx, ClipSendActivity::class.java)))
                setOnClickPendingIntent(R.id.w_photo, pi(ctx, 3, Intent(ctx, CaptureActivity::class.java).putExtra("mode", "photo")))
                setOnClickPendingIntent(R.id.w_scan, pi(ctx, 4, Intent(ctx, CaptureActivity::class.java).putExtra("mode", "scan")))
                setOnClickPendingIntent(R.id.w_remote, pi(ctx, 5, Intent(ctx, MainActivity::class.java).putExtra("open", "remote")))
            }
            mgr.updateAppWidget(ids, v)
        }
    }
}
