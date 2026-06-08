package dev.koushik.stash.util

import java.util.Locale

/**
 * Validates and classifies the raw text the share sheet hands us before it is
 * enqueued. Keeping this separate from the activities means the rules can be
 * exercised in plain JVM unit tests and reused by both the share and paste paths.
 */
object PayloadValidator {

    private const val MAX_PAYLOAD_BYTES = 64 * 1024

    sealed class Verdict {
        data class Url(val normalized: String) : Verdict()
        data class Text(val cleaned: String) : Verdict()
        data class Rejected(val reason: Failure) : Verdict()
    }

    fun classify(raw: String?): Verdict {
        if (raw == null) return Verdict.Rejected(Failure.BadResponse)
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return Verdict.Rejected(Failure.BadResponse)
        if (trimmed.toByteArray(Charsets.UTF_8).size > MAX_PAYLOAD_BYTES) {
            return Verdict.Rejected(Failure.BadResponse)
        }

        val singleToken = trimmed.none { it.isWhitespace() }
        if (singleToken && trimmed.looksLikeUrl()) {
            return Verdict.Url(trimmed.stripTrackingParams())
        }

        val embedded = firstUrlIn(trimmed)
        if (embedded != null && embedded == trimmed) {
            return Verdict.Url(embedded.stripTrackingParams())
        }

        return Verdict.Text(trimmed.normalizeWhitespace())
    }

    /** Extracts the first http(s) token from a block of text, if any. */
    fun firstUrlIn(text: String): String? {
        for (token in text.split(Regex("\\s+"))) {
            if (token.looksLikeUrl()) return token
        }
        return null
    }

    /** A coarse content hint used only for analytics/labels, never for routing. */
    fun contentHint(raw: String): String {
        val lower = raw.lowercase(Locale.US)
        return when {
            lower.contains("youtube.com") || lower.contains("youtu.be") -> "video"
            lower.contains("github.com") -> "code"
            lower.contains("twitter.com") || lower.contains("x.com") -> "social"
            looksLikeUrlList(raw) -> "links"
            raw.looksLikeUrl() -> "link"
            else -> "text"
        }
    }

    private fun looksLikeUrlList(raw: String): Boolean {
        val lines = raw.lines().map { it.trim() }.filter { it.isNotEmpty() }
        return lines.size > 1 && lines.all { it.looksLikeUrl() }
    }
}
