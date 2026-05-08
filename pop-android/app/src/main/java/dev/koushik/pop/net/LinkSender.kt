package dev.koushik.pop.net

import android.content.Context
import android.util.Log
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
        object NotPaired : Result()
        object Unauthorized : Result()
        object NoMacFound : Result()
        data class NetworkError(val message: String) : Result()
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
            return postLink(cachedHost, cachedPort, secret, url)
        }

        val resolved = nsdHelper.findMac(3000) ?: return Result.NoMacFound
        val (host, port) = resolved
        Secret.saveHostPort(ctx, host, port)
        return postLink(host, port, secret, url)
    }

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

    private const val TAG = "LinkSender"
}
