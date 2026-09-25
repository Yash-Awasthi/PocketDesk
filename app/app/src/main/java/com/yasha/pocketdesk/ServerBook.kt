package com.yasha.pocketdesk

import android.content.Context
import android.content.SharedPreferences
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

data class ServerEntry(
    val name: String,
    val url: String,
    val token: String,
    val pinnedFingerprint: String? = null,
    /** Tried when [url] cannot connect: the iroh ticket that reaches the PC from any network. */
    val fallback: String? = null,
    /** Last reported by the PC, so it can be woken while unreachable. */
    val wake: WakeInfo? = null,
)

class ServerBook(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("pocketdesk", Context.MODE_PRIVATE)

    fun load(): List<ServerEntry> {
        val raw = prefs.getString("servers", null) ?: return emptyList()
        val arr = runCatching { Json.parseToJsonElement(raw) as? JsonArray }.getOrNull() ?: return emptyList()
        return arr.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            fun s(k: String): String? = (o[k] as? JsonPrimitive)?.contentOrNull
            val url = s("url") ?: return@mapNotNull null
            ServerEntry(
                name = s("name") ?: url,
                url = url,
                token = s("token") ?: "",
                pinnedFingerprint = s("fp")?.takeIf { it.isNotBlank() },
                fallback = s("fallback")?.takeIf { it.isNotBlank() },
                wake = (o["wake"] as? JsonObject)?.let { w ->
                    fun list(k: String) = (w[k] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()
                    WakeInfo(list("macs"), list("bc")).takeIf { it.macs.isNotEmpty() }
                },
            )
        }
    }

    fun save(entries: List<ServerEntry>) {
        val arr = buildJsonArray {
            entries.forEach { e ->
                add(buildJsonObject {
                    put("name", e.name)
                    put("url", e.url)
                    put("token", e.token)
                    put("fp", e.pinnedFingerprint ?: "")
                    e.fallback?.let { put("fallback", it) }
                    e.wake?.let { w ->
                        put("wake", buildJsonObject {
                            put("macs", JsonArray(w.macs.map { JsonPrimitive(it) }))
                            put("bc", JsonArray(w.broadcasts.map { JsonPrimitive(it) }))
                        })
                    }
                })
            }
        }
        prefs.edit().putString("servers", arr.toString()).apply()
    }
}
