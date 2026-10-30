// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * The phone hub only works while the app is linked to the PC, so the PC last connected to is
 * linked again when the app starts and after the phone restarts, without opening the app.
 */
object AutoConnect {
    fun run(ctx: Context) {
        if (Link.client.status != Status.Disconnected) return
        val url = ctx.getSharedPreferences("pocketdesk", Context.MODE_PRIVATE).getString("last_pc", null) ?: return
        val entry = runCatching { ServerBook(ctx).load() }.getOrNull()?.firstOrNull { it.url == url } ?: return
        Link.client.connect(entry.url, entry.token, entry.pinnedFingerprint, entry.fallback)
    }
}

/** The user disconnected on purpose: no reconnecting by itself until they connect again. */
fun forgetAutoConnect(ctx: Context) = ctx.getSharedPreferences("pocketdesk", Context.MODE_PRIVATE).edit().remove("last_pc").apply()

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) AutoConnect.run(context.applicationContext)
    }
}
