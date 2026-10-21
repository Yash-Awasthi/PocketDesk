package com.yasha.pocketdesk

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.view.inputmethod.InputMethodManager
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

/**
 * Carries the PC's taps, swipes, keys and text into whatever app is in front, and tracks recent
 * apps for the PC's panes. Acts only while the screen is shared.
 */
class ControlService : AccessibilityService() {
    private val recent = ArrayList<String>()
    private var active: String? = null
    private var switchingTo: String? = null
    private var switchUntil = 0L

    override fun onServiceConnected() { instance = this }
    override fun onDestroy() { if (instance === this) instance = null; super.onDestroy() }
    override fun onInterrupt() {}

    private val main = Handler(Looper.getMainLooper())
    // Window events fire mid-transition, so the front app is read once they settle.
    private val settle = Runnable { foreground(mainRoot()?.packageName?.toString()) }

    /** The app window in front on the phone's own screen; an app starting on a pane's display takes the focus there. */
    private fun mainRoot(): AccessibilityNodeInfo? = if (PhoneShare.service?.panes == null) rootInActiveWindow
        else windowsOnAllDisplays[Display.DEFAULT_DISPLAY]?.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }?.root

    override fun onAccessibilityEvent(e: AccessibilityEvent) {
        main.removeCallbacks(settle)
        main.postDelayed(settle, SETTLE_MS)
    }

    private fun foreground(pkg: String?) {
        // The keyboard and the status bar open windows over an app without leaving it.
        if (pkg == null || pkg == "com.android.systemui" || pkg in keyboards()) return
        if (pkg == switchingTo) switchingTo = null
        if (pkg == active) return
        active = pkg
        if (pkg != packageName && packageManager.getLaunchIntentForPackage(pkg) != null && !isHome(pkg)) {
            recent.remove(pkg)
            recent.add(0, pkg)
            if (recent.size > 12) recent.removeAt(recent.size - 1)
        }
        sendApps()
    }

    fun sendApps() {
        if (!PhoneShare.sharing) return
        val a = active
        val others = recent.filter { it != a }
        val slots = PhoneShare.service?.panes?.show(a, others).orEmpty()
        Link.client.phoneApps(a?.let { it to label(it) }, others.map { Triple(it, label(it), slots[it]) })
    }

    private fun label(pkg: String) = runCatching {
        packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
    }.getOrDefault(pkg)

    private fun keyboards() = getSystemService(InputMethodManager::class.java).enabledInputMethodList.map { it.packageName }

    private fun isHome(pkg: String) = packageManager.resolveActivity(
        Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), 0)?.activityInfo?.packageName == pkg

    /** Brings a recent app to the front; input sent before it arrives is dropped, never replayed. */
    fun switchTo(pkg: String) {
        if (!PhoneShare.sharing) return
        val i = packageManager.getLaunchIntentForPackage(pkg) ?: return
        switchingTo = pkg
        switchUntil = SystemClock.uptimeMillis() + SWITCH_MS
        startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun input(m: JsonObject) {
        if (!PhoneShare.sharing) return
        fun d(k: String) = (m[k] as? JsonPrimitive)?.doubleOrNull
        fun s(k: String) = (m[k] as? JsonPrimitive)?.content
        val typing = s("kind") == "text" || (s("kind") == "key" && s("key") in setOf("enter", "backspace"))
        (m["slot"] as? JsonPrimitive)?.intOrNull?.takeIf { it > 0 }?.let { slot ->
            val panes = PhoneShare.service?.panes ?: return
            // Key events go to the focused display only, which a pane is not; its field is edited directly instead.
            if (typing) panes.display(slot)?.let { type(m, it) } else panes.input(slot, m)
            return
        }
        if (switchingTo != null && SystemClock.uptimeMillis() < switchUntil) return
        switchingTo = null
        if (typing) return type(m, Display.DEFAULT_DISPLAY)
        val (w, h) = PhoneShare.screenSize(this)
        fun at(fx: Double?, fy: Double?) = fx?.let { x -> fy?.let { y ->
            (x.coerceIn(0.0, 1.0) * (w - 1)).toFloat() to (y.coerceIn(0.0, 1.0) * (h - 1)).toFloat()
        } }
        when (s("kind")) {
            "tap" -> at(d("fx"), d("fy"))?.let { gesture(it, it, 50) }
            "press" -> at(d("fx"), d("fy"))?.let { gesture(it, it, 650) }
            "swipe" -> at(d("fx"), d("fy"))?.let { from ->
                at(d("tx"), d("ty"))?.let { to -> gesture(from, to, (d("ms") ?: 300.0).toLong().coerceIn(50, 3000)) }
            }
            "key" -> when (s("key")) {
                "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
                "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
                "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
                "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
            }
        }
    }

    /** Text, Enter and Backspace into the focused field on [display]. */
    private fun type(m: JsonObject, display: Int) {
        fun s(k: String) = (m[k] as? JsonPrimitive)?.content
        when (if (s("kind") == "text") "text" else s("key")) {
            "enter" -> { written = null; focused(display)?.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id) }
            "backspace" -> edit(display) { t, a, b -> if (a == b) (if (a == 0) null else t.removeRange(t.offsetByCodePoints(a, -1), a) to t.offsetByCodePoints(a, -1)) else t.removeRange(a, b) to a }
            "text" -> s("text")?.takeIf { it.isNotEmpty() }?.let { add -> edit(display) { t, a, b -> t.replaceRange(a, b, add) to a + add.length } }
        }
    }

    private fun gesture(from: Pair<Float, Float>, to: Pair<Float, Float>, ms: Long) {
        val path = Path().apply { moveTo(from.first, from.second); lineTo(to.first, to.second) }
        dispatchGesture(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, ms)).build(), null, null)
    }

    private fun focused(display: Int) = if (display == Display.DEFAULT_DISPLAY) mainRoot()?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        else windowsOnAllDisplays[display]?.firstNotNullOfOrNull { it.root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }

    /** Rewrites the focused field: [change] gets its text and selection, returns the new text and cursor. */
    private fun edit(display: Int, change: (String, Int, Int) -> Pair<String, Int>?) {
        val n = focused(display) ?: return
        // A cached node keeps the text it had before our last set; fields like Chrome's omnibox read empty without this.
        n.refresh()
        var text = if (n.isShowingHintText) "" else n.text?.toString() ?: ""
        var a = n.textSelectionStart
        var b = n.textSelectionEnd
        // Fast typing outruns the field: until it shows our last write, build on that write instead.
        written?.takeIf { it.first == n && SystemClock.uptimeMillis() - writtenAt < WRITE_LAG_MS && it.second != text }
            ?.let { text = it.second; a = it.third; b = a }
        if (a < 0 || b < 0 || a > text.length || b > text.length) { a = text.length; b = a }
        val (next, cursor) = change(text, minOf(a, b), maxOf(a, b)) ?: return
        n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, next)
        })
        n.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
        })
        written = Triple(n, next, cursor)
        writtenAt = SystemClock.uptimeMillis()
    }
    private var written: Triple<AccessibilityNodeInfo, String, Int>? = null
    private var writtenAt = 0L

    companion object {
        @Volatile var instance: ControlService? = null
            private set
        private const val SWITCH_MS = 2000L
        private const val SETTLE_MS = 250L
        // ponytail: fixed window; an app that rewrites the field within it loses that rewrite to ours.
        private const val WRITE_LAG_MS = 1000L
    }
}
