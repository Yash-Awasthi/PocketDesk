package com.yasha.pocketdesk

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput

object Notifier {
    private const val CHANNEL = "sessions"

    fun ensureChannel(ctx: Context) {
        val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL, "Session updates", NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
    }

    fun canNotify(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private const val APPROVALS = "approvals"

    /** Allow and Deny straight from the notification; LinkService carries the answer to the PC. */
    fun approval(ctx: Context, p: Proposal) {
        if (!canNotify(ctx)) return
        val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(APPROVALS) == null) {
            mgr.createNotificationChannel(NotificationChannel(APPROVALS, "Agent approvals", NotificationManager.IMPORTANCE_HIGH))
        }
        fun answer(action: String, code: Int) = PendingIntent.getService(
            ctx, p.id.hashCode() * 2 + code,
            Intent(ctx, LinkService::class.java).setAction(action).putExtra(LinkService.EXTRA_ID, p.id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val open = PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(ctx, APPROVALS)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle("${p.tool.ifEmpty { "Agent" }} wants approval")
            .setContentText(p.summary)
            .setStyle(NotificationCompat.BigTextStyle().bigText(p.summary))
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(open)
            .setAutoCancel(true)
            .addAction(0, "Deny", answer(LinkService.ACTION_DENY, 0))
            .addAction(0, "Allow", answer(LinkService.ACTION_ALLOW, 1))
            .build()
        mgr.notify(p.id, APPROVAL_ID, n)
    }

    fun approvalGone(ctx: Context, id: String) {
        (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(id, APPROVAL_ID)
    }

    fun approvalsGone(ctx: Context) {
        val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        for (n in mgr.activeNotifications) if (n.id == APPROVAL_ID) mgr.cancel(n.tag, n.id)
    }

    private const val APPROVAL_ID = 7
    private const val SHARE_REQUEST_ID = 10

    /** The PC asked to view this phone; tapping opens Android's own capture prompt. */
    fun shareRequest(ctx: Context) {
        if (!canNotify(ctx)) return
        val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel("share_request") == null) {
            mgr.createNotificationChannel(NotificationChannel("share_request", "PC asks to view this phone", NotificationManager.IMPORTANCE_HIGH))
        }
        val open = PendingIntent.getActivity(ctx, 0, Intent(ctx, ShareConsentActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(ctx, "share_request")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("Your PC wants to view this phone")
            .setContentText("Tap to choose whether to share the screen")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        mgr.notify(SHARE_REQUEST_ID, n)
    }

    private const val STORAGE_REQUEST_ID = 11

    /** The PC tried to open this phone's storage; tapping opens Android's "All files access" for the app. */
    fun storageRequest(ctx: Context) {
        if (!canNotify(ctx)) return
        val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel("share_request") == null) {
            mgr.createNotificationChannel(NotificationChannel("share_request", "PC asks to view this phone", NotificationManager.IMPORTANCE_HIGH))
        }
        val settings = Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
            android.net.Uri.fromParts("package", ctx.packageName, null))
        val n = NotificationCompat.Builder(ctx, "share_request")
            .setSmallIcon(android.R.drawable.ic_menu_save)
            .setContentTitle("Your PC wants to open this phone's storage")
            .setContentText("Tap to choose: turn on All files access for PocketDesk")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(PendingIntent.getActivity(ctx, 1, settings, PendingIntent.FLAG_IMMUTABLE))
            .setAutoCancel(true)
            .build()
        mgr.notify(STORAGE_REQUEST_ID, n)
    }

    fun shareRequestGone(ctx: Context) {
        (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(SHARE_REQUEST_ID)
    }

    private const val LINK_LOST_ID = 8

    fun linkLost(ctx: Context, reason: String) {
        if (!canNotify(ctx)) return
        val pi = PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle("Disconnected from your PC")
            .setContentText(reason)
            .setStyle(NotificationCompat.BigTextStyle().bigText(reason))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(LINK_LOST_ID, n)
    }

    fun linkLostGone(ctx: Context) {
        (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(LINK_LOST_ID)
    }

    /** Sessions whose end notification is still unanswered; dismiss and reply both clear it. */
    private val unread = java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<String, Boolean>())

    fun isUnread(id: String): Boolean = id in unread
    fun markRead(id: String) { unread -= id }

    /** The notification id for [id]; every action carries the session id. */
    fun sessionNotificationId(id: String): Int = id.hashCode()

    fun sessionEnded(ctx: Context, id: String, label: String, code: Int) {
        if (!canNotify(ctx)) return
        unread += id
        val nid = sessionNotificationId(id)
        val open = PendingIntent.getActivity(
            ctx,
            nid,
            Intent(ctx, MainActivity::class.java)
                .setAction(Intent.ACTION_VIEW)
                .setData(Uri.parse("pocketdesk://session/$id"))
                .putExtra("open", "session:$id")
                .putExtra(NotifActions.EXTRA_ID, id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val replyPi = PendingIntent.getBroadcast(
            ctx,
            nid + 1,
            Intent(ctx, NotifActions::class.java).setAction(NotifActions.ACTION_REPLY).putExtra(NotifActions.EXTRA_ID, id),
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val dismissPi = PendingIntent.getBroadcast(
            ctx,
            nid + 2,
            Intent(ctx, NotifActions::class.java).setAction(NotifActions.ACTION_DISMISS).putExtra(NotifActions.EXTRA_ID, id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val reply = RemoteInput.Builder(NotifActions.KEY_REPLY).setLabel("Reply to $label").build()
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("PocketDesk")
            .setContentText("$label ended (exit $code)")
            .setContentIntent(open)
            .setAutoCancel(true)
            .setDeleteIntent(dismissPi)
            .addAction(0, "Open", open)
            .addAction(NotificationCompat.Action.Builder(0, "Reply", replyPi).addRemoteInput(reply).build())
            .addAction(0, "Dismiss", dismissPi)
            .build()
        (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(nid, n)
    }
}
