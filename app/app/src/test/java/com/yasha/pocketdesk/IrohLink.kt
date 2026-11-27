package com.yasha.pocketdesk

import android.content.Context
import java.util.concurrent.atomic.AtomicLong

/**
 * The JVM actual of the iroh link layer.
 *
 * `IrohLink.kt` in `src/main` is the device actual: it imports `computer.iroh` and loads
 * `libiroh_ffi.so`. Robolectric cannot load that library, and every screen reaches the link
 * layer through `WsClient` -> `IrohLink` (the app's own `RhApp.onCreate` calls
 * `IrohLink.Node.init` too), so a host-side run died on `UnsatisfiedLinkError: no iroh_ffi`.
 *
 * This file is the same fully-qualified name in the test source set, so the unit-test class
 * path puts it in front of the real one and both call sites resolve here instead. It keeps the
 * exact public surface `WsClient` and `RhApp` use, and does nothing: a test run has no PC to
 * dial, and a screen captured before a connection must draw the disconnected state anyway.
 *
 * Android has one target, so `expect`/`actual` cannot express this directly; the two source
 * sets are the two actuals. Keep the surface in step with `src/main/.../IrohLink.kt`.
 */
class IrohLink(
    private val ticket: String,
    private val onText: (String) -> Unit,
    private val onVideo: (ByteArray) -> Unit,
    private val onClosed: (code: Int?, reason: String) -> Unit,
    private val onPath: (String) -> Unit = {},
) {
    /** Bytes queued but not yet written; always zero without a transport. */
    val uploadBacklog = AtomicLong()

    private val closed = java.util.concurrent.atomic.AtomicBoolean(false)

    fun start(onOpen: () -> Unit) {
        // No endpoint on the JVM. Report the close so the reconnect policy sees a normal
        // offline failure instead of a link that silently never opens.
        if (closed.compareAndSet(false, true)) onClosed(null, "iroh is not available on the JVM test runtime")
    }

    fun send(text: String): Boolean = false

    fun sendVideo(pkt: ByteArray): Boolean = false

    fun close() {
        closed.set(true)
    }

    object Node {
        fun init(context: Context) = Unit

        fun networkChanged() = Unit
    }
}
