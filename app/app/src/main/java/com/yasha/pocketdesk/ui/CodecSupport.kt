package com.yasha.pocketdesk.ui

import android.media.MediaCodecList
import android.media.MediaFormat

/** Wire codec names to their Android MIME type. */
internal fun codecMime(codec: String): String = when (codec) {
    "hevc" -> MediaFormat.MIMETYPE_VIDEO_HEVC
    "av1" -> MediaFormat.MIMETYPE_VIDEO_AV1
    else -> MediaFormat.MIMETYPE_VIDEO_AVC
}

/**
 * Codecs this device can hardware-decode, best first, for the daemon to choose among. H.264 is
 * always included as the floor; HEVC and AV1 only when a decoder for them exists. A software-only
 * AV1 decoder (common below flagships) is left out: it cannot keep up with a live screen.
 */
internal fun decodableCodecs(): List<String> {
    val list = MediaCodecList(MediaCodecList.REGULAR_CODECS)
    fun hardwareDecoder(mime: String): Boolean = list.codecInfos.any { info ->
        !info.isEncoder && info.isHardwareAccelerated &&
            info.supportedTypes.any { it.equals(mime, ignoreCase = true) }
    }
    return buildList {
        if (hardwareDecoder(MediaFormat.MIMETYPE_VIDEO_AV1)) add("av1")
        if (hardwareDecoder(MediaFormat.MIMETYPE_VIDEO_HEVC)) add("hevc")
        add("h264")
    }
}
