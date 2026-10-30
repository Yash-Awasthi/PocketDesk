// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk.hub

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import com.yasha.pocketdesk.Link
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import androidx.core.graphics.drawable.toBitmap

/**
 * This phone's own features for the PC: notifications, texts, calls, contacts, quick settings,
 * media, battery, photos and ringing. The PC asks with phone_req and gets one phone_res back;
 * changes go out unasked as phone_evt. Each feature reads only what its owner granted.
 * Feature set follows NectarLink's phone side (GPL-3.0).
 */
object Hub {
    private val io = CoroutineScope(Dispatchers.IO + SupervisorJob())
    @Volatile private var started = false
    lateinit var app: Context
        private set

    fun start(ctx: Context) {
        if (started) return
        started = true
        app = ctx.applicationContext
        Toggles.start(app)
        Battery.start(app)
        Calls.start(app)
        Sms.start(app)
        Media.start(app)
    }

    /** Linked again: the PC gets the current state without asking. */
    fun onConnected() {
        if (!started) return
        io.launch {
            Toggles.push()
            Battery.push()
            Media.push()
            HubNotifications.instance?.pushAll()
        }
    }

    fun handle(m: JsonObject) = io.launch {
        val rid = m.long("rid") ?: return@launch
        val reply = runCatching { answer(m) }.getOrElse { buildJsonObject { put("ok", false); put("error", it.message ?: "failed") } }
        Link.client.sendRaw(buildJsonObject {
            put("type", "phone_res"); put("rid", rid)
            if ("ok" !in reply) put("ok", true)
            for ((k, v) in reply) put(k, v)
        }.toString())
    }

    private fun answer(m: JsonObject): JsonObject = when (m.str("svc")) {
        "hub" -> when (m.str("op")) {
            "status" -> status()
            "grant" -> obj { Grant.ask(app, m.str("what") ?: "") }
            else -> unknown(m)
        }
        "notif" -> HubNotifications.answer(m)
        "sms" -> Sms.answer(app, m)
        "calls" -> Calls.answer(app, m)
        "contacts" -> Contacts.answer(app, m)
        "toggles" -> Toggles.answer(m)
        "media" -> Media.answer(m)
        "battery" -> Battery.snapshot(app)
        "photos" -> Photos.answer(app, m)
        "find" -> Find.answer(app, m)
        "clip" -> Clip.answer(app, m)
        "link" -> {
            val url = m.str("url")?.takeIf { Regex("""^https?://\S+$""").matches(it) } ?: error("http(s) link required")
            // Android lets a background app open nothing itself; the link waits as a notification.
            Grant.open(app, android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)), "A link from your PC", url)
            obj {}
        }
        "apps" -> obj {
            val pm = app.packageManager
            put("icons", kotlinx.serialization.json.buildJsonObject {
                for (pkg in (m["pkgs"] as? kotlinx.serialization.json.JsonArray).orEmpty().take(400)) {
                    val p = (pkg as? JsonPrimitive)?.content ?: continue
                    runCatching { pm.getApplicationIcon(p).toBitmap(72, 72, android.graphics.Bitmap.Config.ARGB_8888) }.getOrNull()
                        ?.let { put(p, HubNotifications.b64(it, android.graphics.Bitmap.CompressFormat.PNG, 100)) }
                }
            })
        }
        else -> unknown(m)
    }

    fun status() = obj {
        put("notifications", HubNotifications.hasAccess(app))
        put("sms", granted(Manifest.permission.READ_SMS) && granted(Manifest.permission.SEND_SMS))
        put("calls", granted(Manifest.permission.READ_CALL_LOG) && granted(Manifest.permission.CALL_PHONE) && granted(Manifest.permission.ANSWER_PHONE_CALLS))
        put("contacts", granted(Manifest.permission.READ_CONTACTS))
        put("photos", granted(if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE))
        put("dnd", app.getSystemService(NotificationManager::class.java).isNotificationPolicyAccessGranted)
        put("writeSettings", Settings.System.canWrite(app))
    }

    fun granted(p: String) = app.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
    fun need(p: String, what: String) { if (!granted(p)) error("$what is off on the phone: turn it on from the PC's Connect page") }

    /** A change on the phone, to every PC page watching. */
    fun event(svc: String, build: JsonObjectBuilder.() -> Unit) {
        if (!started) return
        Link.client.sendRaw(buildJsonObject { put("type", "phone_evt"); put("svc", svc); build() }.toString())
    }

    private fun unknown(m: JsonObject): JsonObject = error("unknown request: ${m.str("svc")}.${m.str("op")}")
}

fun obj(build: JsonObjectBuilder.() -> Unit): JsonObject = buildJsonObject(build)
fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.contentOrNull
fun JsonObject.long(k: String): Long? = (this[k] as? JsonPrimitive)?.longOrNull
fun JsonObject.int(k: String): Int? = (this[k] as? JsonPrimitive)?.intOrNull
fun JsonObject.bool(k: String): Boolean? = (this[k] as? JsonPrimitive)?.booleanOrNull
fun JsonObjectBuilder.putNullable(k: String, v: String?) { if (v != null) put(k, v) }
fun JsonObjectBuilder.putEl(k: String, v: JsonElement) { put(k, v) }
