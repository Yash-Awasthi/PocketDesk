package com.yasha.pocketdesk

import java.time.Instant
import java.util.UUID

/**
 * TerminalSession — models a recorded terminal session with
 * full command history, output capture, and metadata for replay.
 */
data class TerminalSession(
    val id: String = UUID.randomUUID().toString(),
    val title: String,
    val host: String,
    val port: Int = 22,
    val username: String,
    val startedAt: Instant = Instant.now(),
    var endedAt: Instant? = null,
    val entries: MutableList<SessionEntry> = mutableListOf(),
    val bookmarks: MutableList<Bookmark> = mutableListOf(),
    var exitCode: Int? = null,
) {
    val durationMs: Long
        get() {
            val end = endedAt ?: Instant.now()
            return end.toEpochMilli() - startedAt.toEpochMilli()
        }

    val commandCount: Int
        get() = entries.count { it.type == EntryType.COMMAND }

    fun recordCommand(command: String, timestamp: Instant = Instant.now()) {
        entries.add(
            SessionEntry(
                type = EntryType.COMMAND,
                content = command,
                timestamp = timestamp,
            )
        )
    }

    fun recordOutput(output: String, timestamp: Instant = Instant.now()) {
        entries.add(
            SessionEntry(
                type = EntryType.OUTPUT,
                content = output,
                timestamp = timestamp,
            )
        )
    }

    fun recordError(error: String, timestamp: Instant = Instant.now()) {
        entries.add(
            SessionEntry(
                type = EntryType.ERROR,
                content = error,
                timestamp = timestamp,
            )
        )
    }

    fun addBookmark(label: String, entryIndex: Int) {
        bookmarks.add(Bookmark(label = label, entryIndex = entryIndex, createdAt = Instant.now()))
    }

    fun toScript(): String {
        return entries.joinToString("\n") { entry ->
            when (entry.type) {
                EntryType.COMMAND -> entry.content
                EntryType.OUTPUT -> "# output: ${entry.content.take(200)}"
                EntryType.ERROR -> "# error: ${entry.content.take(200)}"
            }
        }
    }

    fun toJson(): String {
        val sb = StringBuilder()
        sb.append("{")
        sb.append("\"id\":\"$id\",")
        sb.append("\"title\":\"$title\",")
        sb.append("\"host\":\"$host\",")
        sb.append("\"port\":$port,")
        sb.append("\"username\":\"$username\",")
        sb.append("\"startedAt\":\"$startedAt\",")
        sb.append("\"endedAt\":${if (endedAt != null) "\"$endedAt\"" else "null"},")
        sb.append("\"durationMs\":$durationMs,")
        sb.append("\"commandCount\":$commandCount,")
        sb.append("\"entries\":[")
        sb.append(entries.joinToString(",") { it.toJson() })
        sb.append("],")
        sb.append("\"bookmarks\":[")
        sb.append(bookmarks.joinToString(",") { """{"label":"${it.label}","entryIndex":${it.entryIndex}}""" })
        sb.append("]")
        sb.append("}")
        return sb.toString()
    }

    fun searchCommands(query: String): List<SessionEntry> {
        val lowerQuery = query.lowercase()
        return entries.filter {
            it.type == EntryType.COMMAND && it.content.lowercase().contains(lowerQuery)
        }
    }

    fun getTimeline(): List<TimelineEvent> {
        return entries.mapIndexed { index, entry ->
            TimelineEvent(
                index = index,
                type = entry.type,
                content = entry.content,
                relativeTimeMs = entry.timestamp.toEpochMilli() - startedAt.toEpochMilli(),
                hasBookmark = bookmarks.any { it.entryIndex == index },
            )
        }
    }
}

data class SessionEntry(
    val type: EntryType,
    val content: String,
    val timestamp: Instant,
) {
    fun toJson(): String {
        val escaped = content.replace("\"", "\\\"").replace("\n", "\\n")
        return """{"type":"$type","content":"$escaped","timestamp":"$timestamp"}"""
    }
}

enum class EntryType {
    COMMAND, OUTPUT, ERROR
}

data class Bookmark(
    val label: String,
    val entryIndex: Int,
    val createdAt: Instant,
)

data class TimelineEvent(
    val index: Int,
    val type: EntryType,
    val content: String,
    val relativeTimeMs: Long,
    val hasBookmark: Boolean,
) {
    fun formattedTime(): String {
        val seconds = relativeTimeMs / 1000
        val minutes = seconds / 60
        val hrs = minutes / 60
        return if (hrs > 0) "${hrs}h ${minutes % 60}m"
        else if (minutes > 0) "${minutes}m ${seconds % 60}s"
        else "${seconds}s"
    }
}
