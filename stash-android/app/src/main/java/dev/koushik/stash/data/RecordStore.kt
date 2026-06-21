package dev.koushik.stash.data

import android.content.Context
import dev.koushik.stash.data.LinkRecord.Status
import org.json.JSONArray
import org.json.JSONObject

/**
 * The single source of truth for every shared link, on disk. Replaces the old
 * split between QueueManager (live queue) and HistoryStore (sent history): there is
 * now one ordered list of [LinkRecord]s with explicit [Status].
 *
 * Durability rules:
 *  - A record is written *before* its first send attempt (see [enqueue]).
 *  - PENDING records are NEVER trimmed — only terminal ones are capped.
 *  - Storage is plain SharedPreferences: links are not secret, and the encrypted
 *    store added crash-on-key-rotation risk for no benefit.
 */
object RecordStore {

    private const val PREFS_FILE = "stash-records.prefs"
    private const val KEY_RECORDS = "records"
    private const val KEY_MIGRATED = "migrated_v1"

    /** Terminal (SENT/FAILED/EXPIRED) records kept for the history view. */
    private const val MAX_TERMINAL = 300

    // Legacy stores we migrate from, once.
    private const val LEGACY_QUEUE_FILE = "stash-queue.prefs"
    private const val LEGACY_QUEUE_KEY = "links"
    private const val LEGACY_HISTORY_FILE = "stash-history.prefs"
    private const val LEGACY_HISTORY_KEY = "entries"

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)

    // --- reads -------------------------------------------------------------

    /** All records, newest first. */
    fun all(ctx: Context): List<LinkRecord> = synchronized(this) {
        migrateIfNeeded(ctx)
        readLocked(ctx).sortedByDescending { it.createdAt }
    }

    /** Records still waiting to be delivered, oldest first (FIFO send order). */
    fun pending(ctx: Context): List<LinkRecord> = synchronized(this) {
        migrateIfNeeded(ctx)
        readLocked(ctx).filter { it.status == Status.PENDING }.sortedBy { it.createdAt }
    }

    fun isPendingEmpty(ctx: Context): Boolean = pending(ctx).isEmpty()

    fun countByStatus(ctx: Context, status: Status): Int = synchronized(this) {
        migrateIfNeeded(ctx)
        readLocked(ctx).count { it.status == status }
    }

    fun hasExhausted(ctx: Context): Boolean = synchronized(this) {
        migrateIfNeeded(ctx)
        readLocked(ctx).any { it.status == Status.FAILED }
    }

    // --- writes ------------------------------------------------------------

    /** Create and persist a PENDING record. Call this before attempting delivery. */
    fun enqueue(ctx: Context, text: String, url: String?, now: Long = System.currentTimeMillis()): LinkRecord {
        val record = LinkRecord.pending(text, url, now)
        synchronized(this) {
            val list = readLocked(ctx).toMutableList()
            list.add(record)
            writeLocked(ctx, list)
        }
        return record
    }

    fun update(ctx: Context, record: LinkRecord) {
        synchronized(this) {
            val list = readLocked(ctx).toMutableList()
            val idx = list.indexOfFirst { it.id == record.id }
            if (idx >= 0) list[idx] = record else list.add(record)
            writeLocked(ctx, list)
        }
    }

    fun markSent(ctx: Context, id: String, now: Long = System.currentTimeMillis()) {
        mutate(ctx) { if (it.id == id) it.markSent(now) else it }
    }

    /**
     * Mark the [count] oldest PENDING records as SENT. The Mac's batch endpoint
     * returns only how many it accepted (in order), so we mark the first N by
     * createdAt — matching the order they were sent.
     */
    fun markFirstPendingSent(ctx: Context, count: Int, now: Long = System.currentTimeMillis()) {
        if (count <= 0) return
        synchronized(this) {
            val list = readLocked(ctx)
            val pendingIds = list.filter { it.status == Status.PENDING }
                .sortedBy { it.createdAt }
                .take(count)
                .map { it.id }
                .toSet()
            if (pendingIds.isEmpty()) return
            writeLocked(ctx, list.map { if (it.id in pendingIds) it.markSent(now) else it })
        }
    }

    /** Record a failed attempt against every currently-PENDING record. */
    fun recordAttemptOnPending(ctx: Context, error: String?, now: Long = System.currentTimeMillis()) {
        mutate(ctx) { if (it.status == Status.PENDING) it.withAttempt(error, now) else it }
    }

    fun fail(ctx: Context, ids: Set<String>, error: String?, now: Long = System.currentTimeMillis()) {
        if (ids.isEmpty()) return
        mutate(ctx) {
            if (it.id in ids && it.status == Status.PENDING) it.markFailed(error, now) else it
        }
    }

    /** Reset a record back to PENDING so the next flush retries it (manual retry). */
    fun requeue(ctx: Context, id: String, now: Long = System.currentTimeMillis()) {
        mutate(ctx) {
            if (it.id == id) {
                it.copy(status = Status.PENDING, attempts = 0, lastError = null, sentAt = null, updatedAt = now)
            } else it
        }
    }

    fun remove(ctx: Context, id: String) {
        synchronized(this) {
            val list = readLocked(ctx)
            val next = list.filterNot { it.id == id }
            if (next.size != list.size) writeLocked(ctx, next)
        }
    }

    /** Move PENDING records older than [maxAgeMs] to EXPIRED. Returns how many. */
    fun expireOlderThan(ctx: Context, maxAgeMs: Long, now: Long = System.currentTimeMillis()): Int {
        synchronized(this) {
            val list = readLocked(ctx)
            var expired = 0
            val next = list.map {
                if (it.status == Status.PENDING && now - it.createdAt >= maxAgeMs) {
                    expired++
                    it.markExpired(now)
                } else it
            }
            if (expired > 0) writeLocked(ctx, next)
            return expired
        }
    }

    /** Remove all terminal (SENT/FAILED/EXPIRED) records, keeping PENDING. */
    fun clearTerminal(ctx: Context) {
        synchronized(this) {
            val list = readLocked(ctx)
            val next = list.filter { it.status == Status.PENDING }
            if (next.size != list.size) writeLocked(ctx, next)
        }
    }

    fun clearAll(ctx: Context) {
        synchronized(this) { prefs(ctx).edit().remove(KEY_RECORDS).apply() }
    }

    // --- internals ---------------------------------------------------------

    private inline fun mutate(ctx: Context, transform: (LinkRecord) -> LinkRecord) {
        synchronized(this) {
            val list = readLocked(ctx)
            writeLocked(ctx, list.map(transform))
        }
    }

    private fun readLocked(ctx: Context): List<LinkRecord> {
        val raw = prefs(ctx).getString(KEY_RECORDS, null) ?: return emptyList()
        return parse(raw)
    }

    private fun parse(raw: String): List<LinkRecord> {
        val array = try { JSONArray(raw) } catch (_: Throwable) { return emptyList() }
        val out = ArrayList<LinkRecord>(array.length())
        for (i in 0 until array.length()) {
            val obj = array.optJSONObject(i) ?: continue
            val record = runCatching { LinkRecord.fromJson(obj) }.getOrNull() ?: continue
            if (record.text.isBlank() && record.url.isNullOrBlank()) continue
            out.add(record)
        }
        return out
    }

    private fun writeLocked(ctx: Context, records: List<LinkRecord>) {
        val bounded = enforceBound(records)
        val array = JSONArray()
        bounded.forEach { array.put(it.toJson()) }
        prefs(ctx).edit().putString(KEY_RECORDS, array.toString()).apply()
    }

    /** Keep every PENDING record; cap terminal records to the most recent. */
    private fun enforceBound(records: List<LinkRecord>): List<LinkRecord> {
        val terminal = records.filter { it.isTerminal }
        if (terminal.size <= MAX_TERMINAL) return records
        val keepTerminal = terminal.sortedByDescending { it.updatedAt }.take(MAX_TERMINAL).toSet()
        return records.filter { !it.isTerminal || it in keepTerminal }
    }

    // --- one-time migration from the legacy split stores -------------------

    private fun migrateIfNeeded(ctx: Context) {
        val p = prefs(ctx)
        if (p.getBoolean(KEY_MIGRATED, false)) return

        val migrated = ArrayList<LinkRecord>()
        val now = System.currentTimeMillis()

        // Old live queue → PENDING records.
        readLegacyArray(ctx, LEGACY_QUEUE_FILE, LEGACY_QUEUE_KEY).forEach { obj ->
            val url = obj.optString("url").takeIf { it.isNotBlank() }
            val text = obj.optString("text").takeIf { it.isNotBlank() } ?: url ?: return@forEach
            val sentAt = obj.optLong("sentAt", now)
            migrated.add(
                LinkRecord(
                    id = java.util.UUID.randomUUID().toString(),
                    text = text,
                    url = url,
                    kind = if (url != null) LinkRecord.Kind.Url else LinkRecord.Kind.Text,
                    status = Status.PENDING,
                    createdAt = sentAt,
                    updatedAt = sentAt,
                )
            )
        }

        // Old delivered history → SENT records (best-effort).
        readLegacyArray(ctx, LEGACY_HISTORY_FILE, LEGACY_HISTORY_KEY).forEach { obj ->
            val record = runCatching { LinkRecord.fromJson(obj) }.getOrNull() ?: return@forEach
            if (record.text.isBlank() && record.url.isNullOrBlank()) return@forEach
            migrated.add(record.copy(status = Status.SENT, sentAt = record.sentAt ?: record.createdAt))
        }

        if (migrated.isNotEmpty()) {
            val existing = readLocked(ctx)
            writeLocked(ctx, existing + migrated)
        }
        p.edit().putBoolean(KEY_MIGRATED, true).apply()
    }

    private fun readLegacyArray(ctx: Context, file: String, key: String): List<JSONObject> {
        val raw = ctx.applicationContext.getSharedPreferences(file, Context.MODE_PRIVATE)
            .getString(key, null) ?: return emptyList()
        val array = try { JSONArray(raw) } catch (_: Throwable) { return emptyList() }
        return buildList(array.length()) {
            for (i in 0 until array.length()) array.optJSONObject(i)?.let { add(it) }
        }
    }
}
