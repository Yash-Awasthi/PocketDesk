package com.yasha.pocketdesk

import org.junit.Assert.assertEquals
import org.junit.Test

class ConnectRouteTest {
    private val lan = "wss://192.168.1.2:8897/ws"
    private val iroh = "iroh://ticket"
    private val home = NetInfo("wifi-1", local = true)

    @Test
    fun `wifi tries the LAN address first`() = assertEquals(lan, ConnectRoute.pick(lan, iroh, home, null))

    @Test
    fun `mobile data goes straight to iroh`() = assertEquals(iroh, ConnectRoute.pick(lan, iroh, NetInfo("cell", local = false), null))

    @Test
    fun `a wifi where the LAN address failed uses iroh until the phone moves`() {
        assertEquals(iroh, ConnectRoute.pick(lan, iroh, home, "wifi-1"))
        assertEquals(lan, ConnectRoute.pick(lan, iroh, NetInfo("wifi-2", local = true), "wifi-1"))
    }

    @Test
    fun `an unknown network id still remembers the failure`() =
        assertEquals(iroh, ConnectRoute.pick(lan, iroh, NetInfo(null, local = true), ""))

    @Test
    fun `a PC without an iroh ticket always uses its address`() =
        assertEquals(lan, ConnectRoute.pick(lan, null, NetInfo("cell", local = false), "cell"))
}
