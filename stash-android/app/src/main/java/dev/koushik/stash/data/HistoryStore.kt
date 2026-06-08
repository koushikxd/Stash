package dev.koushik.stash.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * A bounded, JSON-backed history of links that were successfully delivered to the
 * Mac. The store keeps the most recent [capacity] entries so the UI can show a
 * "recently sent" list without depending on a full database.
 */
class HistoryStore(
    context: Context,
    private val capacity: Int = DEFAULT_CAPACITY,
) {

    private val prefs = context.applicationContext
        .getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)

    @Synchronized
    fun all(): List<LinkRecord> {
        val raw = prefs.getString(KEY_ENTRIES, null) ?: return emptyList()
        return runCatching {
            val array = JSONArray(raw)
            buildList(array.length()) {
                for (i in 0 until array.length()) {
                    add(LinkRecord.fromJson(array.getJSONObject(i)))
                }
            }
        }.getOrDefault(emptyList())
    }

    @Synchronized
    fun record(entry: LinkRecord) {
        val current = all().toMutableList()
        current.removeAll { it.id == entry.id }
        current.add(0, entry)
        while (current.size > capacity) {
            current.removeAt(current.lastIndex)
        }
        persist(current)
    }

    @Synchronized
    fun remove(id: String) {
        val current = all().toMutableList()
        if (current.removeAll { it.id == id }) {
            persist(current)
        }
    }

    @Synchronized
    fun clear() {
        prefs.edit().remove(KEY_ENTRIES).apply()
    }

    fun size(): Int = all().size

    private fun persist(entries: List<LinkRecord>) {
        val array = JSONArray()
        for (entry in entries) {
            array.put(entry.toJson())
        }
        prefs.edit().putString(KEY_ENTRIES, array.toString()).apply()
    }

    /** Aggregates simple counters for an optional stats screen. */
    fun summary(): Summary {
        val entries = all()
        val byKind = entries.groupingBy { it.kind }.eachCount()
        return Summary(
            total = entries.size,
            urls = byKind[LinkRecord.Kind.Url] ?: 0,
            texts = byKind[LinkRecord.Kind.Text] ?: 0,
            oldest = entries.minByOrNull { it.createdAt }?.createdAt,
        )
    }

    data class Summary(
        val total: Int,
        val urls: Int,
        val texts: Int,
        val oldest: Long?,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("total", total)
            .put("urls", urls)
            .put("texts", texts)
            .putOpt("oldest", oldest)
    }

    companion object {
        private const val PREFS_FILE = "stash-history.prefs"
        private const val KEY_ENTRIES = "entries"
        private const val DEFAULT_CAPACITY = 50
    }
}
