package dev.koushik.pop.net

import android.content.Context
import android.util.Log
import dev.koushik.pop.data.QueueManager
import dev.koushik.pop.data.Secret
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

    fun send(ctx: Context, url: String, nsdHelper: NsdHelper): Result {
        val secret = Secret.getSecret(ctx) ?: return Result.NotPaired
        val cachedHost = Secret.getHost(ctx)
        val cachedPort = Secret.getPort(ctx)

        if (!cachedHost.isNullOrBlank() && pingOk(cachedHost, cachedPort, secret)) {
            val result = postLink(cachedHost, cachedPort, secret, url)
            return if (result.shouldQueue()) queue(ctx, url) else result
        }

        val resolved = nsdHelper.findMac(3000) ?: return queue(ctx, url)
        val (host, port) = resolved
        Secret.saveHostPort(ctx, host, port)
        val result = postLink(host, port, secret, url)
        return if (result.shouldQueue()) queue(ctx, url) else result
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
        val (host, port) = resolved
        Secret.saveHostPort(ctx, host, port)
        return postBatch(ctx, host, port, secret, queued)
    }

    private fun queue(ctx: Context, url: String): Result {
        QueueManager.enqueue(ctx, url)
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

    private fun postLink(host: String, port: Int, secret: String, url: String): Result {
        val payload = JSONObject().apply {
            put("url", url)
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
                    201 -> Result.Sent
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
        links: List<QueueManager.QueuedLink>
    ): FlushResult {
        val payload = JSONObject().apply {
            put("links", org.json.JSONArray().apply {
                links.forEach { link ->
                    put(JSONObject().apply {
                        put("url", link.url)
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
                        QueueManager.clear(ctx)
                        FlushResult.Flushed(links.size)
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
