package com.yasha.pocketdesk

import android.content.Context
import android.content.ContextWrapper
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.Looper
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.FileDescriptor
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

/** A long-lived root shell on a phone rooted with su; commands go in one per line. */
object Root {
    private var shell: Process? = null
    private var ok: Boolean? = null

    /** Whether su gives root; asked once per run, since su may put a prompt in front of the owner. */
    @Synchronized fun available(): Boolean = ok ?: runCatching {
        val p = ProcessBuilder("su", "-c", "id").redirectErrorStream(true).start()
        p.outputStream.close()
        p.waitFor(30, TimeUnit.SECONDS) && p.inputStream.bufferedReader().readText().contains("uid=0")
    }.getOrDefault(false).also { ok = it }

    /** Runs [cmd] as root and waits for it to finish. */
    fun exec(cmd: String) = runCatching {
        ProcessBuilder("su", "-c", cmd).redirectErrorStream(true).start().apply { outputStream.close() }.waitFor(10, TimeUnit.SECONDS)
    }

    @Synchronized fun run(cmd: String) {
        val p = shell?.takeIf { it.isAlive } ?: runCatching { ProcessBuilder("su").redirectErrorStream(true).start() }.getOrNull()?.also { p ->
            shell = p
            Thread { runCatching { val b = ByteArray(4096); while (p.inputStream.read(b) >= 0) Unit } }.start()
        } ?: return
        runCatching { p.outputStream.write((cmd + "\n").toByteArray()); p.outputStream.flush() }
    }
}

/**
 * Root helper for live panes, run through su with app_process. An app can only make private displays, and
 * another app's process cannot see those (an app opening a second app's screen on a pane crashed), so the
 * displays are made here. Commands come in on stdin, one per line: `open SLOT W H DPI`, `key SLOT`,
 * `close SLOT`; out on stdout go [type u8][slot u8][length u32][body], type 0 a display id, type 1 a video packet.
 */
object PaneServer {
    private val out = DataOutputStream(BufferedOutputStream(FileOutputStream(FileDescriptor.out)))

    @Synchronized private fun frame(type: Int, slot: Int, body: ByteArray) {
        out.writeByte(type); out.writeByte(slot); out.writeInt(body.size); out.write(body); out.flush()
    }

    private class Shell(base: Context) : ContextWrapper(base) {
        override fun getPackageName() = "com.android.shell"
        override fun getOpPackageName() = "com.android.shell"
    }

    @JvmStatic fun main(args: Array<String>) {
        Looper.prepareMainLooper()
        val thread = Class.forName("android.app.ActivityThread").getMethod("systemMain").invoke(null)
        val system = thread.javaClass.getMethod("getSystemContext").invoke(thread) as Context
        val dm = DisplayManager::class.java.getDeclaredConstructor(Context::class.java).apply { isAccessible = true }.newInstance(Shell(system))
        val panes = HashMap<Int, Pair<VirtualDisplay, Encoder>>()
        System.`in`.bufferedReader().forEachLine { line ->
            val a = line.trim().split(" ")
            val slot = a.getOrNull(1)?.toIntOrNull() ?: return@forEachLine
            when (a[0]) {
                "open" -> runCatching {
                    val (w, h, dpi) = a.drop(2).map { it.toInt() }
                    val enc = Encoder(w to h, BITRATE) { kind, data -> frame(1, slot, byteArrayOf(kind.toByte()) + data) }
                    val d = dm.createVirtualDisplay("PocketDesk pane $slot", w, h, dpi, enc.surface,
                        DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC or DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY)
                    panes[slot] = d to enc
                    frame(0, slot, java.nio.ByteBuffer.allocate(4).putInt(d.display.displayId).array())
                }
                "key" -> panes[slot]?.second?.keyframe()
                "close" -> panes.remove(slot)?.let { (d, e) -> d.release(); e.stop() }
            }
        }
        // stdin closed: the app is gone, and its panes with it.
        panes.values.forEach { (d, e) -> d.release(); e.stop() }
    }

    private const val BITRATE = 2_000_000
}

/**
 * Rooted phones only: up to [MAX] recent apps each run on a display of their own, made and encoded by
 * [PaneServer], so every pane on the PC stays live and takes input without switching apps.
 */
class RootPanes(private val ctx: Context, screen: Pair<Int, Int>) {
    private class Pane(val slot: Int, val pkg: String, val sink: LinkSink) { @Volatile var display = -1 }
    private val panes = HashMap<Int, Pane>()
    // Half the shared size at a density scaled to match: apps lay out as on the phone for a quarter of the pixels.
    private val size = screen.first / 2 / 8 * 8 to screen.second / 2 / 8 * 8
    private val dpi = ctx.resources.displayMetrics.densityDpi * size.first / PhoneShare.screenSize(ctx).first
    private val helper = ProcessBuilder("su", "-c", "CLASSPATH=${ctx.applicationInfo.sourceDir} exec app_process / ${PaneServer::class.java.name}").start()
    private val commands = helper.outputStream.bufferedWriter()

