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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.launch

/**
 * Process-lived connection: survives rotation and the activity being closed.
 * The service and exit notifications are driven from here, not from the UI.
 */
object Link {
    val client = WsClient()
    private val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main)

    /** A pairing link opened from outside the app, waiting for the user to confirm it. */
    var pendingPair by androidx.compose.runtime.mutableStateOf<List<ServerEntry>>(emptyList())

    fun start(app: Context) {
        Notifier.ensureChannel(app)
        // Wi-Fi or mobile data decides whether the LAN address is worth trying.
        app.getSystemService(android.net.ConnectivityManager::class.java).registerDefaultNetworkCallback(
            object : android.net.ConnectivityManager.NetworkCallback() {
                override fun onCapabilitiesChanged(n: android.net.Network, caps: android.net.NetworkCapabilities) {
                    val local = caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) ||
                        caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET)
                    scope.launch { client.onNetworkChanged(NetInfo(n.toString(), local)) }
                }
            },
        )
        scope.launch {
            var was = Status.Disconnected
            client.statusFlow.collect { now ->
                LinkService.sync(app, now)
                // close() clears lastError, so an error here means the link ended without the user asking.
                if (now == Status.Disconnected && was != Status.Disconnected && !MainActivity.foreground) {
                    client.lastError?.let { Notifier.linkLost(app, it) }
                }
                if (now == Status.Connected) Notifier.linkLostGone(app)
                was = now
            }
        }
        scope.launch {
            client.events.collect { ev ->
                when {
                    ev is RhEvent.Exit && !MainActivity.foreground -> Notifier.sessionEnded(app, ev.harnessId, ev.code)
                    ev is RhEvent.ApprovalNeeded && !MainActivity.foreground -> Notifier.approval(app, ev.proposal)
                    ev is RhEvent.ApprovalGone -> Notifier.approvalGone(app, ev.id)
                }
            }
        }
    }
}

class RhApp : android.app.Application() {
    override fun onCreate() {
        super.onCreate()
        IrohLink.Node.init(this)
        Link.start(this)
    }
}

/**
 * Keeps the process alive while connected so sessions, chats and reconnects keep
 * running with the screen off. The notification's Disconnect action ends both.
 */
class LinkService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val proposal = intent?.getStringExtra(EXTRA_ID)
        if (proposal != null && (intent.action == ACTION_ALLOW || intent.action == ACTION_DENY)) {
            if (intent.action == ACTION_ALLOW) Link.client.approve(proposal) else Link.client.reject(proposal)
            Notifier.approvalGone(this, proposal)
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_DISCONNECT) {
            Link.client.close()
            stopSelf()
            return START_NOT_STICKY
        }
        pending = false
        // startForeground must come even when the link already ended, or Android kills the app for it.
        val status = Link.client.status
        val n = notification(this, status)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(ID, n)
        }
        running = true
        if (status == Status.Disconnected) stopSelf()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "link"
        private const val ID = 1
        private const val ACTION_DISCONNECT = "disconnect"
        const val ACTION_ALLOW = "allow"
        const val ACTION_DENY = "deny"
        const val EXTRA_ID = "proposal"

        @Volatile private var running = false
        @Volatile private var pending = false

        private fun notification(ctx: Context, status: Status): Notification {
            val mgr = ctx.getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            if (mgr.getNotificationChannel(CHANNEL) == null) {
                mgr.createNotificationChannel(NotificationChannel(CHANNEL, "Connection", NotificationManager.IMPORTANCE_LOW))
            }
            val open = PendingIntent.getActivity(
                ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
            )
            val disconnect = PendingIntent.getService(
                ctx, 1, Intent(ctx, LinkService::class.java).setAction(ACTION_DISCONNECT), PendingIntent.FLAG_IMMUTABLE,
            )
            val (title, text) = when (status) {
                Status.Connected -> "Connected to your PC" to (Link.client.activeUrl ?: "")
                Status.Reconnecting -> "Connection lost, retrying" to (Link.client.lastError ?: "")
                Status.AwaitingTrust -> "Waiting for you to trust the PC" to "Open the app to confirm"
                else -> "Connecting to your PC" to (Link.client.activeUrl ?: "")
            }
            return NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_upload_done)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(open)
                .addAction(0, if (status == Status.Connected) "Disconnect" else "Stop", disconnect)
                .build()
        }

        fun sync(ctx: Context, status: Status) {
            val i = Intent(ctx, LinkService::class.java)
            if (status == Status.Disconnected) {
                // A start still on its way ends itself in onStartCommand; stopping it now would crash.
                if (!pending) ctx.stopService(i)
                return
            }
            if (running) {
                (ctx.getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(ID, notification(ctx, status))
                return
            }
            if (pending) return
            // Android 12+ refuses a start from the background; the link itself keeps running.
            try {
                ctx.startForegroundService(i)
                pending = true
            } catch (_: IllegalStateException) {
            }
        }
    }
}
