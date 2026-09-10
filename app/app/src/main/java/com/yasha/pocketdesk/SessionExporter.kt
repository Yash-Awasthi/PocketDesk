package com.yasha.pocketdesk

/**
 * SessionExporter — bridges TerminalSession and SessionRecorder formats.
 * Allows importing from SessionRecorder format into TerminalSession,
 * and exporting TerminalSession for sharing/replay.
 */
object SessionExporter {

    /**
     * Convert a RecordedSession into a TerminalSession for structured access.
     */
    fun fromRecordedSession(recorded: RecordedSession): TerminalSession {
        val session = TerminalSession(
            id = recorded.metadata.id,
            title = "${recorded.metadata.host}:${recorded.metadata.port}",
            host = recorded.metadata.host,
            port = recorded.metadata.port,
            username = "root",
            startedAt = java.time.Instant.ofEpochMilli(recorded.metadata.startTime),
            endedAt = recorded.metadata.endTime?.let { java.time.Instant.ofEpochMilli(it) },
        )

        for (event in recorded.events) {
            val timestamp = java.time.Instant.ofEpochMilli(recorded.metadata.startTime + event.timestamp)
            when (event.type) {
                SessionEvent.EventType.INPUT -> session.recordCommand(event.data, timestamp)
                SessionEvent.EventType.OUTPUT -> session.recordOutput(event.data, timestamp)
                SessionEvent.EventType.BOOKMARK -> {
                    val idx = session.entries.size - 1
                    session.addBookmark(event.data, idx.coerceAtLeast(0))
                }
                SessionEvent.EventType.CONNECT, SessionEvent.EventType.DISCONNECT, SessionEvent.EventType.RESIZE -> {
                    // Metadata events — store as comment-like output
                    session.recordOutput("[${event.type}] ${event.data}", timestamp)
                }
            }
        }

        return session
    }

    /**
     * Export a TerminalSession to a shell script for replay.
     */
    fun toShellScript(session: TerminalSession, includeTimings: Boolean = true): String {
        val sb = StringBuilder()
        sb.appendLine("#!/bin/bash")
        sb.appendLine("# Terminal session: ${session.title}")
        sb.appendLine("# Host: ${session.host}:${session.port}")
        sb.appendLine("# Date: ${session.startedAt}")
        sb.appendLine("# Commands: ${session.commandCount}")
        sb.appendLine()

        var lastTimestamp: Long = session.startedAt.toEpochMilli()
        for (entry in session.entries) {
            if (entry.type == EntryType.COMMAND) {
                if (includeTimings) {
                    val delay = (entry.timestamp.toEpochMilli() - lastTimestamp).coerceAtLeast(0)
                    if (delay > 1000) {
                        sb.appendLine("sleep $(echo 'scale=1; ${delay / 1000.0}' | bc)")
                    }
                    lastTimestamp = entry.timestamp.toEpochMilli()
                }
                sb.appendLine(entry.content)
            }
        }

        return sb.toString()
    }

    /**
     * Generate a Markdown report of the session.
     */
    fun toMarkdownReport(session: TerminalSession): String {
        val sb = StringBuilder()
        sb.appendLine("# Terminal Session Report")
        sb.appendLine()
        sb.appendLine("| Field | Value |")
        sb.appendLine("|-------|-------|")
        sb.appendLine("| Host | `${session.host}:${session.port}` |")
        sb.appendLine("| User | ${session.username} |")
        sb.appendLine("| Started | ${session.startedAt} |")
        sb.appendLine("| Duration | ${session.durationMs / 1000}s |")
        sb.appendLine("| Commands | ${session.commandCount} |")
        sb.appendLine("| Bookmarks | ${session.bookmarks.size} |")
        sb.appendLine()

        if (session.bookmarks.isNotEmpty()) {
            sb.appendLine("## Bookmarks")
            for (bm in session.bookmarks) {
                sb.appendLine("- **${bm.label}** (entry #${bm.entryIndex})")
            }
            sb.appendLine()
        }

        sb.appendLine("## Command Log")
        sb.appendLine()
        for (entry in session.entries) {
            when (entry.type) {
                EntryType.COMMAND -> sb.appendLine("```bash\n${entry.content}\n```")
                EntryType.OUTPUT -> {
                    if (entry.content.length > 500) {
                        sb.appendLine("```text\n${entry.content.take(500)}...\n```")
                    } else {
                        sb.appendLine("```text\n${entry.content}\n```")
                    }
                }
                EntryType.ERROR -> sb.appendLine("```text\n⚠️ ${entry.content}\n```")
            }
        }

        return sb.toString()
    }

    /**
     * Search through all recorded sessions for a pattern.
     */
    fun searchAcrossSessions(
        sessions: List<TerminalSession>,
        query: String,
    ): List<Pair<TerminalSession, List<SessionEntry>>> {
        val lowerQuery = query.lowercase()
        return sessions.mapNotNull { session ->
            val matches = session.entries.filter {
                it.content.lowercase().contains(lowerQuery)
            }
            if (matches.isNotEmpty()) session to matches else null
        }
    }

    /**
     * Extract unique commands used across sessions for analytics.
     */
    fun extractCommandStats(sessions: List<TerminalSession>): Map<String, Int> {
        val stats = mutableMapOf<String, Int>()
        for (session in sessions) {
            for (entry in session.entries) {
                if (entry.type == EntryType.COMMAND) {
                    val cmd = entry.content.trim().split("\\s+".toRegex()).firstOrNull() ?: continue
                    stats[cmd] = (stats[cmd] ?: 0) + 1
                }
            }
        }
        return stats.toSortedMap(compareByDescending { stats[it] ?: 0 })
    }
}
