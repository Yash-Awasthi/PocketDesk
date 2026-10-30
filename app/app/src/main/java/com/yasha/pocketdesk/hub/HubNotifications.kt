// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk.hub

import android.app.Notification
import android.app.NotificationManager
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Base64
import android.util.LruCache
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.graphics.drawable.toBitmap
import androidx.core.graphics.scale
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/**
 * The phone's notifications on the PC, and what the PC does with them: dismiss, reply, run an
 * action. Android binds this only while its owner grants notification access. Which ones are
 * mirrored and how they read follow NectarLink's NotificationReader (GPL-3.0).
 */
class HubNotifications : NotificationListenerService() {
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "hub-notifs").apply { isDaemon = true } }
    private val icons = LruCache<String, String>(48)
    private val names = LruCache<String, String>(128)
    private val sent = java.util.Collections.synchronizedSet(mutableSetOf<String>())

    override fun onListenerConnected() {
        instance = this
        pushAll()
        Media.start(applicationContext)
    }

    override fun onListenerDisconnected() { if (instance === this) instance = null }
    override fun onDestroy() { if (instance === this) instance = null; super.onDestroy(); worker.shutdown() }

    override fun onNotificationPosted(sbn: StatusBarNotification, rankingMap: RankingMap?) = work {
        val update = sbn.key in sent
        val item = read(sbn, rankingMap, update)
        if (item == null) { if (sent.remove(sbn.key)) Hub.event("notif") { put("op", "removed"); put("key", sbn.key) }; return@work }
        sent.add(sbn.key)
        Hub.event("notif") { put("op", "posted"); put("item", item) }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) = work {
        if (sent.remove(sbn.key)) Hub.event("notif") { put("op", "removed"); put("key", sbn.key) }
    }

    fun pushAll() = work { Hub.event("notif") { put("op", "all"); put("items", list()) } }

    private fun list() = buildJsonArray {
        val ranking = runCatching { currentRanking }.getOrNull()
        for (sbn in runCatching { activeNotifications.orEmpty() }.getOrDefault(emptyArray()).sortedByDescending { it.postTime }) {
            read(sbn, ranking, true)?.let { sent.add(sbn.key); add(it) }
        }
    }

    private fun work(task: () -> Unit) { try { worker.execute { runCatching(task) } } catch (_: java.util.concurrent.RejectedExecutionException) {} }

    private fun read(sbn: StatusBarNotification, ranking: RankingMap?, update: Boolean): JsonObject? {
        val n = sbn.notification
        if (sbn.packageName == packageName) return null
        if (n.flags and (Notification.FLAG_GROUP_SUMMARY or Notification.FLAG_LOCAL_ONLY) != 0) return null
        // Media players have their own card.
        if (n.category == Notification.CATEGORY_TRANSPORT || n.extras.containsKey(Notification.EXTRA_MEDIA_SESSION)) return null
        val extras = n.extras
        val max = extras.getInt(Notification.EXTRA_PROGRESS_MAX, 0)
        val live = max > 0 || extras.getBoolean(Notification.EXTRA_SHOW_CHRONOMETER, false)
        if (!live && (!sbn.isClearable || n.flags and (Notification.FLAG_ONGOING_EVENT or Notification.FLAG_FOREGROUND_SERVICE) != 0)) return null
        fun text(k: String) = extras.getCharSequence(k)?.toString()?.trim()?.ifEmpty { null }
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)
        val last = style?.messages?.lastOrNull()
        val title: String?
        val body: String?
        if (style != null && last != null) {
            val sender = last.person?.name?.toString()
            title = style.conversationTitle?.toString()?.takeIf { style.isGroupConversation } ?: sender
            body = last.text?.toString()?.let { if (style.isGroupConversation && sender != null) "$sender: $it" else it }
        } else {
            title = text(Notification.EXTRA_TITLE_BIG) ?: text(Notification.EXTRA_TITLE)
            body = text(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)?.joinToString("\n")?.ifBlank { null } ?: text(Notification.EXTRA_TEXT)
        }
        if (title.isNullOrBlank() && body.isNullOrBlank()) return null
        val r = Ranking()
        val silent = (ranking != null && ranking.getRanking(sbn.key, r) && r.importance < NotificationManager.IMPORTANCE_DEFAULT) ||
            (update && n.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)
        return obj {
            put("key", sbn.key); put("app", sbn.packageName); put("appName", appName(sbn.packageName))
            putNullable("title", title); putNullable("text", body); putNullable("sub", text(Notification.EXTRA_SUB_TEXT))
            put("when", sbn.postTime); put("silent", silent)
            putNullable("icon", icon(sbn.packageName))
            picture(n)?.let { put("image", it) }
            if (max > 0) { put("progress", extras.getInt(Notification.EXTRA_PROGRESS, 0)); put("max", max) }
            otp(body.orEmpty())?.let { put("code", it) }
            put("actions", buildJsonArray {
                n.actions.orEmpty().forEachIndexed { i, a ->
                    val t = a.title?.toString()?.trim()
                    if (!t.isNullOrEmpty() && a.actionIntent != null) add(obj {
                        put("id", i.toString()); put("title", t); put("reply", a.remoteInputs.orEmpty().any { it.allowFreeFormInput })
                    })
                }
            })
        }
    }

    private fun appName(pkg: String) = names.get(pkg) ?: runCatching {
        packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
    }.getOrDefault(pkg).also { names.put(pkg, it) }

    private fun icon(pkg: String) = icons.get(pkg) ?: runCatching {
        b64(packageManager.getApplicationIcon(pkg).toBitmap(ICON_PX, ICON_PX, Bitmap.Config.ARGB_8888), Bitmap.CompressFormat.PNG, 100)
    }.getOrNull()?.also { icons.put(pkg, it) }

    private fun picture(n: Notification): String? = runCatching {
        val bmp = if (Build.VERSION.SDK_INT >= 33) n.extras.getParcelable(Notification.EXTRA_PICTURE, Bitmap::class.java)
            else @Suppress("DEPRECATION") (n.extras.getParcelable(Notification.EXTRA_PICTURE) as? Bitmap)
        val bitmap = bmp ?: (if (Build.VERSION.SDK_INT >= 33) n.extras.getParcelable(Notification.EXTRA_PICTURE_ICON, Icon::class.java) else null)
            ?.loadDrawable(this)?.toBitmap() ?: return null
        val k = minOf(1f, IMAGE_PX.toFloat() / maxOf(bitmap.width, bitmap.height))
        b64(if (k < 1f) bitmap.scale((bitmap.width * k).toInt().coerceAtLeast(1), (bitmap.height * k).toInt().coerceAtLeast(1)) else bitmap, Bitmap.CompressFormat.JPEG, 75)
    }.getOrNull()

    fun find(key: String): StatusBarNotification? = runCatching { getActiveNotifications(arrayOf(key)) }.getOrNull()?.firstOrNull()

    companion object {
        @Volatile var instance: HubNotifications? = null
            private set
        private const val ICON_PX = 96
        private const val IMAGE_PX = 512
        // A 4-8 digit code right after a word that says it is one, else right before "is your code";
        // never part of a phone number or an amount.
        private val AFTER = Regex("""(?i)\b(?:code|otp|pin|passcode|verification|token)\b\D{0,20}?(?<![\d.,-])(\d{4,8})(?![.,-]?\d)""")
        private val BEFORE = Regex("""(?i)(?<![\d.,-])(\d{4,8})(?![.,-]?\d)\s*(?:is your|is the)\b""")

        fun otp(s: String): String? = (AFTER.find(s) ?: BEFORE.find(s))?.groupValues?.get(1)

        fun b64(bitmap: Bitmap, format: Bitmap.CompressFormat, quality: Int): String =
            ByteArrayOutputStream().use { bitmap.compress(format, quality, it); Base64.encodeToString(it.toByteArray(), Base64.NO_WRAP) }

        fun hasAccess(ctx: Context) = NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)
        fun component(ctx: Context) = ComponentName(ctx, HubNotifications::class.java)
        fun settingsIntent(ctx: Context): Intent = Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
            .putExtra(android.provider.Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, component(ctx).flattenToString())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        fun answer(m: JsonObject): JsonObject {
            val l = instance ?: error("Notification access is off on the phone: turn it on from the PC's Connect page")
            return when (m.str("op")) {
                "list" -> obj { put("items", l.list()) }
                "dismiss" -> obj { l.cancelNotification(m.str("key")) }
                "dismiss_all" -> obj { l.cancelAllNotifications() }
                "action", "reply" -> {
                    val sbn = l.find(m.str("key") ?: "") ?: error("that notification is gone")
                    val action = sbn.notification.actions?.getOrNull(m.str("action")?.toIntOrNull() ?: -1) ?: error("that action is gone")
                    val text = m.str("text")
                    if (m.str("op") == "reply" && text != null) {
                        val inputs = action.remoteInputs.orEmpty()
                        val intent = Intent()
                        RemoteInput.addResultsToIntent(inputs, intent, Bundle().apply { for (ri in inputs) putCharSequence(ri.resultKey, text) })
                        action.actionIntent.send(l, 0, intent)
                    } else action.actionIntent.send()
                    obj {}
                }
                else -> error("unknown op")
            }
        }
    }
}
