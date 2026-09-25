package com.yasha.pocketdesk

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * The daemon's pairing link, `pocketdesk://pair#<base64url JSON {u,t,f,i}>`:
 * LAN url, master token, TLS fingerprint, and optionally an iroh ticket that
 * reaches the PC from any network (the entry's fallback).
 */
object Pairing {
    const val SCHEME = "pocketdesk"

    fun parse(link: String): List<ServerEntry> {
        val payload = link.trim().takeIf { it.startsWith("$SCHEME://pair#") }?.substringAfter('#') ?: return emptyList()
        val json = runCatching {
            Json.parseToJsonElement(String(java.util.Base64.getUrlDecoder().decode(payload))) as? JsonObject
        }.getOrNull() ?: return emptyList()
        fun s(k: String) = (json[k] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
        val url = s("u")?.takeIf { it.startsWith("ws://") || it.startsWith("wss://") } ?: return emptyList()
        val token = s("t") ?: return emptyList()
        val host = url.substringAfter("://").substringBefore('/').substringBefore(':')
        // The iroh ticket rides along as the fallback, so one entry works at home and away.
        return listOf(ServerEntry(host, url, token, fingerprint(s("f")), s("i")?.let { "iroh://$it" }))
    }

    /** The daemon prints `AB:CD:…`; [Tls.sha256] compares lowercase hex without separators. */
    fun fingerprint(raw: String?): String? =
        raw?.replace(":", "")?.lowercase()?.takeIf { it.length == 64 && it.all { c -> c in "0123456789abcdef" } }
}
