// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk.hub

import android.Manifest
import android.app.NotificationManager
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.ContentObserver
import android.graphics.Bitmap
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.RingtoneManager
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.util.Size
import androidx.core.content.ContextCompat
import androidx.core.graphics.scale
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.put
import kotlin.math.roundToInt

// Quick settings, battery, what is playing, photos, ringing and the clipboard, for the PC.
// Quick settings and ringing follow NectarLink's PhoneToggles and Ringer (GPL-3.0).

private val main = Handler(Looper.getMainLooper())

object Toggles {
    private lateinit var ctx: Context
    private var torchId: String? = null
    @Volatile private var torch = false
    private var last: JsonObject? = null
    private val emit = Runnable { push() }
    private fun schedule() { main.removeCallbacks(emit); main.postDelayed(emit, 150) }

    fun start(c: Context) {
        ctx = c
        val cam = ctx.getSystemService(CameraManager::class.java)
        torchId = runCatching {
            cam.cameraIdList.firstOrNull { cam.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
        }.getOrNull()
        if (torchId != null) runCatching {
            cam.registerTorchCallback(object : CameraManager.TorchCallback() {
                override fun onTorchModeChanged(id: String, on: Boolean) { if (id == torchId) { torch = on; schedule() } }
            }, main)
        }
        runCatching { ctx.contentResolver.registerContentObserver(Settings.System.getUriFor(Settings.System.SCREEN_BRIGHTNESS), false, object : ContentObserver(main) { override fun onChange(s: Boolean) = schedule() }) }
        val f = IntentFilter().apply {
            addAction(NotificationManager.ACTION_INTERRUPTION_FILTER_CHANGED); addAction(AudioManager.RINGER_MODE_CHANGED_ACTION)
            addAction("android.media.VOLUME_CHANGED_ACTION"); addAction(WifiManager.WIFI_STATE_CHANGED_ACTION)
            addAction(android.bluetooth.BluetoothAdapter.ACTION_STATE_CHANGED)
        }
        ContextCompat.registerReceiver(ctx, object : BroadcastReceiver() { override fun onReceive(c: Context, i: Intent) = schedule() }, f, ContextCompat.RECEIVER_EXPORTED)
    }

    private fun snapshot(): JsonObject {
        val am = ctx.getSystemService(AudioManager::class.java)
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val min = am.getStreamMinVolume(AudioManager.STREAM_MUSIC)
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(min + 1)
        return obj {
            put("dnd", nm.currentInterruptionFilter.let { it != NotificationManager.INTERRUPTION_FILTER_ALL && it != NotificationManager.INTERRUPTION_FILTER_UNKNOWN })
            put("ringer", when (am.ringerMode) { AudioManager.RINGER_MODE_SILENT -> "silent"; AudioManager.RINGER_MODE_VIBRATE -> "vibrate"; else -> "ring" })
            if (torchId != null) put("flashlight", torch)
            put("volume", (((am.getStreamVolume(AudioManager.STREAM_MUSIC) - min) * 100f) / (max - min)).roundToInt())
            put("brightness", (Settings.System.getInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS, 128) * 100f / 255f).roundToInt())
            put("wifi", runCatching { ctx.getSystemService(WifiManager::class.java).isWifiEnabled }.getOrDefault(false))
            put("bluetooth", runCatching { ctx.getSystemService(BluetoothManager::class.java).adapter?.isEnabled == true }.getOrDefault(false))
        }
    }

    @Synchronized fun push() {
        if (!::ctx.isInitialized) return
        val now = snapshot()
        last = now
        Hub.event("toggles") { for ((k, v) in now) put(k, v) }
    }

