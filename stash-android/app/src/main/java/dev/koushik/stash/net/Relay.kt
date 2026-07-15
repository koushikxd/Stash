package dev.koushik.stash.net

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Thin transport over the public ntfy.sh pub/sub relay. It knows nothing about
 * records or crypto — it just publishes an (already-encrypted) body to a topic and
 * polls a topic for cached messages since a given ntfy message id.
 *
 * Base URL is a single constant so the whole relay can be pointed at a self-hosted
 * ntfy instance later with a one-line change.
 */
object Relay {

    const val BASE_URL = "https://ntfy.sh"

    private val BODY = "text/plain; charset=utf-8".toMediaType()

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()

    sealed class PublishResult {
        object Ok : PublishResult()
        data class Error(val message: String) : PublishResult()
    }

    data class RelayMessage(val ntfyId: String, val body: String)

    fun publish(topic: String, body: String): PublishResult {
        val req = Request.Builder()
            .url("$BASE_URL/$topic")
            .post(body.toRequestBody(BODY))
            .build()
        return try {
            client.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) PublishResult.Ok
                else PublishResult.Error("HTTP ${resp.code}")
            }
        } catch (e: IOException) {
            Log.d(TAG, "publish failed: ${e.message}")
            PublishResult.Error(e.message ?: "io")
        }
    }

    /**
     * Poll the topic's cached messages newer than [since] (an ntfy message id, or
     * "all" for everything still cached). Returns the messages in order, or null on
     * a network error (so the caller can distinguish "empty" from "couldn't reach").
     */
    fun poll(topic: String, since: String): List<RelayMessage>? {
        val req = Request.Builder()
            .url("$BASE_URL/$topic/json?poll=1&since=$since")
            .get()
            .build()
        return try {
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val out = ArrayList<RelayMessage>()
                resp.body?.string()?.lineSequence()?.forEach { line ->
                    val trimmed = line.trim()
                    if (trimmed.isEmpty()) return@forEach
                    val obj = try { JSONObject(trimmed) } catch (_: Throwable) { return@forEach }
                    if (obj.optString("event") != "message") return@forEach
                    val id = obj.optString("id").takeIf { it.isNotBlank() } ?: return@forEach
                    val body = obj.optString("message").takeIf { it.isNotBlank() } ?: return@forEach
                    out.add(RelayMessage(id, body))
                }
                out
            }
        } catch (e: IOException) {
            Log.d(TAG, "poll failed: ${e.message}")
            null
        }
    }

    private const val TAG = "Relay"
}
