package com.yasha.pocketdesk

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

/** What the daemon reported for waking its PC: adapter MACs and the broadcast address of each network it was on. */
data class WakeInfo(val macs: List<String>, val broadcasts: List<String>)

object Wake {
    /** Magic packet: six 0xFF bytes, then the MAC sixteen times; null for a malformed MAC. */
    fun packet(mac: String): ByteArray? {
        val hex = mac.filter { it.isLetterOrDigit() }
        if (hex.length != 12) return null
        val bytes = runCatching { ByteArray(6) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() } }.getOrNull() ?: return null
        return ByteArray(6) { 0xFF.toByte() } + ByteArray(16 * 6) { bytes[it % 6] }
    }

    /**
     * Broadcasts a magic packet for every MAC on the phone's current network. It only reaches
     * the PC when the phone is on the same network; returns how many packets went out.
     */
    suspend fun send(info: WakeInfo): Int = withContext(Dispatchers.IO) {
        val targets = (info.broadcasts + "255.255.255.255").distinct().mapNotNull { runCatching { InetAddress.getByName(it) }.getOrNull() }
        var sent = 0
        DatagramSocket().use { sock ->
            sock.broadcast = true
            for (mac in info.macs) {
                val pkt = packet(mac) ?: continue
                for (addr in targets) for (port in intArrayOf(9, 7)) {
                    if (runCatching { sock.send(DatagramPacket(pkt, pkt.size, addr, port)) }.isSuccess) sent++
                }
            }
        }
        sent
    }
}
