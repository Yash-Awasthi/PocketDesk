// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk.hub

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationCompat
import com.yasha.pocketdesk.Notifier

/**
 * The PC asks for a permission; the phone's owner decides. Android lets an app in the background
 * only post a notification, so the PC's request lands as one, and tapping it asks.
 */
object Grant {
    private const val CHANNEL = "hub_grant"
    private const val ID = 31

    private val runtime = mapOf(
        "sms" to arrayOf(Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_CONTACTS),
        "calls" to arrayOf(Manifest.permission.READ_CALL_LOG, Manifest.permission.CALL_PHONE, Manifest.permission.ANSWER_PHONE_CALLS, Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_CONTACTS),
        "contacts" to arrayOf(Manifest.permission.READ_CONTACTS),
        "photos" to if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO) else arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE),
    )
    private val titles = mapOf("notifications" to "notifications", "sms" to "texts", "calls" to "calls", "contacts" to "contacts",
        "photos" to "photos", "dnd" to "Do not disturb", "settings" to "brightness")

    fun ask(ctx: Context, what: String) {
        if (what !in titles) error("unknown permission: $what")
        notify(ctx, "Your PC asks for this phone's ${titles[what]}", "Tap to decide", Intent(ctx, GrantActivity::class.java).putExtra("what", what))
    }

    /** A settings page the PC wants open: through a notification, since the app may be in the background. */
    fun open(ctx: Context, intent: Intent) = notify(ctx, "Your PC asks to open a setting", "Tap to open it", intent)

    private fun notify(ctx: Context, title: String, text: String, intent: Intent) {
        if (!Notifier.canNotify(ctx)) error("the phone app may not show notifications; open it on the phone")
        val mgr = ctx.getSystemService(NotificationManager::class.java)
        if (mgr.getNotificationChannel(CHANNEL) == null) mgr.createNotificationChannel(NotificationChannel(CHANNEL, "PC asks for a permission", NotificationManager.IMPORTANCE_HIGH))
        mgr.notify(ID, NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
            .setContentTitle(title).setContentText(text)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(PendingIntent.getActivity(ctx, 0, intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setAutoCancel(true)
            .build())
    }

    fun intentFor(ctx: Context, what: String): Intent? = when (what) {
        "notifications" -> HubNotifications.settingsIntent(ctx)
        "dnd" -> Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)
        "settings" -> Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.fromParts("package", ctx.packageName, null))
        else -> null
    }

    fun permissions(what: String) = runtime[what]
}

/** Asks for one feature's permissions, or opens its settings page, then goes away. */
class GrantActivity : ComponentActivity() {
    private val ask = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        // Listeners that need these start now rather than on the next launch.
        Calls.start(applicationContext)
        Sms.start(applicationContext)
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return
        val what = intent.getStringExtra("what").orEmpty()
        val perms = Grant.permissions(what)
        if (perms != null) return ask.launch(perms)
        Grant.intentFor(this, what)?.let { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        finish()
    }
}
