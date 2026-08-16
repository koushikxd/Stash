package dev.koushik.stash.net

import android.util.Log
import dev.koushik.stash.data.Secret
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Thin transport over Upstash Redis Streams (REST). It knows nothing about records or
 * crypto — it just XADDs an (already-encrypted) body to a stream, which then waits
 * there whether or not the Mac is awake.
 *
 * The phone only ever writes. Reading and 30-day retention (XTRIM) belong to the Mac,
 * the only reader, so a share costs exactly one round trip.
 */
object Relay {

    private const val TAG = "Relay"
    private val JSON = "application/json; charset=utf-8".toMediaType()

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

    /**
     * Append one entry to [stream]. Errors stay generic: no token, stream name, or
     * payload is ever logged.
     */
    fun publish(stream: String, body: String): PublishResult {
        if (!Secret.isRelayConfigured()) return PublishResult.Error("relay not configured")

        val command = JSONArray(listOf("XADD", stream, "*", "body", body)).toString()
        val req = Request.Builder()
            .url(Secret.relayUrl())
            .header("Authorization", "Bearer ${Secret.relayToken()}")
            .post(command.toRequestBody(JSON))
            .build()
        return try {
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    Log.d(TAG, "publish failed: HTTP ${resp.code}")
                    return PublishResult.Error("relay unavailable")
                }
                // Upstash answers {"result": "<entry id>"} or {"error": "..."}.
                val id = JSONObject(resp.body?.string().orEmpty()).optString("result")
                if (id.isEmpty()) PublishResult.Error("relay rejected write") else PublishResult.Ok
            }
        } catch (_: IOException) {
            PublishResult.Error("relay unavailable")
        } catch (_: JSONException) {
            PublishResult.Error("relay rejected write")
        }
    }
}
