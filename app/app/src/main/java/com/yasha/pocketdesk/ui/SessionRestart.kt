package com.yasha.pocketdesk.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Where an explicit restart stands: [Ready] once the session's PTY has exited, [Requested]
 * after the confirmation, then the daemon's answer as [Resumed], [Expired] or [Failed].
 */
sealed interface RestartPhase {
    data object Ready : RestartPhase
    data object Requested : RestartPhase
    data object Resumed : RestartPhase
    data object Expired : RestartPhase
    data class Failed(val reason: String) : RestartPhase
}

/** The daemon's refusal, as the card must render it: past the queue window is its own outcome. */
fun restartOutcome(message: String): RestartPhase =
    if (message.contains("expired")) RestartPhase.Expired else RestartPhase.Failed(message)

/** The only request that calls sessions.resume(id) on the daemon. */
fun sessionResumeMessage(id: String): String = buildJsonObject {
    put("type", "session_resume")
    put("id", id)
}.toString()

/**
 * The restart row for a session whose PTY has exited. It says the old shell is gone, asks before
 * firing, and renders whichever answer the daemon gives back; nothing here respawns implicitly.
 */
@Composable
fun SessionRestartCard(
    sessionId: String,
    exitCode: Int,
    phase: RestartPhase,
    onRestart: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var confirming by remember(sessionId) { mutableStateOf(false) }
    Card(modifier.fillMaxWidth().testTag("sessionRestart")) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Session $sessionId ended (exit $exitCode)", style = MaterialTheme.typography.titleMedium)
            Text(
                "The old shell is gone. Replies queued since it ended will run against a new shell.",
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.testTag("sessionRestart.what"),
            )
            when (phase) {
                RestartPhase.Ready -> Button(
                    onClick = { confirming = true },
                    modifier = Modifier.testTag("sessionRestart.ask"),
                ) { Text("Restart session") }
                RestartPhase.Requested -> Text(
                    "Restarting. Queued replies run once the new shell starts.",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.testTag("sessionRestart.requested"),
                )
                RestartPhase.Resumed -> Text(
                    "Restarted. The old shell is gone; replies queued since it ended are running in the new shell.",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.testTag("sessionRestart.outcome"),
                )
                RestartPhase.Expired -> Text(
                    "Not restarted: the restart window has passed since the shell exited. Start a new session.",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.testTag("sessionRestart.outcome"),
                )
                is RestartPhase.Failed -> Text(
                    "Not restarted: ${phase.reason}",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.testTag("sessionRestart.outcome"),
                )
            }
        }
    }
    if (confirming)
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("Restart session?") },
            text = {
                Text(
                    "The old shell is gone. Restarting runs the same command in a new shell and sends " +
                        "the replies queued since it ended to that new shell.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirming = false
                        onRestart(sessionId)
                    },
                    modifier = Modifier.testTag("sessionRestart.confirm"),
                ) { Text("Restart") }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }, modifier = Modifier.testTag("sessionRestart.cancel")) {
                    Text("Cancel")
                }
            },
        )
}