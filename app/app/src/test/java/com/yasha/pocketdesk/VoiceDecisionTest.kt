package com.yasha.pocketdesk

import com.yasha.pocketdesk.ui.Decision
import com.yasha.pocketdesk.ui.voiceDecision
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class VoiceDecisionTest {

    @Test
    fun `spoken answers map to a decision`() {
        assertEquals(Decision.Allow, voiceDecision("Allow"))
        assertEquals(Decision.Allow, voiceDecision("yes go ahead"))
        assertEquals(Decision.All, voiceDecision("allow all"))
        assertEquals(Decision.All, voiceDecision("yes to all"))
        assertEquals(Decision.Deny, voiceDecision("no"))
        assertEquals(Decision.Deny, voiceDecision("Deny that"))
    }

    @Test
    fun `a negated allow is a deny and anything unclear decides nothing`() {
        assertEquals(Decision.Deny, voiceDecision("don't allow"))
        assertEquals(Decision.Deny, voiceDecision("do not approve it"))
        assertEquals(null, voiceDecision("what is this"))
        assertEquals(null, voiceDecision("know"))
        assertEquals(null, voiceDecision("yes no"))
    }
}
