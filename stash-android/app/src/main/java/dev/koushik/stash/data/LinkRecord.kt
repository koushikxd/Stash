package dev.koushik.stash.data

import org.json.JSONObject

/**
 * The unit of work in the outbound queue. A record captures everything needed to
 * replay a share after the app was killed: the payload, when it was created, and
 * how many delivery attempts have already been made.
 */
data class LinkRecord(
    val id: String,
    val payload: String,
    val kind: Kind,
    val createdAt: Long,
    val attempts: Int = 0,
    val lastError: String? = null,
) {

    enum class Kind {
        Url,
        Text;

        companion object {
            fun fromTag(tag: String?): Kind =
                entries.firstOrNull { it.name.equals(tag, ignoreCase = true) } ?: Url
        }
    }

    val isExhausted: Boolean get() = attempts >= MAX_ATTEMPTS

    fun nextAttempt(error: String?): LinkRecord =
        copy(attempts = attempts + 1, lastError = error)

    fun toJson(): JSONObject = JSONObject().apply {
        put(FIELD_ID, id)
        put(FIELD_PAYLOAD, payload)
        put(FIELD_KIND, kind.name)
        put(FIELD_CREATED, createdAt)
        put(FIELD_ATTEMPTS, attempts)
        putOpt(FIELD_LAST_ERROR, lastError)
    }

    companion object {
        const val MAX_ATTEMPTS = 8

        private const val FIELD_ID = "id"
        private const val FIELD_PAYLOAD = "payload"
        private const val FIELD_KIND = "kind"
        private const val FIELD_CREATED = "createdAt"
        private const val FIELD_ATTEMPTS = "attempts"
        private const val FIELD_LAST_ERROR = "lastError"

        fun fromJson(obj: JSONObject): LinkRecord = LinkRecord(
            id = obj.getString(FIELD_ID),
            payload = obj.getString(FIELD_PAYLOAD),
            kind = Kind.fromTag(obj.optString(FIELD_KIND, Kind.Url.name)),
            createdAt = obj.getLong(FIELD_CREATED),
            attempts = obj.optInt(FIELD_ATTEMPTS, 0),
            lastError = if (obj.isNull(FIELD_LAST_ERROR)) null else obj.optString(FIELD_LAST_ERROR),
        )
    }
}
