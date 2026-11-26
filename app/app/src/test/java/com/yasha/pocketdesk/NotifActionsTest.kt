// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.core.app.RemoteInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The session-end notification on the JVM: three actions, a reply that travels the terminal
 * composer's send path, and a dismiss that cancels the note and clears the session's unread flag.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class NotifActionsTest {

    private val ctx = ApplicationProvider.getApplicationContext<Context>()
    private val app = ctx as Application
    private val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    private val sent = mutableListOf<Pair<String, String>>()

    @Before
    fun postOneEndedSession() {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        NotifActions.replySink = { id, text -> sent += id to text; true }
        Notifier.ensureChannel(ctx)
        Notifier.sessionEnded(ctx, ID, "claude", 3)
    }

    @After
    fun forgetTheSession() {
        NotifActions.replySink = null
        Notifier.markRead(ID)
        mgr.cancelAll()
    }

    private fun note(): Notification {
        val n = shadowOf(mgr).getNotification(Notifier.sessionNotificationId(ID))
        assertNotNull("no session-end notification for $ID", n)
        return n!!
    }

    @Test
    fun `three actions named open reply dismiss with the semantics of each`() {
        val actions = note().actions!!
        val titles = actions.map { it.title.toString() }
        assertEquals("three actions: open, reply, dismiss", listOf("Open", "Reply", "Dismiss"), titles)
        assertTrue("the notification has no Reply action", "Reply" in titles)

        val open = shadowOf(actions[0].actionIntent)
        assertTrue("Open must open the app", open.isActivity)
        assertEquals(MainActivity::class.java.name, open.savedIntent.component?.className)
        assertEquals("pocketdesk://session/$ID", open.savedIntent.dataString)
        assertEquals("session:$ID", open.savedIntent.getStringExtra("open"))
        assertEquals(ID, open.savedIntent.getStringExtra(NotifActions.EXTRA_ID))

        val reply = shadowOf(actions[1].actionIntent)
        assertTrue("Reply must not need the UI", reply.isBroadcast)
        assertEquals(NotifActions.ACTION_REPLY, reply.savedIntent.action)
        assertEquals(NotifActions::class.java.name, reply.savedIntent.component?.className)
        assertEquals(ID, reply.savedIntent.getStringExtra(NotifActions.EXTRA_ID))
        val inputs = actions[1].remoteInputs!!
        assertEquals(1, inputs.size)
        assertEquals(NotifActions.KEY_REPLY, inputs[0].resultKey)
        assertTrue("the reply box must accept free text", inputs[0].allowFreeFormInput)

        val dismiss = shadowOf(actions[2].actionIntent)
        assertTrue("Dismiss must not need the UI", dismiss.isBroadcast)
        assertEquals(NotifActions.ACTION_DISMISS, dismiss.savedIntent.action)
        assertEquals(NotifActions::class.java.name, dismiss.savedIntent.component?.className)

        assertTrue("the ended session is unread until acted on", Notifier.isUnread(ID))
        assertEquals("sessions", note().channelId)
    }

    @Test
    fun `a reply result reaches the session send path and clears the note`() {
        val action = note().actions!![1]
        val fillIn = Intent()
        android.app.RemoteInput.addResultsToIntent(
            action.remoteInputs,
            fillIn,
            Bundle().apply { putCharSequence(NotifActions.KEY_REPLY, "  carry on  ") },
        )
        action.actionIntent.send(ctx, 0, fillIn)
        shadowOf(ctx.mainLooper).idle()

        assertEquals("the reply must reach the composer's send path, trimmed", listOf(ID to "carry on"), sent)
        assertFalse("an answered session is read", Notifier.isUnread(ID))
        assertNull("the answered note must go", noteOrNull())
        assertNull("a reply must not open the app", shadowOf(app).nextStartedActivity)
    }

    @Test
    fun `dismiss cancels the note and clears the session unread state`() {
        val dismiss = note().actions!![2].actionIntent
        dismiss.send(ctx, 0, null)
        shadowOf(ctx.mainLooper).idle()

        assertNull("dismiss must cancel the notification", noteOrNull())
        assertFalse("dismiss must clear unread", Notifier.isUnread(ID))
        assertTrue("dismiss must not send a message", sent.isEmpty())
        assertNull("dismiss must not open the app", shadowOf(app).nextStartedActivity)
    }

    @Test
    fun `the receiver is in the manifest, so the reply PendingIntent has a target`() {
        val component = android.content.ComponentName(ctx, NotifActions::class.java)
        val info = ctx.packageManager.getReceiverInfo(component, 0)
        assertEquals(NotifActions::class.java.name, info.name)
        assertFalse("the receiver is app-private", info.exported)

        val reachable = ctx.packageManager
            .queryBroadcastReceivers(Intent(ctx, NotifActions::class.java).setAction(NotifActions.ACTION_REPLY), 0)
            .map { it.activityInfo.name }
        assertTrue("NotifActions is declared but not reachable as a broadcast receiver", NotifActions::class.java.name in reachable)

        val reply = shadowOf(note().actions!![1].actionIntent).savedIntent
        val target = reply.component
        assertNotNull("the reply intent names no receiver", target)
        assertEquals(NotifActions::class.java.name, target!!.className)
        assertEquals(NotifActions::class.java.name, ctx.packageManager.getReceiverInfo(target, 0).name)
    }

    private fun noteOrNull() = shadowOf(mgr).getNotification(Notifier.sessionNotificationId(ID))

    private companion object {
        const val ID = "abc-123"
    }
}
