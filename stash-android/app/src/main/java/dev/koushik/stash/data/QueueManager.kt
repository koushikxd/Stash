package dev.koushik.stash.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

object QueueManager {

    data class QueuedItem(val text: String, val url: String?, val sentAt: Long)

    private const val PREFS_FILE = "stash-queue.prefs"
    private const val KEY_LINKS = "links"
    private const val MAX_QUEUE_SIZE = 1000

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)

    fun enqueue(ctx: Context, text: String, url: String?, sentAt: Long = System.currentTimeMillis()) {
        synchronized(this) {
            val links = readAllLocked(ctx).toMutableList()
            links.add(QueuedItem(text, url, sentAt))
            val bounded = if (links.size > MAX_QUEUE_SIZE) links.takeLast(MAX_QUEUE_SIZE) else links
            writeLocked(ctx, bounded)
        }
    }

    fun readAll(ctx: Context): List<QueuedItem> = synchronized(this) { readAllLocked(ctx) }

    fun clear(ctx: Context) {
        synchronized(this) {
            prefs(ctx).edit().remove(KEY_LINKS).apply()
        }
    }

    fun removeFirst(ctx: Context, count: Int) {
        if (count <= 0) return
        synchronized(this) {
            val links = readAllLocked(ctx)
            if (count >= links.size) {
                prefs(ctx).edit().remove(KEY_LINKS).apply()
            } else {
                writeLocked(ctx, links.drop(count))
            }
        }
    }

    fun isEmpty(ctx: Context): Boolean = readAll(ctx).isEmpty()

    private fun readAllLocked(ctx: Context): List<QueuedItem> {
        val raw = prefs(ctx).getString(KEY_LINKS, null) ?: return emptyList()
        val array = try { JSONArray(raw) } catch (_: Throwable) { return emptyList() }
        val links = ArrayList<QueuedItem>(array.length())
        for (i in 0 until array.length()) {
            val obj = array.optJSONObject(i) ?: continue
            val url = obj.optString("url").takeIf { it.isNotBlank() }
            val text = obj.optString("text").takeIf { it.isNotBlank() } ?: url ?: continue
            val sentAt = obj.optLong("sentAt", System.currentTimeMillis())
            links.add(QueuedItem(text, url, sentAt))
        }
        return links
    }

    private fun writeLocked(ctx: Context, links: List<QueuedItem>) {
        val array = JSONArray()
        links.forEach { link ->
            array.put(JSONObject().apply {
                put("text", link.text)
                link.url?.let { put("url", it) }
                put("sentAt", link.sentAt)
            })
        }
        prefs(ctx).edit().putString(KEY_LINKS, array.toString()).apply()
    }
}
