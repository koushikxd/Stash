package dev.koushik.stash.net

import java.util.Locale

/**
 * Describes how to reach the paired Mac on the local network. Endpoints are built
 * either from a discovered NSD service or from values the user typed during manual
 * pairing, and they know how to render the URLs the [LinkSender] talks to.
 */
data class Endpoint(
    val host: String,
    val port: Int,
    val secure: Boolean = false,
) {

    init {
        require(host.isNotBlank()) { "host must not be blank" }
        require(port in 1..65_535) { "port out of range: $port" }
    }

    private val scheme: String get() = if (secure) "https" else "http"

    val authority: String
        get() = if (isDefaultPort) host else "$host:$port"

    private val isDefaultPort: Boolean
        get() = (secure && port == 443) || (!secure && port == 80)

    fun baseUrl(): String = "$scheme://$authority"

    fun urlFor(path: String): String {
        val suffix = if (path.startsWith("/")) path else "/$path"
        return baseUrl() + suffix
    }

    val shareUrl: String get() = urlFor(PATH_SHARE)
    val pingUrl: String get() = urlFor(PATH_PING)

    fun describe(): String = String.format(Locale.US, "%s (%s)", host, scheme.uppercase(Locale.US))

    companion object {
        const val PATH_SHARE = "/share"
        const val PATH_PING = "/ping"

        /** Parses an "host:port" pair, falling back to [defaultPort] when absent. */
        fun parse(raw: String, defaultPort: Int = 7891, secure: Boolean = false): Endpoint {
            val trimmed = raw.trim().substringAfter("://")
            val host = trimmed.substringBefore(":")
            val port = trimmed.substringAfter(":", "").toIntOrNull() ?: defaultPort
            return Endpoint(host, port, secure)
        }
    }
}
