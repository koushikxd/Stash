package dev.koushik.stash.net

import android.content.Context
import android.util.Log
import dev.koushik.stash.data.QueueManager
import dev.koushik.stash.data.Secret
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

object LinkSender {

    sealed class Result {
        object Sent : Result()
        object Queued : Result()
        object NotPaired : Result()
        object Unauthorized : Result()
        object NoMacFound : Result()
        data class NetworkError(val message: String) : Result()
    }

    sealed class FlushResult {
        object Empty : FlushResult()
        data class Flushed(val count: Int) : FlushResult()
        object NotPaired : FlushResult()
        object Unauthorized : FlushResult()
        object NoMacFound : FlushResult()
        data class Failed(val message: String) : FlushResult()
    }

    private val JSON = "application/json; charset=utf-8".toMediaType()

    private val standardClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .writeTimeout(5, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()

    private val pingClient: OkHttpClient = standardClient.newBuilder()
        .connectTimeout(500, TimeUnit.MILLISECONDS)
        .readTimeout(500, TimeUnit.MILLISECONDS)
        .writeTimeout(500, TimeUnit.MILLISECONDS)
        .build()

    fun send(ctx: Context, text: String, url: String?, nsdHelper: NsdHelper): Result {
        if (!QueueManager.isEmpty(ctx)) {
            QueueManager.enqueue(ctx, text, url)
            return when (val result = flushQueue(ctx, nsdHelper)) {
                is FlushResult.Flushed -> Result.Sent
                is FlushResult.Empty -> Result.Sent
                is FlushResult.NotPaired -> Result.NotPaired
                is FlushResult.Unauthorized -> Result.Unauthorized
                is FlushResult.NoMacFound -> scheduleQueued(ctx)
                is FlushResult.Failed -> scheduleQueued(ctx)
            }
        }

        val secret = Secret.getSecret(ctx) ?: return Result.NotPaired
        val cachedHost = Secret.getHost(ctx)
        val cachedPort = Secret.getPort(ctx)

        if (!cachedHost.isNullOrBlank() && pingOk(cachedHost, cachedPort, secret)) {
            val result = postItem(cachedHost, cachedPort, secret, text, url)
            return if (result.shouldQueue()) queue(ctx, text, url) else result
        }

        val resolved = nsdHelper.findMac(3000) ?: return queue(ctx, text, url)
        val host = resolved.host
        val port = resolved.port
        Secret.saveHostPort(ctx, host, port)
        val result = postItem(host, port, secret, text, url)
        return if (result.shouldQueue()) queue(ctx, text, url) else result
    }

    fun flushQueue(ctx: Context, nsdHelper: NsdHelper): FlushResult {
        val queued = QueueManager.readAll(ctx)
        if (queued.isEmpty()) return FlushResult.Empty

        val secret = Secret.getSecret(ctx) ?: return FlushResult.NotPaired
        val cachedHost = Secret.getHost(ctx)
        val cachedPort = Secret.getPort(ctx)

        if (!cachedHost.isNullOrBlank() && pingOk(cachedHost, cachedPort, secret)) {
            return postBatch(ctx, cachedHost, cachedPort, secret, queued)
        }

        val resolved = nsdHelper.findMac(4000) ?: return FlushResult.NoMacFound
        val host = resolved.host
        val port = resolved.port
        Secret.saveHostPort(ctx, host, port)
        return postBatch(ctx, host, port, secret, queued)
    }

    private fun queue(ctx: Context, text: String, url: String?): Result {
        QueueManager.enqueue(ctx, text, url)
        return scheduleQueued(ctx)
    }

    private fun scheduleQueued(ctx: Context): Result {
        FlushQueueWorker.schedule(ctx)
        return Result.Queued
    }

    private fun Result.shouldQueue(): Boolean = this is Result.NoMacFound || this is Result.NetworkError

    private fun pingOk(host: String, port: Int, secret: String): Boolean {
        val req = Request.Builder()
            .url("http://$host:$port/ping")
            .header("Authorization", "Bearer $secret")
            .get()
            .build()
        return try {
            pingClient.newCall(req).execute().use { resp -> resp.isSuccessful }
        } catch (e: IOException) {
            Log.d(TAG, "ping miss: ${e.message}")
            false
        }
    }

    private fun postItem(host: String, port: Int, secret: String, text: String, url: String?): Result {
        val payload = JSONObject().apply {
            put("text", text)
            url?.let { put("url", it) }
            put("sentAt", System.currentTimeMillis())
        }.toString()
        val req = Request.Builder()
            .url("http://$host:$port/links")
            .header("Authorization", "Bearer $secret")
            .post(payload.toRequestBody(JSON))
            .build()
        return try {
            standardClient.newCall(req).execute().use { resp ->
                when (resp.code) {
                    200, 201 -> Result.Sent
                    401 -> Result.Unauthorized
                    else -> Result.NetworkError("HTTP ${resp.code}")
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "POST /links failed", e)
            Result.NetworkError(e.message ?: "io")
        }
    }

    private fun postBatch(
        ctx: Context,
        host: String,
        port: Int,
        secret: String,
        links: List<QueueManager.QueuedItem>
    ): FlushResult {
        val payload = JSONObject().apply {
            put("links", org.json.JSONArray().apply {
                links.forEach { link ->
                    put(JSONObject().apply {
                        put("text", link.text)
                        link.url?.let { put("url", it) }
                        put("sentAt", link.sentAt)
                    })
                }
            })
        }.toString()
        val req = Request.Builder()
            .url("http://$host:$port/links/batch")
            .header("Authorization", "Bearer $secret")
            .post(payload.toRequestBody(JSON))
            .build()
        return try {
            standardClient.newCall(req).execute().use { resp ->
                when (resp.code) {
                    200 -> {
                        val accepted = resp.body?.string()?.let { body ->
                            try { JSONObject(body).optInt("accepted", -1) } catch (_: Throwable) { -1 }
                        } ?: -1
                        if (accepted < 0) return FlushResult.Failed("missing accepted")
                        QueueManager.removeFirst(ctx, accepted)
                        if (accepted == links.size) FlushResult.Flushed(accepted) else FlushResult.Failed("accepted $accepted of ${links.size}")
                    }
                    401 -> FlushResult.Unauthorized
                    else -> FlushResult.Failed("HTTP ${resp.code}")
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "POST /links/batch failed", e)
            FlushResult.Failed(e.message ?: "io")
        }
    }

    private const val TAG = "LinkSender"
}