    fun answer(m: JsonObject): JsonObject {
        val am = ctx.getSystemService(AudioManager::class.java)
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (m.str("op") == "get") return snapshot()
        when (m.str("id")) {
            "dnd" -> {
                if (!nm.isNotificationPolicyAccessGranted) error("Do not disturb access is off on the phone: turn it on from the PC's Connect page")
                nm.setInterruptionFilter(if (m.bool("on") == true) NotificationManager.INTERRUPTION_FILTER_PRIORITY else NotificationManager.INTERRUPTION_FILTER_ALL)
            }
            "ringer" -> {
                val mode = when (m.str("mode")) { "silent" -> AudioManager.RINGER_MODE_SILENT; "vibrate" -> AudioManager.RINGER_MODE_VIBRATE; else -> AudioManager.RINGER_MODE_NORMAL }
                if ((mode == AudioManager.RINGER_MODE_SILENT || am.ringerMode == AudioManager.RINGER_MODE_SILENT) && !nm.isNotificationPolicyAccessGranted) error("Silent needs Do not disturb access on the phone")
                am.ringerMode = mode
            }
            "flashlight" -> ctx.getSystemService(CameraManager::class.java).setTorchMode(torchId ?: error("no flashlight"), m.bool("on") == true)
            "volume" -> {
                val min = am.getStreamMinVolume(AudioManager.STREAM_MUSIC)
                val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                am.setStreamVolume(AudioManager.STREAM_MUSIC, min + (((m.int("level") ?: 50).coerceIn(0, 100) / 100f) * (max - min)).roundToInt(), 0)
            }
            "brightness" -> {
                if (!Settings.System.canWrite(ctx)) error("Brightness needs \"Modify system settings\" on the phone: turn it on from the PC's Connect page")
                Settings.System.putInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS, ((m.int("level") ?: 50).coerceIn(0, 100) * 255f / 100f).roundToInt())
            }
            // Android lets an ordinary app open the panel only; phone control (adb) switches them outright.
            "wifi" -> Grant.open(ctx, Intent(Settings.Panel.ACTION_WIFI))
            "bluetooth" -> Grant.open(ctx, Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
            else -> error("unknown setting")
        }
        main.postDelayed(emit, 300)
        return obj {}
    }
}

object Battery {
    private var lastLevel = -1
    private var lastCharging: Boolean? = null

    fun start(ctx: Context) {
        ContextCompat.registerReceiver(ctx, object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) * 100 / i.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1)
                val charging = i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
                if (level == lastLevel && charging == lastCharging) return
                lastLevel = level; lastCharging = charging
                push(c)
            }
        }, IntentFilter(Intent.ACTION_BATTERY_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    fun push(ctx: Context = Hub.app) { val s = snapshot(ctx); Hub.event("battery") { for ((k, v) in s) put(k, v) } }

    fun snapshot(ctx: Context): JsonObject {
        val i = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        return obj {
            put("level", (i?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1) * 100 / (i?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100).coerceAtLeast(1))
            put("charging", (i?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0)
            put("temp", (i?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0) / 10.0)
        }
    }
}

/** What the phone plays, from the media sessions notification access lets us see. */
object Media {
    private var ctx: Context? = null
    private var watching = emptyList<MediaController>()
    private val emit = Runnable { push() }
    private val cb = object : MediaController.Callback() {
        override fun onMetadataChanged(metadata: MediaMetadata?) = schedule()
        override fun onPlaybackStateChanged(state: PlaybackState?) = schedule()
        override fun onSessionDestroyed() = schedule()
    }
    private fun schedule() { main.removeCallbacks(emit); main.postDelayed(emit, 250) }

    fun start(c: Context) {
        ctx = c
        if (!HubNotifications.hasAccess(c)) return
        main.post {
            runCatching {
                val msm = c.getSystemService(MediaSessionManager::class.java)
                val comp = HubNotifications.component(c)
                msm.addOnActiveSessionsChangedListener({ watch(it.orEmpty()) }, comp, main)
                watch(msm.getActiveSessions(comp))
            }
        }
    }

    private fun watch(list: List<MediaController>) {
        for (c in watching) runCatching { c.unregisterCallback(cb) }
        watching = list
        for (c in list) c.registerCallback(cb, main)
        schedule()
    }

    private fun current() = watching.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING } ?: watching.firstOrNull()

    fun push() {
        val c = current()
        val md = c?.metadata
        Hub.event("media") {
            if (c == null || md == null) return@event
            putNullable("title", md.getString(MediaMetadata.METADATA_KEY_TITLE))
            putNullable("artist", md.getString(MediaMetadata.METADATA_KEY_ARTIST) ?: md.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST))
            putNullable("album", md.getString(MediaMetadata.METADATA_KEY_ALBUM))
            put("app", runCatching { ctx!!.packageManager.getApplicationLabel(ctx!!.packageManager.getApplicationInfo(c.packageName, 0)).toString() }.getOrDefault(c.packageName))
            put("playing", c.playbackState?.state == PlaybackState.STATE_PLAYING)
            put("position", c.playbackState?.position ?: 0); put("duration", md.getLong(MediaMetadata.METADATA_KEY_DURATION))
            (md.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART) ?: md.getBitmap(MediaMetadata.METADATA_KEY_ART))?.let { b ->
                val k = minOf(1f, 256f / maxOf(b.width, b.height))
                put("art", HubNotifications.b64(if (k < 1f) b.scale((b.width * k).toInt().coerceAtLeast(1), (b.height * k).toInt().coerceAtLeast(1)) else b, Bitmap.CompressFormat.JPEG, 80))
            }
        }
    }

    fun answer(m: JsonObject): JsonObject {
        val t = (current() ?: error("nothing is playing")).transportControls
        when (m.str("op")) {
            "play" -> t.play(); "pause" -> t.pause(); "next" -> t.skipToNext(); "prev" -> t.skipToPrevious()
            "seek" -> t.seekTo(m.long("position") ?: 0)
            else -> error("unknown op")
        }
        return obj {}
    }
}

