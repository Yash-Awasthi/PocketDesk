package com.yasha.pocketdesk

/** The network the phone is on: an identity that changes when it switches, and whether it is Wi-Fi or Ethernet. */
data class NetInfo(val id: String?, val local: Boolean)

/**
 * Which address to dial for a PC saved with a LAN url and an iroh fallback.
 * The LAN url only answers on the PC's own network, so it is skipped on mobile
 * data and on any Wi-Fi where it already failed; iroh works from anywhere.
 */
object ConnectRoute {
    /** [lanFailedOn] is the id of the network where the LAN url failed ("" when the id was unknown). */
    fun pick(lan: String, fallback: String?, net: NetInfo, lanFailedOn: String?): String = when {
        fallback == null -> lan
        !net.local -> fallback
        lanFailedOn != null && (net.id ?: "") == lanFailedOn -> fallback
        else -> lan
    }
}
