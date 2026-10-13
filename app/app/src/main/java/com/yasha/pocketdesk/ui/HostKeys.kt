package com.yasha.pocketdesk.ui

/** A key with the modifiers held around it, in the daemon's wire names (ctrl, alt, shift, win). */
internal data class Combo(val vk: Int, val mods: List<String> = emptyList())

private const val LEFT = 0x25
private const val UP = 0x26
private const val RIGHT = 0x27
private const val DOWN = 0x28

/**
 * Shortcut bar entries for the PC's OS (`process.platform` from the welcome). A Mac takes Cmd
 * (the "win" modifier on the wire) where Windows and Linux take Ctrl.
 */
internal fun shortcutsFor(os: String): List<Pair<String, Combo>> = when (os) {
    "darwin" -> listOf(
        "Copy" to Combo(0x43, listOf("win")),
        "Paste" to Combo(0x56, listOf("win")),
        "Undo" to Combo(0x5A, listOf("win")),
        "Save" to Combo(0x53, listOf("win")),
        "Find" to Combo(0x46, listOf("win")),
        "⌘Tab" to Combo(0x09, listOf("win")),
        "Esc" to Combo(0x1B),
        "Return" to Combo(0x0D),
        "Spotlight" to Combo(0x20, listOf("win")),
        "Mission Control" to Combo(UP, listOf("ctrl")),
        "Close window" to Combo(0x57, listOf("win")),
        "Force Quit" to Combo(0x1B, listOf("win", "alt")),
    )
    "linux" -> listOf(
        "Copy" to Combo(0x43, listOf("ctrl")),
        "Paste" to Combo(0x56, listOf("ctrl")),
        "Undo" to Combo(0x5A, listOf("ctrl")),
        "Save" to Combo(0x53, listOf("ctrl")),
        "Find" to Combo(0x46, listOf("ctrl")),
        "Alt+Tab" to Combo(0x09, listOf("alt")),
        "Esc" to Combo(0x1B),
        "Enter" to Combo(0x0D),
        "Super" to Combo(0x5B),
        "Desktop" to Combo(0x44, listOf("win")),
    )
    else -> listOf(
        "Copy" to Combo(0x43, listOf("ctrl")),
        "Paste" to Combo(0x56, listOf("ctrl")),
        "Undo" to Combo(0x5A, listOf("ctrl")),
        "Save" to Combo(0x53, listOf("ctrl")),
        "Find" to Combo(0x46, listOf("ctrl")),
        "Alt+Tab" to Combo(0x09, listOf("alt")),
        "Esc" to Combo(0x1B),
        "Enter" to Combo(0x0D),
        "Win" to Combo(0x5B),
        "Task view" to Combo(0x09, listOf("win")),
        "Desktop" to Combo(0x44, listOf("win")),
        "Task Manager" to Combo(0x1B, listOf("ctrl", "shift")),
    )
}

/**
 * Three-finger swipes do what they do on that OS's own touchpad: sideways switches desktop
 * (fingers left = the next one to the right), up shows every window, down the app's windows
 * on a Mac and the desktop elsewhere.
 */
internal fun swipeCombo(os: String, swipe: Swipe): Combo = when (os) {
    "darwin" -> when (swipe) {
        Swipe.Left -> Combo(RIGHT, listOf("ctrl"))
        Swipe.Right -> Combo(LEFT, listOf("ctrl"))
        Swipe.Up -> Combo(UP, listOf("ctrl"))
        Swipe.Down -> Combo(DOWN, listOf("ctrl"))
    }
    "linux" -> when (swipe) {
        Swipe.Left -> Combo(RIGHT, listOf("ctrl", "alt"))
        Swipe.Right -> Combo(LEFT, listOf("ctrl", "alt"))
        Swipe.Up -> Combo(0x5B)
        Swipe.Down -> Combo(0x44, listOf("win"))
    }
    else -> when (swipe) {
        Swipe.Left -> Combo(RIGHT, listOf("ctrl", "win"))
        Swipe.Right -> Combo(LEFT, listOf("ctrl", "win"))
        Swipe.Up -> Combo(0x09, listOf("win"))
        Swipe.Down -> Combo(0x44, listOf("win"))
    }
}

/** Modifier key caption in the PC's own words, short enough for the narrow modifier keys. */
internal fun modLabel(os: String, wire: String): String = when (wire) {
    "ctrl" -> "Ctrl"
    "shift" -> "Shift"
    "alt" -> if (os == "darwin") "Opt" else "Alt"
    else -> when (os) { "darwin" -> "Cmd"; "linux" -> "Super"; else -> "Win" }
}
