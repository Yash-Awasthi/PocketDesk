package com.yasha.pocketdesk

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.view.Display
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.serialization.json.JsonPrimitive

/**
 * The PC views and controls this phone. The owner consents every time through Android's own
 * screen-capture prompt; [ShareService] streams the screen, [ControlService] carries the PC's input.
 */
object PhoneShare {
    /** True while the screen is going to the PC; the Desktop screen shows the swap-back panel then. */
    var sharing by mutableStateOf(false)
        internal set
    @Volatile internal var service: ShareService? = null

    /** Opens Android's consent prompt; nothing is shared until the owner accepts it. */
    fun ask(ctx: Context) {
        Notifier.shareRequestGone(ctx)
        // One prompt at a time: every reload of the PC page asks again.
        if (ShareConsentActivity.open) return
        ctx.startActivity(Intent(ctx, ShareConsentActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun stop(ctx: Context) {
        ctx.stopService(Intent(ctx, ShareService::class.java))
    }

    fun onMessage(app: Context, ev: RhEvent.Phone) {
        when (ev.type) {
            // Already sharing: the daemon lost track (screen off, reconnect), so the share is announced again.
            "phone_share_request" -> if (sharing) service?.announce()
                else if (MainActivity.foreground) ask(app) else Notifier.shareRequest(app)
            "phone_share_stop" -> stop(app)
            "phone_keyframe" -> service?.keyframe()
            "phone_input" -> ControlService.instance?.input(ev.msg)
            "phone_fs" -> PhoneStorage.handle(app, ev.msg)
            "phone_switch" -> (ev.msg["pkg"] as? JsonPrimitive)?.content?.let { ControlService.instance?.switchTo(it) }
        }
    }

    /** Real pixel size of the screen in use now: the inner or cover screen of a foldable or flip phone. */
    @Suppress("DEPRECATION")
    fun screenSize(ctx: Context): Pair<Int, Int> {
        val p = android.graphics.Point()
        ctx.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY).getRealSize(p)
        return p.x to p.y
    }
}

/** Invisible: shows the system capture prompt and starts the share on yes. */
class ShareConsentActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        open = true
        if (savedInstanceState != null) return
        if (PhoneShare.sharing) { finish(); return }
        // A new token every time: the owner is asked on every share, never once for good.
        // Whole screen only: a single-app share would leave the recent-app panes blank.
        val mpm = getSystemService(MediaProjectionManager::class.java)
        @Suppress("DEPRECATION") // the result API wants a newer fragment library than one dependency pulls in
        startActivityForResult(if (Build.VERSION.SDK_INT >= 34) mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
            else mpm.createScreenCaptureIntent(), CONSENT)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == CONSENT && resultCode == Activity.RESULT_OK && data != null) {
            startForegroundService(Intent(this, ShareService::class.java)
                .putExtra(ShareService.EXTRA_CODE, resultCode).putExtra(ShareService.EXTRA_DATA, data))
        }
        finish()
    }

    override fun onDestroy() {
        open = false
        super.onDestroy()
    }

    companion object {
        @Volatile var open = false
        private const val CONSENT = 1
    }
}
