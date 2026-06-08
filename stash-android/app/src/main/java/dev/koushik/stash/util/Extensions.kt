package dev.koushik.stash.util

import android.content.Context
import android.net.Uri
import android.util.Patterns
import android.widget.Toast
import java.util.Locale
import kotlin.math.abs

/**
 * Small ergonomic helpers shared across activities and workers. Kept dependency
 * free so they can be unit tested on the JVM without an emulator.
 */

fun Context.toast(message: CharSequence, long: Boolean = false) {
    val length = if (long) Toast.LENGTH_LONG else Toast.LENGTH_SHORT
    Toast.makeText(this, message, length).show()
}

/** True when the receiver looks like an http(s) URL we are willing to share. */
fun String.looksLikeUrl(): Boolean {
    val trimmed = trim()
    if (trimmed.isEmpty()) return false
    if (!Patterns.WEB_URL.matcher(trimmed).matches()) return false
    val lower = trimmed.lowercase(Locale.US)
    return lower.startsWith("http://") || lower.startsWith("https://")
}

/** Strips common tracking query parameters from a shared link. */
fun String.stripTrackingParams(): String {
    val noisy = setOf(
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
        "gclid", "fbclid", "mc_cid", "mc_eid", "igshid", "ref", "ref_src"
    )
    return try {
        val uri = Uri.parse(this)
        if (uri.query == null) return this
        val builder = uri.buildUpon().clearQuery()
        for (name in uri.queryParameterNames) {
            if (name.lowercase(Locale.US) !in noisy) {
                for (value in uri.getQueryParameters(name)) {
                    builder.appendQueryParameter(name, value)
                }
            }
        }
        builder.build().toString()
    } catch (_: Throwable) {
        this
    }
}

/** Returns the bare host of a URL, or the original string when it cannot parse. */
fun String.hostOrSelf(): String = try {
    Uri.parse(this).host ?: this
} catch (_: Throwable) {
    this
}

/** Collapses runs of whitespace into single spaces and trims the ends. */
fun String.normalizeWhitespace(): String = trim().replace(Regex("\\s+"), " ")

fun String.truncateMiddle(max: Int): String {
    if (length <= max) return this
    if (max <= 1) return take(max)
    val keep = max - 1
    val head = (keep + 1) / 2
    val tail = keep - head
    return take(head) + "…" + takeLast(tail)
}

/** Formats a byte count into a short human readable size. */
fun Long.asHumanSize(): String {
    if (this < 1024) return "$this B"
    val units = arrayOf("KB", "MB", "GB", "TB")
    var value = this.toDouble()
    var index = -1
    do {
        value /= 1024.0
        index++
    } while (value >= 1024.0 && index < units.lastIndex)
    return String.format(Locale.US, "%.1f %s", value, units[index])
}

/** Formats a millisecond duration relative to now into a short label. */
fun Long.asRelativeTime(now: Long): String {
    val delta = abs(now - this)
    val seconds = delta / 1000
    return when {
        seconds < 60 -> "just now"
        seconds < 3600 -> "${seconds / 60}m ago"
        seconds < 86_400 -> "${seconds / 3600}h ago"
        else -> "${seconds / 86_400}d ago"
    }
}

inline fun <T> Iterable<T>.sumByLong(selector: (T) -> Long): Long {
    var sum = 0L
    for (element in this) sum += selector(element)
    return sum
}
