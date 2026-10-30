// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk.hub

import android.Manifest
import android.content.Context
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.CallLog
import android.provider.ContactsContract
import android.provider.Telephony as Tel
import android.telecom.TelecomManager
import android.telephony.SmsManager
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.put

// Texts, calls and contacts for the PC. Queries follow NectarLink's PhoneSms, PhoneCalls and
// PhoneContacts (GPL-3.0).

/** Contact names by number, looked up once per request. */
private class Names(private val ctx: Context) {
    private val allowed = Hub.granted(Manifest.permission.READ_CONTACTS)
    private val found = HashMap<String, String?>()
    fun of(number: String): String? = if (!allowed || number.isBlank()) null else found.getOrPut(number) {
        runCatching {
            ctx.contentResolver.query(Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number)),
                arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
        }.getOrNull()
    }
}

object Sms {
    private val main = Handler(Looper.getMainLooper())
    private val changed = Runnable { Hub.event("sms") { put("op", "changed") } }

    fun start(ctx: Context) {
        if (!Hub.granted(Manifest.permission.READ_SMS)) return
        // A burst of provider writes for one message settles into one event.
        val observer = object : ContentObserver(main) {
            override fun onChange(selfChange: Boolean) { main.removeCallbacks(changed); main.postDelayed(changed, 800) }
        }
        runCatching { ctx.contentResolver.registerContentObserver(Uri.parse("content://mms-sms/"), true, observer) }
    }

    fun answer(ctx: Context, m: JsonObject): JsonObject = when (m.str("op")) {
        "threads" -> { Hub.need(Manifest.permission.READ_SMS, "Texts"); obj { put("threads", threads(ctx, m.int("limit") ?: 80)) } }
        "messages" -> { Hub.need(Manifest.permission.READ_SMS, "Texts"); obj { put("messages", messages(ctx, m.long("thread") ?: error("thread required"), m.int("limit") ?: 120)) } }
        "send" -> {
            Hub.need(Manifest.permission.SEND_SMS, "Sending texts")
            val to = m.str("address")?.trim()?.takeIf { it.isNotEmpty() } ?: error("number required")
            val text = m.str("text")?.takeIf { it.isNotEmpty() } ?: error("text required")
            val sms = ctx.getSystemService(SmsManager::class.java)
            sms.sendMultipartTextMessage(to, null, sms.divideMessage(text), null, null)
            obj {}
        }
        else -> error("unknown op")
    }

    private fun threads(ctx: Context, limit: Int) = buildJsonArray {
        val r = ctx.contentResolver
        val addresses = r.query(Uri.parse("content://mms-sms/canonical-addresses"), arrayOf("_id", "address"), null, null, null)?.use { c ->
            buildMap { while (c.moveToNext()) c.getString(1)?.let { put(c.getLong(0), it) } }
        }.orEmpty()
        val names = Names(ctx)
        r.query(Uri.parse("content://mms-sms/conversations?simple=true"),
            arrayOf(Tel.Threads._ID, Tel.Threads.DATE, Tel.Threads.RECIPIENT_IDS, Tel.Threads.SNIPPET, Tel.Threads.READ),
            null, null, "${Tel.Threads.DATE} DESC")?.use { c ->
            var n = 0
            while (n < limit && c.moveToNext()) {
                val people = c.getString(2).orEmpty().split(' ').mapNotNull { it.toLongOrNull()?.let(addresses::get) }
                if (people.isEmpty()) continue
                n++
                add(obj {
                    put("id", c.getLong(0)); put("address", people.joinToString(", ")); put("date", c.getLong(1))
                    putNullable("name", people.map { names.of(it) ?: it }.joinToString(", ").takeIf { people.any { p -> names.of(p) != null } })
                    put("snippet", c.getString(3).orEmpty()); put("unread", c.getInt(4) == 0)
                })
            }
        }
    }

    private fun messages(ctx: Context, thread: Long, limit: Int) = buildJsonArray {
        val list = ctx.contentResolver.query(Tel.Sms.CONTENT_URI, arrayOf(Tel.Sms.BODY, Tel.Sms.DATE, Tel.Sms.TYPE, Tel.Sms.ADDRESS),
            "${Tel.Sms.THREAD_ID} = ?", arrayOf(thread.toString()), "${Tel.Sms.DATE} DESC")?.use { c ->
            buildList { while (size < limit && c.moveToNext()) add(obj {
                put("text", c.getString(0).orEmpty()); put("date", c.getLong(1)); put("out", c.getInt(2) != Tel.Sms.MESSAGE_TYPE_INBOX)
                put("address", c.getString(3).orEmpty())
                if (c.getInt(2) == Tel.Sms.MESSAGE_TYPE_FAILED) put("failed", true)
            }) }
        }.orEmpty()
        for (o in list.reversed()) add(o)
    }
}