object Photos {
    private const val CHUNK = 384 shl 10

    fun answer(ctx: Context, m: JsonObject): JsonObject {
        Hub.need(if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE, "Photos")
        return when (m.str("op")) {
            "list" -> list(ctx, m.int("offset") ?: 0, (m.int("limit") ?: 60).coerceIn(1, 200))
            "read" -> read(ctx, m.long("id") ?: error("id required"), m.long("offset") ?: 0)
            else -> error("unknown op")
        }
    }

    private val files = MediaStore.Files.getContentUri("external")

    private fun list(ctx: Context, offset: Int, limit: Int) = obj {
        val r = ctx.contentResolver
        val args = android.os.Bundle().apply {
            putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN (?, ?)")
            putStringArray(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, arrayOf(
                MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE.toString(), MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO.toString()))
            putStringArray(android.content.ContentResolver.QUERY_ARG_SORT_COLUMNS, arrayOf(MediaStore.Files.FileColumns.DATE_ADDED))
            putInt(android.content.ContentResolver.QUERY_ARG_SORT_DIRECTION, android.content.ContentResolver.QUERY_SORT_DIRECTION_DESCENDING)
            putInt(android.content.ContentResolver.QUERY_ARG_LIMIT, limit)
            putInt(android.content.ContentResolver.QUERY_ARG_OFFSET, offset)
        }
        put("items", buildJsonArray {
            r.query(files, arrayOf(MediaStore.Files.FileColumns._ID, MediaStore.Files.FileColumns.DISPLAY_NAME, MediaStore.Files.FileColumns.SIZE,
                MediaStore.Files.FileColumns.DATE_ADDED, MediaStore.Files.FileColumns.MIME_TYPE, MediaStore.Files.FileColumns.MEDIA_TYPE), args, null)?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getLong(0)
                    val video = c.getInt(5) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
                    val uri = ContentUris.withAppendedId(if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
                    add(obj {
                        put("id", id); put("name", c.getString(1).orEmpty()); put("size", c.getLong(2)); put("date", c.getLong(3) * 1000)
                        put("mime", c.getString(4).orEmpty()); put("video", video)
                        runCatching { r.loadThumbnail(uri, Size(240, 240), null) }.getOrNull()?.let { put("thumb", HubNotifications.b64(it, Bitmap.CompressFormat.JPEG, 70)) }
                    })
                }
            }
        })
    }

    private fun read(ctx: Context, id: Long, offset: Long) = obj {
        val uri = ContentUris.withAppendedId(files, id)
        ctx.contentResolver.openFileDescriptor(uri, "r")?.use { pfd ->
            java.io.FileInputStream(pfd.fileDescriptor).use { s ->
                val size = pfd.statSize
                s.channel.position(offset)
                val buf = ByteArray(minOf(CHUNK.toLong(), (size - offset).coerceAtLeast(0)).toInt())
                var n = 0
                while (n < buf.size) { val k = s.read(buf, n, buf.size - n); if (k < 0) break; n += k }
                put("data", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)); put("size", size); put("eof", offset + n >= size)
            }
        } ?: error("cannot open that photo")
    }
}

/** Find my phone: the alarm sound at full volume for 30 s, whatever the ringer says. */
object Find {
    private var ringtone: android.media.Ringtone? = null
    private var saved = -1

    fun answer(ctx: Context, m: JsonObject): JsonObject {
        val am = ctx.getSystemService(AudioManager::class.java)
        if (m.str("op") == "stop") { stop(am); return obj {} }
        stop(am)
        saved = am.getStreamVolume(AudioManager.STREAM_ALARM)
        am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        ringtone = RingtoneManager.getRingtone(ctx, uri)?.apply {
            audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
            isLooping = true
            play()
        }
        main.postDelayed({ stop(am) }, 30_000)
        return obj {}
    }

