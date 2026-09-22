package com.yasha.pocketdesk

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/** Process-lived connection: survives rotation and the activity being closed. */
object Link {
    val client = WsClient()
}

/**
 * Keeps the process alive while connected so sessions, chats and reconnects keep
 * running with the screen off. The notification's Disconnect action ends both.
 */
class LinkService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_DISCONNECT) {
            Link.client.close()
            stopSelf()
            return START_NOT_STICKY
        }
        val n = notification(Link.client.activeUrl ?: "")
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(ID, n)
        }
        return START_NOT_STICKY
    }

    private fun notification(url: String): Notification {
        val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL) == null) {
            mgr.createNotificationChannel(NotificationChannel(CHANNEL, "Connection", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val disconnect = PendingIntent.getService(
            this, 1, Intent(this, LinkService::class.java).setAction(ACTION_DISCONNECT), PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle("Connected")
            .setContentText(url)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, "Disconnect", disconnect)
            .build()
    }

    companion object {
        private const val CHANNEL = "link"
        private const val ID = 1
        private const val ACTION_DISCONNECT = "disconnect"

        fun sync(ctx: Context, connected: Boolean) {
            val i = Intent(ctx, LinkService::class.java)
            if (connected) ctx.startForegroundService(i) else ctx.stopService(i)
        }
    }
}
