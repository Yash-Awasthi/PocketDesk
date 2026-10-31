// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk.ui

import android.content.Context
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.speech.RecognizerIntent
import android.view.HapticFeedbackConstants
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.yasha.pocketdesk.Proto
import com.yasha.pocketdesk.WsClient
import kotlin.math.abs

/** Moves gathered between sends, so a fast finger costs one message per frame rather than one per touch event. */
private class MoveBatcher(private val ws: WsClient) {
    private var dx = 0f
    private var dy = 0f
    private var last = 0L
    fun add(x: Float, y: Float) {
        dx += x; dy += y
        val now = System.currentTimeMillis()
        if (now - last >= 16 && (abs(dx) >= 1f || abs(dy) >= 1f)) {
            ws.sendRaw(Proto.remoteMove(dx, dy)); dx = 0f; dy = 0f; last = now
        }
    }
}

/**
 * The phone as the PC's remote, without the desktop view: a touchpad, an air mouse that follows
 * the phone's tilt, the keys a phone keyboard lacks, voice typing and a presenter.
 */
@Composable
fun RemoteScreen(ws: WsClient, onClose: () -> Unit) {
    var tab by remember { mutableIntStateOf(0) }
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onClose) { Text("Close") }
            Text("Remote", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
        }
        PrimaryTabRow(selectedTabIndex = tab) {
            Tab(tab == 0, { tab = 0 }, text = { Text("Touchpad") })
            Tab(tab == 1, { tab = 1 }, text = { Text("Air mouse") })
            Tab(tab == 2, { tab = 2 }, text = { Text("Presenter") })
        }
        when (tab) {
            0 -> Touchpad(ws)
            1 -> AirMouse(ws)
            else -> Presenter(ws)
        }
    }
}

@Composable
private fun Touchpad(ws: WsClient) {
    val view = LocalView.current
    val batch = remember { MoveBatcher(ws) }
    Column(Modifier.fillMaxSize().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(
            Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.surfaceVariant)
                .pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        val start = System.currentTimeMillis()
                        var fingers = 1
                        var travelled = 0f
                        var dragging = false
                        var scrollY = 0f
                        var scrollX = 0f
                        while (true) {
                            val ev = awaitPointerEvent()
                            val pressed = ev.changes.filter { it.pressed }
                            if (pressed.isEmpty()) break
                            fingers = maxOf(fingers, pressed.size)
                            val d = pressed.fold(Offset.Zero) { a, c -> a + c.positionChange() } / pressed.size.toFloat()
                            travelled += d.getDistance()
                            ev.changes.forEach { it.consume() }
                            // Held still for half a second, one finger then drags with the button down.
                            if (fingers == 1 && !dragging && travelled < 12f && System.currentTimeMillis() - start > 500) {
                                dragging = true
                                view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                                ws.sendRaw(Proto.remotePress("left", true))
                            }
                            if (fingers >= 2) {
                                scrollY += d.y; scrollX += d.x
                                if (abs(scrollY) >= 12f || abs(scrollX) >= 12f) {
                                    ws.sendRaw(Proto.remoteWheel((scrollY * 10).toInt(), (-scrollX * 10).toInt())); scrollY = 0f; scrollX = 0f
                                }
                            } else batch.add(d.x * 1.8f, d.y * 1.8f)
                        }
                        if (dragging) ws.sendRaw(Proto.remotePress("left", false))
                        else if (travelled < 12f && System.currentTimeMillis() - start < 300) {
                            ws.sendRaw(Proto.remoteClick(when (fingers) { 1 -> "left"; 2 -> "right"; else -> "middle" }))
                        }
                        down.consume()
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            Text("Slide to move · tap to click · two fingers to scroll or right click · hold then slide to drag",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilledTonalButton({ ws.sendRaw(Proto.remoteClick("left")) }, Modifier.weight(1f)) { Text("Left") }
            FilledTonalButton({ ws.sendRaw(Proto.remoteClick("middle")) }, Modifier.weight(0.6f)) { Text("Mid") }
            FilledTonalButton({ ws.sendRaw(Proto.remoteClick("right")) }, Modifier.weight(1f)) { Text("Right") }
        }
        Keys(ws)
        TypeBox(ws)
    }
}

/** Esc, Tab, arrows and the rest a phone keyboard lacks. */
@Composable
private fun Keys(ws: WsClient) {
    val keys = listOf("Esc" to 0x1B, "Tab" to 0x09, "⌫" to 0x08, "Del" to 0x2E, "⏎" to 0x0D, "←" to 0x25, "↑" to 0x26, "↓" to 0x28, "→" to 0x27,
        "Home" to 0x24, "End" to 0x23, "PgUp" to 0x21, "PgDn" to 0x22, "Win" to 0x5B, "🔉" to 0xAE, "🔊" to 0xAF, "🔇" to 0xAD, "⏯" to 0xB3)
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for ((label, vk) in keys) OutlinedButton({ ws.sendRaw(Proto.deckKey(vk)) }) { Text(label) }
        OutlinedButton({ ws.sendRaw(Proto.deckKey(0x09, listOf("alt"))) }) { Text("Alt+Tab") }
    }
}

