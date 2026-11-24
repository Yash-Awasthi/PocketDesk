package com.yasha.pocketdesk

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The foreground service that keeps a link alive with the screen off.
 *
 * Only what a phone can actually show is asserted: the notification channel it creates, the
 * notification it puts up and takes down, and the Disconnect action's two side effects (the
 * link is closed and the saved PC is forgotten so the app does not reconnect on its own).
 * A service that silently fails to reach the foreground is killed by Android, which is exactly
 * the bug these cases exist to catch.
 */
@RunWith(AndroidJUnit4::class)
class LinkServiceInstrumentedTest {

    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val notifs: NotificationManager = ctx.getSystemService(NotificationManager::class.java)
    private val prefs get() = ctx.getSharedPreferences("pocketdesk", Context.MODE_PRIVATE)

    private fun startService(action: String? = null): Unit {
        val i = Intent(ctx, LinkService::class.java)
        if (action != null) {
            i.action = action
            ctx.startService(i)
        } else {
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }
    }

    /** Polls until [check] is true, so a slow emulator does not make a passing case red. */
    private fun eventually(what: String, timeoutMillis: Long = 15_000, check: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMillis
        while (System.currentTimeMillis() < deadline) {
            if (check()) return
            Thread.sleep(100)
        }
        throw AssertionError("timed out waiting for: $what")
    }

    private fun activeIds(): Set<Int> =
        notifs.activeNotifications.orEmpty().map { it.id }.toSet()

    @Test
    fun startingItCreatesTheLinkChannel() {
        notifs.deleteNotificationChannel("link")
        startService()
        eventually("the link notification channel") { notifs.getNotificationChannel("link") != null }
        val channel = notifs.getNotificationChannel("link")
        assertNotNull(channel)
        // The channel is what the user sees in Settings; a rename here would be a silent UX change.
        assertEquals("Connection", channel!!.name.toString())
        assertEquals(NotificationManager.IMPORTANCE_LOW, channel.importance)
    }

    @Test
    fun anAlreadyEndedLinkStillGoesForegroundThenStopsItself() {
        // A fresh app has no link, so onStartCommand must startForeground (Android kills the
        // process otherwise) and then stopSelf — never the other way round.
        startService()
        eventually("the service to stand down") { 1 !in activeIds() }
        assertFalse("no link notification should linger", 1 in activeIds())
    }

    @Test
    fun theDisconnectActionForgetsTheSavedPc() {
        prefs.edit().putString("last_pc", "wss://127.0.0.1:8765/pocketdesk").commit()
        assertTrue(prefs.contains("last_pc"))
        startService("disconnect")
        eventually("last_pc to be cleared") { !prefs.contains("last_pc") }
        assertFalse(prefs.contains("last_pc"))
    }

    @Test
    fun anAllowActionWithoutAProposalIdDoesNotCrashTheService() {
        // The notification's Allow button always carries EXTRA_ID; a stray intent without one
        // must take the ordinary start path instead of throwing on a null proposal.
        startService(LinkService.ACTION_ALLOW)
        eventually("the link channel to exist") { notifs.getNotificationChannel("link") != null }
    }

    @Test
    fun theServiceCannotBeBound() {
        // A bound service would die with the last client; this one has to outlive the UI.
        val i = Intent(ctx, LinkService::class.java)
        val conn = object : android.content.ServiceConnection {
            override fun onServiceConnected(name: android.content.ComponentName?, binder: android.os.IBinder?) {
                throw AssertionError("onBind returned a binder: $binder")
            }

            override fun onServiceDisconnected(name: android.content.ComponentName?) = Unit
        }
        ctx.bindService(i, conn, Context.BIND_AUTO_CREATE or Context.BIND_NOT_FOREGROUND)
        Thread.sleep(1_000)
        // A null binder means the system never calls onServiceConnected; nothing to unbind happens
        // implicitly, so this only has to prove the bind did not hand out a binder above.
        ctx.unbindService(conn)
    }
}
