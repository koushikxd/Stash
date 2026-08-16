package dev.koushik.stash.data

import org.json.JSONObject
import java.util.UUID

/**
 * One shared link, durably tracked from the moment it is created until it is
 * delivered (or expires). A record is written *before* the first network attempt
 * (write-ahead), so nothing is lost if the process is killed mid-send.
 *
 * [status] is the single source of truth the Links screen renders:
 *  - PENDING — waiting to be delivered (queued)
 *  - SENT    — confirmed accepted by the Mac
 *  - FAILED  — gave up after [MAX_ATTEMPTS] attempts
 *  - EXPIRED — sat PENDING longer than the retention window and was retired
 */
data class LinkRecord(
    val id: String,
    val text: String,
    val url: String?,
    val kind: Kind,
    val status: Status,
    val createdAt: Long,
    val updatedAt: Long,
    val sentAt: Long? = null,
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

    enum class Status {
        PENDING,
        SENT,
        FAILED,
        EXPIRED;

        companion object {
            fun fromTag(tag: String?): Status =
                entries.firstOrNull { it.name.equals(tag, ignoreCase = true) } ?: PENDING
        }
    }

    val isTerminal: Boolean get() = status != Status.PENDING

    fun markSent(now: Long): LinkRecord =
        copy(status = Status.SENT, sentAt = now, updatedAt = now, lastError = null)

    fun withAttempt(error: String?, now: Long): LinkRecord {
        val nextAttempts = attempts + 1
        val exhausted = nextAttempts >= MAX_ATTEMPTS
        return copy(
            attempts = nextAttempts,
            lastError = error,
            updatedAt = now,
            status = if (exhausted) Status.FAILED else Status.PENDING,
        )
    }

    fun markFailed(error: String?, now: Long): LinkRecord =
        copy(
            status = Status.FAILED,
            attempts = MAX_ATTEMPTS,
            lastError = error,
            updatedAt = now,
        )

    fun markExpired(now: Long): LinkRecord =
        copy(status = Status.EXPIRED, updatedAt = now)

    fun toJson(): JSONObject = JSONObject().apply {
        put(FIELD_ID, id)
        put(FIELD_TEXT, text)
        putOpt(FIELD_URL, url)
        put(FIELD_KIND, kind.name)
        put(FIELD_STATUS, status.name)
        put(FIELD_CREATED, createdAt)
        put(FIELD_UPDATED, updatedAt)
        putOpt(FIELD_SENT_AT, sentAt)
        put(FIELD_ATTEMPTS, attempts)
        putOpt(FIELD_LAST_ERROR, lastError)
    }

    companion object {
        const val MAX_ATTEMPTS = 8

        private const val FIELD_ID = "id"
        private const val FIELD_TEXT = "text"
        private const val FIELD_URL = "url"
        private const val FIELD_KIND = "kind"
        private const val FIELD_STATUS = "status"
        private const val FIELD_CREATED = "createdAt"
        private const val FIELD_UPDATED = "updatedAt"
        private const val FIELD_SENT_AT = "sentAt"
        private const val FIELD_ATTEMPTS = "attempts"
        private const val FIELD_LAST_ERROR = "lastError"

        /** A fresh PENDING record for newly shared content. */
        fun pending(text: String, url: String?, now: Long): LinkRecord = LinkRecord(
            id = UUID.randomUUID().toString(),
            text = text,
            url = url,
            kind = if (url != null) Kind.Url else Kind.Text,
            status = Status.PENDING,
            createdAt = now,
            updatedAt = now,
        )

        fun fromJson(obj: JSONObject): LinkRecord {
            // Tolerate the legacy shape (a single "payload" field, no status) so an
            // older install's data survives the upgrade to the unified store.
            val text = obj.optString(FIELD_TEXT).takeIf { it.isNotBlank() }
                ?: obj.optString("payload")
            val url = if (obj.isNull(FIELD_URL)) null else obj.optString(FIELD_URL).takeIf { it.isNotBlank() }
            val created = obj.optLong(FIELD_CREATED, System.currentTimeMillis())
            return LinkRecord(
                id = obj.optString(FIELD_ID).takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString(),
                text = text,
                url = url,
                kind = Kind.fromTag(obj.optString(FIELD_KIND, if (url != null) Kind.Url.name else Kind.Text.name)),
                status = Status.fromTag(obj.optString(FIELD_STATUS, Status.PENDING.name)),
                createdAt = created,
                updatedAt = obj.optLong(FIELD_UPDATED, created),
                sentAt = if (obj.isNull(FIELD_SENT_AT)) null else obj.optLong(FIELD_SENT_AT).takeIf { it > 0 },
                attempts = obj.optInt(FIELD_ATTEMPTS, 0),
                lastError = if (obj.isNull(FIELD_LAST_ERROR)) null else obj.optString(FIELD_LAST_ERROR).takeIf { it.isNotBlank() },
            )
        }
    }
}