/** Typing and voice typing: the words land in whatever is focused on the PC. */
@Composable
private fun TypeBox(ws: WsClient) {
    var text by remember { mutableStateOf("") }
    val voice = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        r.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.takeIf { it.isNotBlank() }?.let { ws.sendRaw(Proto.remoteText("$it ")) }
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedTextField(text, { text = it }, Modifier.weight(1f), singleLine = true, placeholder = { Text("Type on the PC") },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { if (text.isNotEmpty()) { ws.sendRaw(Proto.remoteText(text)); text = "" } else ws.sendRaw(Proto.deckKey(0x0D)) }))
        Button({
            voice.launch(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak to type on the PC"))
        }) { Text("🎤") }
    }
}

/** The pointer follows the phone's turn while the big button is held, from the gyroscope. */
@Composable
private fun AirMouse(ws: WsClient) {
    val ctx = LocalContext.current
    val sm = remember { ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager }
    val gyro = remember { sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE) }
    var holding by remember { mutableStateOf(false) }
    var always by remember { mutableStateOf(false) }
    var speed by remember { mutableStateOf(1f) }
    val batch = remember { MoveBatcher(ws) }
    val active = holding || always
    DisposableEffect(active, gyro) {
        if (!active || gyro == null) return@DisposableEffect onDispose {}
        val l = object : SensorEventListener {
            override fun onSensorChanged(e: SensorEvent) {
                // Rad/s around z turns left-right, around x tilts up-down; a dead zone stops the drift of a still hand.
                val yaw = -e.values[2]; val pitch = -e.values[0]
                val x = if (abs(yaw) > 0.02f) yaw * 22f * speed else 0f
                val y = if (abs(pitch) > 0.02f) pitch * 22f * speed else 0f
                if (x != 0f || y != 0f) batch.add(x, y)
            }
            override fun onAccuracyChanged(s: Sensor?, a: Int) {}
        }
        sm.registerListener(l, gyro, SensorManager.SENSOR_DELAY_GAME)
        onDispose { sm.unregisterListener(l) }
    }
    Column(Modifier.fillMaxSize().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (gyro == null) { Text("This phone has no gyroscope, so the air mouse cannot work. The touchpad still does."); return@Column }
        Box(
            Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(16.dp))
                .background(if (active) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant)
                .pointerInput(Unit) {
                    awaitEachGesture {
                        awaitFirstDown().consume()
                        val t = System.currentTimeMillis()
                        holding = true
                        while (awaitPointerEvent().changes.any { it.pressed }) {}
                        holding = false
                        if (System.currentTimeMillis() - t < 200) ws.sendRaw(Proto.remoteClick("left"))
                    }
                },
            contentAlignment = Alignment.Center,
        ) { Text(if (active) "Point the phone to move" else "Hold here and point the phone · tap to click", modifier = Modifier.padding(24.dp)) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Always follow the phone", Modifier.weight(1f))
            Switch(always, { always = it })
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Speed", Modifier.padding(end = 12.dp))
            androidx.compose.material3.Slider(speed, { speed = it }, valueRange = 0.3f..3f, modifier = Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilledTonalButton({ ws.sendRaw(Proto.remoteClick("left")) }, Modifier.weight(1f).height(56.dp)) { Text("Left") }
            FilledTonalButton({ ws.sendRaw(Proto.remoteClick("right")) }, Modifier.weight(1f).height(56.dp)) { Text("Right") }
        }
    }
}

/** Slides in PowerPoint, Keynote, Google Slides and PDF viewers: arrows, F5 to start, Esc to end, B for a black screen. */
@Composable
private fun Presenter(ws: WsClient) {
    val view = LocalView.current
    fun key(vk: Int, mods: List<String> = emptyList()) { view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY); ws.sendRaw(Proto.deckKey(vk, mods)) }
    Column(Modifier.fillMaxSize().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth().weight(1f), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FilledTonalButton({ key(0x25) }, Modifier.weight(1f).fillMaxSize(), shape = RoundedCornerShape(16.dp)) { Text("◀ Back", style = MaterialTheme.typography.headlineSmall) }
            Button({ key(0x27) }, Modifier.weight(2f).fillMaxSize(), shape = RoundedCornerShape(16.dp)) { Text("Next ▶", style = MaterialTheme.typography.headlineMedium) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({ key(0x74) }, Modifier.weight(1f)) { Text("Start") }
            OutlinedButton({ key(0x74, listOf("shift")) }, Modifier.weight(1f)) { Text("From here") }
            OutlinedButton({ key(0x1B) }, Modifier.weight(1f)) { Text("End") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({ key('B'.code) }, Modifier.weight(1f)) { Text("Black screen") }
            OutlinedButton({ key('W'.code) }, Modifier.weight(1f)) { Text("White screen") }
        }
        Text("Volume keys turn the slides too while this tab is open.", style = MaterialTheme.typography.bodySmall)
        VolumeKeys { up -> key(if (up) 0x25 else 0x27) }
    }
}

/** While shown, the phone's volume buttons call [onKey] (true for volume up) instead of changing the volume. */
@Composable
private fun VolumeKeys(onKey: (Boolean) -> Unit) {
    val view = LocalView.current
    DisposableEffect(view) {
        view.isFocusableInTouchMode = true
        view.requestFocus()
        val l = android.view.View.OnKeyListener { _, code, e ->
            val up = code == android.view.KeyEvent.KEYCODE_VOLUME_UP
            if (!up && code != android.view.KeyEvent.KEYCODE_VOLUME_DOWN) return@OnKeyListener false
            if (e.action == android.view.KeyEvent.ACTION_DOWN && e.repeatCount == 0) onKey(up)
            true
        }
        view.setOnKeyListener(l)
        onDispose { view.setOnKeyListener(null) }
    }
}
