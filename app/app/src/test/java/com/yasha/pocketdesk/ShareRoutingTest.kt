package com.yasha.pocketdesk

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.ByteArrayInputStream
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAlertDialog

/** The share sheet's second half: staged copies, routing, the one-time chooser, the remembered pick. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class ShareRoutingTest {
    private lateinit var ctx: Context
    private lateinit var fake: FakeTransport

    @Before
    fun setUp() {
        ctx = ApplicationProvider.getApplicationContext()
        ctx.getSharedPreferences("pocketdesk", Context.MODE_PRIVATE).edit().clear().commit()
        fake = FakeTransport()
        ShareRouter.transport = fake
        ShareRouter.worker = { it() }
    }

    @After
    fun tearDown() {
        ShareRouter.resetTransport()
    }

    private fun uri(name: String, body: String): Uri {
        val u = Uri.parse("content://share/$name")
        Shadows.shadowOf(ctx.contentResolver).registerInputStream(u, ByteArrayInputStream(body.toByteArray()))
        return u
    }

    private fun single(uri: Uri): Intent =
        Intent(ctx, SendToPcActivity::class.java)
            .setAction(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_STREAM, uri)

    private fun multiple(uris: List<Uri>): Intent =
        Intent(ctx, SendToPcActivity::class.java)
            .setAction(Intent.ACTION_SEND_MULTIPLE)
            .setType("text/plain")
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))

    private fun launch(intent: Intent): SendToPcActivity {
        val activity = Robolectric.buildActivity(SendToPcActivity::class.java, intent).setup().get()
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
        return activity
    }

    @Test
    fun `a shared content uri is copied and queued to the active session`() {
        val session = SessionSummary("s1", "claude", "/home/yash/proj")
        fake.sessions = listOf(session)
        fake.activeSession = session
        val before = ShadowAlertDialog.getLatestAlertDialog()

        launch(single(uri("notes.txt", "hello from the share sheet")))

        assertEquals("an active session must be used without asking",
            listOf("/home/yash/proj/notes.txt"), fake.targets)
        assertEquals("hello from the share sheet", fake.bodies.single())
        assertSame("no chooser when a session is active", before, ShadowAlertDialog.getLatestAlertDialog())
    }

    @Test
    fun `three shared uris are queued in order`() {
        val session = SessionSummary("s1", "claude", "/home/yash/proj")
        fake.sessions = listOf(session)
        fake.activeSession = session

        launch(multiple(listOf(uri("a.txt", "A"), uri("b.txt", "B"), uri("c.txt", "C"))))

        assertEquals("the share order is the queue order", listOf(
            "/home/yash/proj/a.txt",
            "/home/yash/proj/b.txt",
            "/home/yash/proj/c.txt",
        ), fake.targets)
        assertEquals(listOf("A", "B", "C"), fake.bodies)
    }

    @Test
    fun `no active session asks once with sessions and folders`() {
        fake.sessions = emptyList()
        fake.activeSession = null
        fake.knownFolders = listOf("/home/yash/inbox")
        val before = ShadowAlertDialog.getLatestAlertDialog()

        val activity = launch(single(uri("notes.txt", "hello")))

        assertNotSame("the chooser must be shown", before, ShadowAlertDialog.getLatestAlertDialog())
        assertFalse(activity.isFinishing)
        assertEquals("nothing is sent before the owner picks", emptyList<String>(), fake.targets)
    }

    @Test
    fun `the remembered destination is reused without asking`() {
        fake.sessions = emptyList()
        fake.activeSession = null
        ctx.getSharedPreferences("pocketdesk", Context.MODE_PRIVATE).edit()
            .putString("share_destination", "f:/home/yash/inbox").commit()
        val before = ShadowAlertDialog.getLatestAlertDialog()

        launch(single(uri("notes.txt", "remembered")))

        assertSame("the remembered pick skips the chooser", before, ShadowAlertDialog.getLatestAlertDialog())
        assertEquals(listOf("/home/yash/inbox/notes.txt"), fake.targets)
        assertEquals("remembered", fake.bodies.single())
    }

    private class FakeTransport : ShareTransport {
        override var connected = true
        override var sessions = emptyList<SessionSummary>()
        override var knownFolders = emptyList<String>()
        override var activeSession: SessionSummary? = null

        val targets = mutableListOf<String>()
        val bodies = mutableListOf<String>()

        override fun upload(remotePath: String, open: () -> java.io.InputStream?, size: Long?, onDone: (String?) -> Unit) {
            val bytes = open()?.use { it.readBytes() } ?: ByteArray(0)
            targets += remotePath
            bodies += String(bytes)
            onDone(null)
        }

        override fun handoff(text: String) {}
        override fun filesCopied(paths: List<String>) {}
    }
}

