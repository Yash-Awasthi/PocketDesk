package com.yasha.pocketdesk

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Session Recorder — records terminal sessions for playback and review.
 *
 * Records:
 * - All input/output events with timestamps
 * - Window resize events
 * - Session metadata (host, start time, duration)
 *
 * Supports:
 * - Real-time recording during active sessions
 * - Export to JSON format
 * - Playback with variable speed
 * - Bookmark/marker insertion during recording
 */

@Serializable
data class SessionEvent(
    val timestamp: Long,       // ms since recording start
    val type: EventType,
    val data: String,
) {
    enum class EventType {
        INPUT,          // user keystroke
        OUTPUT,         // terminal output
        RESIZE,         // window resize (cols,rows)
        BOOKMARK,       // user-placed bookmark
        CONNECT,        // connection established
        DISCONNECT,     // connection lost
    }
}

@Serializable
data class SessionMetadata(
    val id: String,
    val host: String,
    val port: Int,
    val startTime: Long,
    val endTime: Long?,
    val totalEvents: Int,
    val bookmarks: List<Bookmark>,
) {
    @Serializable
    data class Bookmark(
        val offsetMs: Long,
        val label: String,
    )
}

@Serializable
data class RecordedSession(
    val metadata: SessionMetadata,
    val events: List<SessionEvent>,
)

class SessionRecorder {
    companion object {
        private const val TAG = "SessionRecorder"
    }

    private val events = mutableListOf<SessionEvent>()
    private var startTime: Long = 0
    private var isRecording = false
    private var sessionHost = ""
    private var sessionPort = 0

    /**
     * Start recording a new session.
     */
    fun startRecording(host: String, port: Int) {
        events.clear()
        startTime = System.currentTimeMillis()
        sessionHost = host
        sessionPort = port
        isRecording = true

        addEvent(SessionEvent.EventType.CONNECT, "$host:$port")
    }

    /**
     * Stop recording.
     */
    fun stopRecording() {
        addEvent(SessionEvent.EventType.DISCONNECT, "session ended")
        isRecording = false
    }

    /**
     * Record a terminal input event.
     */
    fun recordInput(data: String) {
        if (!isRecording) return
        addEvent(SessionEvent.EventType.INPUT, data)
    }

    /**
     * Record a terminal output event.
     */
    fun recordOutput(data: String) {
        if (!isRecording) return
        addEvent(SessionEvent.EventType.OUTPUT, data)
    }

    /**
     * Record a resize event.
     */
    fun recordResize(cols: Int, rows: Int) {
        if (!isRecording) return
        addEvent(SessionEvent.EventType.RESIZE, "$cols,$rows")
    }

    /**
     * Add a named bookmark at current position.
     */
    fun addBookmark(label: String) {
        if (!isRecording) return
        addEvent(SessionEvent.EventType.BOOKMARK, label)
    }

    /**
     * Get current session duration in milliseconds.
     */
    fun getDuration(): Long = if (isRecording) System.currentTimeMillis() - startTime else 0

    /**
     * Get recorded events.
     */
    fun getEvents(): List<SessionEvent> = events.toList()

    /**
     * Get bookmarks only.
     */
    fun getBookmarks(): List<SessionMetadata.Bookmark> =
        events.filter { it.type == SessionEvent.EventType.BOOKMARK }
            .map { SessionMetadata.Bookmark(it.timestamp, it.data) }

    /**
     * Export session to JSON string.
     */
    fun exportToJson(): String {
        val session = RecordedSession(
            metadata = SessionMetadata(
                id = "session-${startTime}",
                host = sessionHost,
                port = sessionPort,
                startTime = startTime,
                endTime = if (isRecording) null else System.currentTimeMillis(),
                totalEvents = events.size,
                bookmarks = getBookmarks(),
            ),
            events = events.toList(),
        )
        return Json.encodeToString(session)
    }

    /**
     * Export session to a file.
     */
    fun exportToFile(file: File) {
        file.writeText(exportToJson())
    }

    /**
     * Get all events of a specific type.
     */
    fun getEventsByType(type: SessionEvent.EventType): List<SessionEvent> =
        events.filter { it.type == type }

    /**
     * Get time between two events.
     */
    fun getEventInterval(index1: Int, index2: Int): Long {
        if (index1 < 0 || index2 < 0 || index1 >= events.size || index2 >= events.size) return 0
        return events[index2].timestamp - events[index1].timestamp
    }

    private fun addEvent(type: SessionEvent.EventType, data: String) {
        val event = SessionEvent(
            timestamp = System.currentTimeMillis() - startTime,
            type = type,
            data = data,
        )
        events.add(event)
    }
}

/**
 * Session Playback — replays recorded sessions.
 */
class SessionPlayback {
    private var recordedSession: RecordedSession? = null
    private var playbackSpeed: Float = 1.0f
    private var currentEventIndex = 0
    private var isPlaying = false
    private var onEvent: ((SessionEvent) -> Unit)? = null
    private var onComplete: (() -> Unit)? = null

    /**
     * Load a recorded session from JSON.
     */
    fun loadSession(json: String) {
        recordedSession = Json.decodeFromString(json)
        currentEventIndex = 0
    }

    /**
     * Set playback speed (0.5x to 10x).
     */
    fun setSpeed(speed: Float) {
        playbackSpeed = speed.coerceIn(0.1f, 10.0f)
    }

    /**
     * Start playback.
     */
    fun play(
        onEvent: (SessionEvent) -> Unit,
        onComplete: () -> Unit = {},
    ) {
        this.onEvent = onEvent
        this.onComplete = onComplete
        isPlaying = true
        currentEventIndex = 0
    }

    /**
     * Pause playback.
     */
    fun pause() {
        isPlaying = false
    }

    /**
     * Resume playback.
     */
    fun resume() {
        isPlaying = true
    }

    /**
     * Seek to a specific time offset.
     */
    fun seekTo(offsetMs: Long) {
        val session = recordedSession ?: return
        currentEventIndex = session.events.indexOfFirst { it.timestamp >= offsetMs }
            .coerceAtLeast(0)
    }

    /**
     * Get current playback progress (0-1).
     */
    fun getProgress(): Float {
        val session = recordedSession ?: return 0f
        if (session.events.isEmpty()) return 0f
        val totalTime = session.metadata.endTime?.minus(session.metadata.startTime) ?: return 0f
        val currentTime = session.events.getOrNull(currentEventIndex)?.timestamp ?: return 0f
        return (currentTime.toFloat() / totalTime).coerceIn(0f, 1f)
    }

    /**
     * Get session metadata.
     */
    fun getMetadata(): SessionMetadata? = recordedSession?.metadata

    /**
     * Get events between two time offsets.
     */
    fun getEventsInRange(startMs: Long, endMs: Long): List<SessionEvent> {
        return recordedSession?.events?.filter {
            it.timestamp in startMs..endMs
        } ?: emptyList()
    }
}