    private fun stop(am: AudioManager) {
        ringtone?.stop()
        ringtone = null
        if (saved >= 0) { am.setStreamVolume(AudioManager.STREAM_ALARM, saved, 0); saved = -1 }
    }
}

/** The phone's clipboard; Android lets a background app write it, and read it only while in front. */
object Clip {
    fun answer(ctx: Context, m: JsonObject): JsonObject {
        val cm = ctx.getSystemService(ClipboardManager::class.java)
        return when (m.str("op")) {
            "set" -> { main.post { cm.setPrimaryClip(ClipData.newPlainText("PocketDesk", m.str("text").orEmpty())) }; obj {} }
            "get" -> obj { putNullable("text", cm.primaryClip?.getItemAt(0)?.coerceToText(ctx)?.toString() ?: error("Android lets the phone app read the clipboard only while it is open; phone control reads it any time")) }
            else -> error("unknown op")
        }
    }
}

/** What the PC copies lands on this phone's clipboard; what this phone copies goes back while the app is open. */
object ClipSync {
    private var last: String? = null

    fun fromPc(ctx: Context, m: JsonObject) {
        val cm = ctx.getSystemService(ClipboardManager::class.java)
        val text = m.str("text")
        val png = m.str("png")
        main.post {
            if (text != null) {
                last = text
                cm.setPrimaryClip(ClipData.newPlainText("PC", text))
            } else if (png != null) {
                val dir = java.io.File(ctx.cacheDir, "clip").apply { mkdirs() }
                val file = java.io.File(dir, "pc.png").apply { writeBytes(Base64.decode(png, Base64.DEFAULT)) }
                val uri = androidx.core.content.FileProvider.getUriForFile(ctx, ctx.packageName + ".files", file)
                cm.setPrimaryClip(ClipData.newUri(ctx.contentResolver, "PC picture", uri))
            }
        }
    }

    /** Android hands the clipboard only to the app in front, so this runs while it is. */
    private val listener = ClipboardManager.OnPrimaryClipChangedListener { sendIfNew() }

    fun onForeground(ctx: Context, on: Boolean) {
        val cm = ctx.getSystemService(ClipboardManager::class.java)
        if (on) { cm.addPrimaryClipChangedListener(listener); main.postDelayed({ sendIfNew() }, 500) }
        else cm.removePrimaryClipChangedListener(listener)
    }

    private fun sendIfNew() {
        val ctx = Hub.app
        val clip = ctx.getSystemService(ClipboardManager::class.java).primaryClip ?: return
        // Password managers mark what they copy as sensitive; that never leaves the phone.
        if (clip.description.extras?.getBoolean("android.content.extra.IS_SENSITIVE") == true) return
        val text = clip.getItemAt(0)?.coerceToText(ctx)?.toString()?.takeIf { it.isNotEmpty() } ?: return
        if (text == last) return
        last = text
        com.yasha.pocketdesk.Link.client.sendRaw(obj { put("type", "phone_clip"); put("text", text.take(200_000)) }.toString())
    }
}

/** This PC's notifications, shown on the phone. */
object PcNotifs {
    private const val CHANNEL = "pc_notifs"
    private var next = 1000

    fun post(ctx: Context, m: JsonObject) {
        if (!com.yasha.pocketdesk.Notifier.canNotify(ctx)) return
        val mgr = ctx.getSystemService(NotificationManager::class.java)
        if (mgr.getNotificationChannel(CHANNEL) == null) {
            mgr.createNotificationChannel(android.app.NotificationChannel(CHANNEL, "Notifications from your PC", NotificationManager.IMPORTANCE_DEFAULT))
        }
        val app = m.str("appName").orEmpty()
        val n = androidx.core.app.NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_info_details)
            .setContentTitle(m.str("title") ?: app)
            .setContentText(m.str("body"))
            .setStyle(androidx.core.app.NotificationCompat.BigTextStyle().bigText(m.str("body")))
            .setSubText(app.ifEmpty { null })
            .setWhen(m.long("at") ?: System.currentTimeMillis())
            .setShowWhen(true)
            .setAutoCancel(true)
            .build()
        // One app's toasts stack per app; ids wrap so the shade never fills with old ones.
        mgr.notify("pc:${m.str("app")}", next++ % 1000 + 1000, n)
    }
}