object Calls {
    @Volatile private var last: String? = null
    // Android holds the callback weakly; without this reference it stops firing after a GC.
    private var callback: TelephonyCallback? = null

    fun start(ctx: Context) {
        if (callback != null || !Hub.granted(Manifest.permission.READ_PHONE_STATE)) return
        val tm = ctx.getSystemService(TelephonyManager::class.java)
        runCatching {
            val cb = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                override fun onCallStateChanged(state: Int) {
                    val s = when (state) { TelephonyManager.CALL_STATE_RINGING -> "ringing"; TelephonyManager.CALL_STATE_OFFHOOK -> "active"; else -> "idle" }
                    if (s == last) return
                    last = s
                    if (s == "idle") return Hub.event("call") { put("state", s) }
                    // Android gives the ringing number only to the dialer; its call notification's title, posted
                    // a moment after the ring, stands in.
                    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                        val caller = HubNotifications.instance?.let { l -> runCatching { l.activeNotifications }.getOrNull()
                            ?.firstOrNull { it.notification.category == android.app.Notification.CATEGORY_CALL } }
                            ?.notification?.extras?.getCharSequence(android.app.Notification.EXTRA_TITLE)?.toString()
                        if (last == s) Hub.event("call") { put("state", s); putNullable("name", caller) }
                    }, 700)
                }
            }
            tm.registerTelephonyCallback(ctx.mainExecutor, cb)
            callback = cb
        }
    }

    private fun telecom(ctx: Context) = ctx.getSystemService(TelecomManager::class.java)

    @Suppress("MissingPermission")
    fun answer(ctx: Context, m: JsonObject): JsonObject = when (m.str("op")) {
        "log" -> { Hub.need(Manifest.permission.READ_CALL_LOG, "The call log"); obj { put("calls", log(ctx, m.int("limit") ?: 100)) } }
        "dial" -> {
            Hub.need(Manifest.permission.CALL_PHONE, "Calling")
            val number = m.str("number")?.filter { it.isDigit() || it in "+*#," }?.takeIf { it.isNotEmpty() } ?: error("number required")
            telecom(ctx).placeCall(Uri.fromParts("tel", number, null), android.os.Bundle())
            obj {}
        }
        "answer" -> { Hub.need(Manifest.permission.ANSWER_PHONE_CALLS, "Answering calls"); telecom(ctx).acceptRingingCall(); obj {} }
        "end" -> { Hub.need(Manifest.permission.ANSWER_PHONE_CALLS, "Ending calls"); @Suppress("DEPRECATION") telecom(ctx).endCall(); obj {} }
        "silence" -> { Hub.need(Manifest.permission.ANSWER_PHONE_CALLS, "Silencing calls"); telecom(ctx).silenceRinger(); obj {} }
        else -> error("unknown op")
    }

    private fun log(ctx: Context, limit: Int) = buildJsonArray {
        ctx.contentResolver.query(CallLog.Calls.CONTENT_URI,
            arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION),
            null, null, "${CallLog.Calls.DATE} DESC")?.use { c ->
            var n = 0
            while (n++ < limit && c.moveToNext()) add(obj {
                put("number", c.getString(0).orEmpty()); putNullable("name", c.getString(1)); put("kind", c.getInt(2))
                put("date", c.getLong(3)); put("duration", c.getLong(4))
            })
        }
    }
}

object Contacts {
    fun answer(ctx: Context, m: JsonObject): JsonObject {
        Hub.need(Manifest.permission.READ_CONTACTS, "Contacts")
        val q = m.str("q")?.trim().orEmpty()
        val uri = if (q.isEmpty()) ContactsContract.CommonDataKinds.Phone.CONTENT_URI
            else Uri.withAppendedPath(ContactsContract.CommonDataKinds.Phone.CONTENT_FILTER_URI, Uri.encode(q))
        val byName = LinkedHashMap<String, MutableSet<String>>()
        ctx.contentResolver.query(uri, arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER),
            null, null, "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC")?.use { c ->
            while (c.moveToNext() && byName.size < 60) {
                val name = c.getString(0) ?: continue
                byName.getOrPut(name) { linkedSetOf() }.add(c.getString(1).orEmpty().replace(" ", ""))
            }
        }
        return obj {
            put("contacts", buildJsonArray {
                for ((name, numbers) in byName) add(obj { put("name", name); put("numbers", buildJsonArray { numbers.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }) })
            })
        }
    }
}
