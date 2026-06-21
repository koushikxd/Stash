package dev.koushik.stash.net

import android.content.Context
import android.util.Log
import dev.koushik.stash.data.LinkRecord
import dev.koushik.stash.data.RecordStore
import dev.koushik.stash.data.Secret
import dev.koushik.stash.util.PayloadValidator
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Delivers shared links to the Mac over the LAN. Every send is *write-ahead*: the
 * link is persisted as a PENDING [LinkRecord] before any network call, so nothing
 * is lost if the process dies mid-send. Delivery itself is always a batch flush of
 * the whole pending set, which keeps ordering simple and lets a single share also
 * drain anything that queued while we were away.
 *
 * Endpoint resolution tries, in order: the cached IP (fast ping), fresh mDNS
 * discovery, then the per-subnet pin (for routers that block multicast).
 */
object LinkSender {

    sealed class Result {
        object Sent : Result()
        object Queued : Result()
        object Unauthorized : Result()
        object NoMacFound : Result()
        data class NetworkError(val message: String) : Result()
    }

    sealed class FlushResult {
        object Empty : FlushResult()
        data class Flushed(val count: Int) : FlushResult()
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

    /** Persist the link (PENDING) then attempt to flush everything pending. */
    fun send(ctx: Context, text: String, url: String?, nsdHelper: NsdHelper): Result {
        RecordStore.enqueue(ctx, text, url)
        return when (flushQueue(ctx, nsdHelper)) {
            is FlushResult.Flushed ->
                if (RecordStore.isPendingEmpty(ctx)) Result.Sent else scheduleQueued(ctx)
            is FlushResult.Empty -> Result.Sent
            is FlushResult.Unauthorized -> Result.Unauthorized
            is FlushResult.NoMacFound -> scheduleQueued(ctx)
            is FlushResult.Failed -> scheduleQueued(ctx)
        }
    }

    /** Post every PENDING record as a batch and mark the accepted ones SENT. */
    fun flushQueue(ctx: Context, nsdHelper: NsdHelper): FlushResult {
        retireUndeliverable(ctx)
        val pending = RecordStore.pending(ctx)
        if (pending.isEmpty()) return FlushResult.Empty

        val secret = Secret.secret()
        val endpoint = resolveEndpoint(ctx, nsdHelper, secret)
            ?: return FlushResult.NoMacFound // "away" — leave PENDING, do not burn an attempt
        return postBatch(ctx, endpoint.first, endpoint.second, secret, pending)
    }

    private fun scheduleQueued(ctx: Context): Result {
        FlushQueueWorker.schedule(ctx)
        return Result.Queued
    }

    /**
     * Find a live Mac: cached IP → fresh discovery → per-subnet pin. Persists the
     * winning address so the next send takes the fast path.
     */
    private fun resolveEndpoint(ctx: Context, nsdHelper: NsdHelper, secret: String): Pair<String, Int>? {
        val cachedHost = Secret.getHost(ctx)
        val cachedPort = Secret.getPort(ctx)
        if (!cachedHost.isNullOrBlank() && pingOk(cachedHost, cachedPort, secret)) {
            return cachedHost to cachedPort
        }

        val resolved = nsdHelper.findMac(4000)
        if (resolved != null) {
            Secret.saveHostPort(ctx, resolved.host, resolved.port)
            Secret.saveHostname(ctx, resolved.hostname)
            return resolved.host to resolved.port
        }

        // Multicast-blocked router: fall back to the IP that worked here before.
        val pinned = NetworkPinStore.get(ctx)
        if (pinned != null && pingOk(pinned.first, pinned.second, secret)) {
            Secret.saveHostPort(ctx, pinned.first, pinned.second)
            return pinned
        }
        return null
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

    private fun postBatch(
        ctx: Context,
        host: String,
        port: Int,
        secret: String,
        pending: List<LinkRecord>,
    ): FlushResult {
        val payload = JSONObject().apply {
            put("links", JSONArray().apply {
                pending.forEach { record ->
                    put(JSONObject().apply {
                        put("text", record.text)
                        record.url?.let { put("url", it) }
                        put("sentAt", record.createdAt)
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
                        if (accepted < 0) {
                            RecordStore.recordAttemptOnPending(ctx, "missing accepted")
                            return FlushResult.Failed("missing accepted")
                        }
                        // Batch returns a count only; mark the first N (createdAt order
                        // == send order) SENT.
                        RecordStore.markFirstPendingSent(ctx, accepted)
                        // This IP works on this network — pin it for multicast-blocked routers.
                        NetworkPinStore.put(ctx, host, port)
                        if (accepted >= pending.size) {
                            FlushResult.Flushed(accepted)
                        } else {
                            RecordStore.recordAttemptOnPending(ctx, "partial accept")
                            FlushResult.Failed("accepted $accepted of ${pending.size}")
                        }
                    }
                    401 -> {
                        RecordStore.recordAttemptOnPending(ctx, "Unauthorized")
                        FlushResult.Unauthorized
                    }
                    else -> {
                        RecordStore.recordAttemptOnPending(ctx, "HTTP ${resp.code}")
                        FlushResult.Failed("HTTP ${resp.code}")
                    }
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "POST /links/batch failed", e)
            RecordStore.recordAttemptOnPending(ctx, e.message ?: "io")
            FlushResult.Failed(e.message ?: "io")
        }
    }

    private fun retireUndeliverable(ctx: Context) {
        val ids = RecordStore.pending(ctx)
            .filter { it.text.toByteArray(Charsets.UTF_8).size > PayloadValidator.MAX_PAYLOAD_BYTES }
            .map { it.id }
            .toSet()
        if (ids.isNotEmpty()) {
            RecordStore.fail(ctx, ids, "Payload too large")
        }
    }

    private const val TAG = "LinkSender"
}