    private var front: String? = null

    init {
        Thread {
            runCatching {
                val input = DataInputStream(BufferedInputStream(helper.inputStream))
                while (true) {
                    val type = input.readUnsignedByte()
                    val slot = input.readUnsignedByte()
                    val body = ByteArray(input.readInt()).also { input.readFully(it) }
                    if (type == 0) shown(slot, java.nio.ByteBuffer.wrap(body).int)
                    else synchronized(this) { panes[slot] }?.sink?.send(body[0].toInt(), body.copyOfRange(1, body.size))
                }
            }
        }.start()
    }

    private fun command(line: String) = synchronized(commands) { runCatching { commands.write(line + "\n"); commands.flush() } }

    /** A pane's display is up: its app goes there, then the phone's own screen takes the focus back. */
    @Synchronized private fun shown(slot: Int, display: Int) {
        val p = panes[slot] ?: return command("close $slot").let {}
        p.display = display
        Root.run("am start --display $display ${launch(p.pkg)}")
        frontAgain()?.let(Root::run)
    }

    /** am start arguments that bring [pkg]'s existing task forward the way its launcher icon does. */
    private fun launch(pkg: String) = ctx.packageManager.getLaunchIntentForPackage(pkg)?.component?.flattenToShortString()
        ?.let { "-a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f 0x10200000 -n $it" }

    /** Brings the app on the phone's screen forward again, which also hands the focus back to that screen. */
    private fun frontAgain() = front?.let(::launch)?.let { "am start --display 0 $it" }

    /** Puts [apps] (most recent first, [front] being the app on the phone's screen) on panes; returns each one's slot. */
    @Synchronized fun show(front: String?, apps: List<String>): Map<String, Int> {
        this.front = front
        val want = apps.filter { launch(it) != null }.take(MAX)
        val gone = panes.values.filter { it.pkg !in want }
        gone.forEach { panes.remove(it.slot) }
        release(gone)
        for (pkg in want.filter { pkg -> panes.values.none { it.pkg == pkg } }) {
            val slot = (1..MAX).first { it !in panes }
            panes[slot] = Pane(slot, pkg, LinkSink(slot) { command("key $slot") })
            command("open $slot ${size.first} ${size.second} $dpi")
        }
        return panes.values.associate { it.pkg to it.slot }
    }

    // Apps still on a pane go back to the phone's screen before it closes; a moved task lands in front,
    // so the app that was there is brought back over them.
    private fun release(gone: List<Pane>, then: () -> Unit = {}) {
        val moves = gone.filter { it.display >= 0 }.joinToString("; ") { p ->
            "for t in $(am stack list | sed -n 's/^RootTask id=\\([0-9]*\\) .* displayId=${p.display} .*/\\1/p'); do am display move-stack \$t 0; done"
        }
        val back = frontAgain()
        Thread {
            if (moves.isNotEmpty()) Root.exec(listOfNotNull(moves, back).joinToString("; "))
            gone.forEach { command("close ${it.slot}") }
            then()
        }.start()
    }

    fun keyframe() = synchronized(this) { panes.keys.forEach { command("key $it") } }

    @Synchronized fun close() {
        release(panes.values.toList()) { runCatching { commands.close() } }
        panes.clear()
    }

    fun display(slot: Int) = synchronized(this) { panes[slot] }?.display?.takeIf { it >= 0 }

    /** The PC's taps, swipes and keys for one pane, injected into that pane's display. */
    fun input(slot: Int, m: JsonObject) {
        val id = synchronized(this) { panes[slot] }?.display?.takeIf { it >= 0 } ?: return
        fun d(k: String) = (m[k] as? JsonPrimitive)?.doubleOrNull
        fun px(f: Double?, side: Int) = ((f ?: 0.5).coerceIn(0.0, 1.0) * (side - 1)).toInt()
        val x = px(d("fx"), size.first)
        val y = px(d("fy"), size.second)
        val cmd = when ((m["kind"] as? JsonPrimitive)?.content) {
            "tap" -> "tap $x $y"
            "press" -> "swipe $x $y $x $y 650"
            "swipe" -> "swipe $x $y ${px(d("tx"), size.first)} ${px(d("ty"), size.second)} ${(d("ms") ?: 300.0).toLong().coerceIn(50, 3000)}"
            "key" -> KEYS[(m["key"] as? JsonPrimitive)?.content]?.let { "keyevent $it" }
            else -> null
        } ?: return
        Root.run("input -d $id $cmd")
    }

    companion object {
        const val MAX = 3
        // ponytail: key events reach a pane only while it holds the focus (a tap gives it); typing goes around them.
        private val KEYS = mapOf("back" to 4, "home" to 3, "recents" to 187)
    }
}
