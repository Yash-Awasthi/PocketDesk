package com.yasha.pocketdesk

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.PolymorphicSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class NavStateTest {
    private val json = Json { serializersModule = ScreenSerializers }
    private val stack = ListSerializer(PolymorphicSerializer(NavKey::class))

    @Test
    fun `every screen survives a back stack round trip`() {
        val screens: List<NavKey> = listOf(
            Screen.Connect, Screen.Tools, Screen.Sessions, Screen.Chats, Screen.Freebuff,
            Screen.Desktop, Screen.Files, Screen.Ssh, Screen.Terminal("abc-123"),
        )
        // The sealed descriptor lists every subclass, so a new screen missing here fails the test.
        assertEquals(Screen.serializer().descriptor.getElementDescriptor(1).elementsCount, screens.size)
        assertEquals(screens, json.decodeFromString(stack, json.encodeToString(stack, screens)))
    }
}
