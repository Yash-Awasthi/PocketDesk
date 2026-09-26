package com.yasha.pocketdesk

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat

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

    private const val APPROVAL_ID = 7

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

    fun sessionEnded(ctx: Context, label: String, code: Int) {
        if (!canNotify(ctx)) return
        val pi = PendingIntent.getActivity(
            ctx,
            0,
            Intent(ctx, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("PocketDesk")
            .setContentText("$label ended (exit $code)")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        mgr.notify(label.hashCode(), n)
    }
}
