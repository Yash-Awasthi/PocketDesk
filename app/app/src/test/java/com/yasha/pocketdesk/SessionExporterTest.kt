package com.yasha.pocketdesk

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * SessionExporter turns a recorded session into the three shapes the app hands
 * out: a replayable shell script, a Markdown report, and cross-session analytics.
 * The inputs here are built directly, with no recorder or file system involved.
 */
class SessionExporterTest {

    private fun session(
        host: String = "legion",
        port: Int = 22,
        start: Long = 0,
    ) = TerminalSession(
        id = "s1",
        title = "$host:$port",
        host = host,
        port = port,
        username = "root",
        startedAt = Instant.ofEpochMilli(start),
        endedAt = Instant.ofEpochMilli(start + 60_000),
    )

    @Test
    fun `shell script carries the header and every command in order`() {
        val s = session()
        s.recordCommand("echo one", Instant.ofEpochMilli(0))
        s.recordOutput("one", Instant.ofEpochMilli(100))
        s.recordCommand("echo two", Instant.ofEpochMilli(200))

        val script = SessionExporter.toShellScript(s)

        assertTrue(script.startsWith("#!/bin/bash"))
        assertTrue(script.contains("# Host: legion:22"))
        assertTrue(script.contains("# Commands: 2"))
        assertTrue(script.contains("echo one\n"))
        assertTrue(script.contains("echo two\n"))
        // Output is not replayable, so it must not reach the script.
        assertFalse(script.contains("one\none"))
    }

    @Test
    fun `timings are emitted only for gaps longer than a second`() {
        val s = session()
        s.recordCommand("fast", Instant.ofEpochMilli(0))
        s.recordCommand("quick", Instant.ofEpochMilli(500))
        s.recordCommand("slow", Instant.ofEpochMilli(2_500))

        val timed = SessionExporter.toShellScript(s, includeTimings = true)
        assertEquals("only the 2.5s gap earns a sleep", 1, Regex("sleep ").findAll(timed).count())
        assertTrue(timed.contains("2.0"))

        val plain = SessionExporter.toShellScript(s, includeTimings = false)
        assertFalse(plain.contains("sleep"))
    }

    @Test
    fun `markdown report lists bookmarks and truncates long output`() {
        val s = session(host = "pi", port = 2222)
        s.recordCommand("dmesg", Instant.ofEpochMilli(0))
        s.recordOutput("y".repeat(600), Instant.ofEpochMilli(1_000))
        s.recordError("permission denied", Instant.ofEpochMilli(2_000))
        s.addBookmark("crash here", 2)

        val report = SessionExporter.toMarkdownReport(s)

        assertTrue(report.contains("| Host | `pi:2222` |"))
        assertTrue(report.contains("| Commands | 1 |"))
        assertTrue(report.contains("| Bookmarks | 1 |"))
        assertTrue(report.contains("**crash here** (entry #2)"))
        assertTrue(report.contains("permission denied"))
        assertTrue("long output is truncated", report.contains("..."))
        assertFalse("output is not emitted whole", report.contains("y".repeat(600)))
    }

    @Test
    fun `search is case insensitive and skips sessions with no match`() {
        val hit = session(host = "one")
        hit.recordCommand("Git Status", Instant.ofEpochMilli(0))
        val miss = session(host = "two")
        miss.recordCommand("ls", Instant.ofEpochMilli(0))

        val found = SessionExporter.searchAcrossSessions(listOf(hit, miss), "git")

        assertEquals(1, found.size)
        assertEquals("one", found[0].first.host)
        assertEquals(1, found[0].second.size)
        assertTrue(SessionExporter.searchAcrossSessions(listOf(hit, miss), "nothing").isEmpty())
    }

    @Test
    fun `command stats group by program and rank by frequency`() {
        val s = session()
        s.recordCommand("git status", Instant.ofEpochMilli(0))
        s.recordCommand("git log", Instant.ofEpochMilli(1))
        s.recordCommand("cd /tmp", Instant.ofEpochMilli(2))
        s.recordCommand("cd /var", Instant.ofEpochMilli(3))
        s.recordCommand("ls", Instant.ofEpochMilli(4))

        val stats = SessionExporter.extractCommandStats(listOf(s))

        assertEquals(mapOf("git" to 2, "cd" to 2, "ls" to 1), stats)
        // Most used first; the two frequency-2 programs order by name.
        assertEquals(listOf("cd", "git", "ls"), stats.keys.toList())
    }

    @Test
    fun `command stats keep every distinct program when counts tie`() {
        val s = session()
        s.recordCommand("git status", Instant.ofEpochMilli(0))
        s.recordCommand("cd /tmp", Instant.ofEpochMilli(1))
        s.recordCommand("ls", Instant.ofEpochMilli(2))

        val stats = SessionExporter.extractCommandStats(listOf(s))

        assertEquals("three commands used once each are three programs", 3, stats.size)
        assertEquals(1, stats["cd"])
        assertEquals(1, stats["git"])
        assertEquals(1, stats["ls"])
    }

    @Test
    fun `recorded session converts each event to the matching entry`() {
        val start = 1_700_000_000_000L
        val recorded = RecordedSession(
            metadata = SessionMetadata(
                id = "r1", host = "legion", port = 2222, startTime = start,
                endTime = start + 5_000, totalEvents = 5, bookmarks = emptyList(),
            ),
            events = listOf(
                SessionEvent(100, SessionEvent.EventType.INPUT, "uptime"),
                SessionEvent(200, SessionEvent.EventType.OUTPUT, "load 0.4"),
                SessionEvent(300, SessionEvent.EventType.BOOKMARK, "look here"),
                SessionEvent(400, SessionEvent.EventType.CONNECT, "tls"),
                SessionEvent(500, SessionEvent.EventType.RESIZE, "120x40"),
            ),
        )

        val s = SessionExporter.fromRecordedSession(recorded)

        assertEquals("r1", s.id)
        assertEquals("legion:2222", s.title)
        assertEquals("legion", s.host)
        assertEquals(2222, s.port)
        assertEquals(Instant.ofEpochMilli(start), s.startedAt)
        assertEquals(Instant.ofEpochMilli(start + 5_000), s.endedAt)
        assertEquals(1, s.commandCount)
        assertEquals(1, s.bookmarks.size)
        assertEquals("look here", s.bookmarks[0].label)
        // INPUT at 0ms of the recording, offset by the session start.
        assertEquals(Instant.ofEpochMilli(start + 100), s.entries[0].timestamp)
        // CONNECT and RESIZE have no entry type of their own.
        assertTrue(s.entries.any { it.type == EntryType.OUTPUT && it.content.contains("[CONNECT]") })
        assertTrue(s.entries.any { it.type == EntryType.OUTPUT && it.content.contains("[RESIZE]") })
    }

    @Test
    fun `a bookmark before any entry still points at a valid index`() {
        val start = 0L
        val recorded = RecordedSession(
            metadata = SessionMetadata(
                id = "r2", host = "h", port = 22, startTime = start,
                endTime = null, totalEvents = 1, bookmarks = emptyList(),
            ),
            events = listOf(SessionEvent(0, SessionEvent.EventType.BOOKMARK, "first")),
        )

        val s = SessionExporter.fromRecordedSession(recorded)

        assertEquals(1, s.bookmarks.size)
        assertEquals(0, s.bookmarks[0].entryIndex)
    }
}
