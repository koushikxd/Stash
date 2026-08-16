package dev.koushik.stash.net

import android.content.Context
import dev.koushik.stash.data.LinkRecord
import dev.koushik.stash.data.RecordStore
import dev.koushik.stash.data.Secret
import dev.koushik.stash.util.Crypto
import org.json.JSONObject

/**
 * Delivers shared links to the Mac through the Redis Stream relay. Every send is
 * *write-ahead*: the link is persisted as a PENDING [LinkRecord] before any network
 * call, so nothing is lost if the process dies mid-send.
 *
 * A successful XADD is the delivery guarantee: the entry is stored for the full
 * retention window and the Mac reads it exactly once from its own cursor, so
 * "accepted by the relay" and "will reach the Mac" are the same thing. The record
 * therefore goes straight to SENT, with no acknowledgement round trip.
 */
object LinkSender {

    sealed class Result {
        object Sent : Result()       // on the relay stream — delivery guaranteed
        object Queued : Result()     // offline — will publish on reconnect
        object TooLarge : Result()   // rejected outright — retrying can't help
    }

    sealed class FlushResult {
        object Empty : FlushResult()
        data class Flushed(val published: Int) : FlushResult()
        data class Failed(val message: String) : FlushResult()
    }

    /**
     * Upper bound on a single encrypted envelope. Generous because the record carries
     * `text` and `url` separately (often the same string) and base64 adds a third on
     * top, so a URL near [PayloadValidator.MAX_PAYLOAD_BYTES] can approach 8 KB. The
     * old 4 KB ceiling was ntfy's body limit and doesn't apply to a Redis stream.
     */
    private const val MAX_ENVELOPE_BYTES = 16 * 1024

    /** Persist the link (PENDING), then publish it and everything else pending. */
    fun send(ctx: Context, text: String, url: String?): Result {
        val record = RecordStore.enqueue(ctx, text, url)
        flushQueue(ctx)

        return when (RecordStore.find(ctx, record.id)?.status) {
            LinkRecord.Status.SENT -> Result.Sent
            LinkRecord.Status.FAILED -> Result.TooLarge
            else -> {
                FlushQueueWorker.schedule(ctx)
                Result.Queued
            }
        }
    }

    /**
     * Publish every PENDING record, oldest first. Aborts on the first failure — we're
     * offline; WorkManager retries. Records published here are immediately SENT.
     */
    fun flushQueue(ctx: Context): FlushResult {
        val pending = RecordStore.pending(ctx)
        if (pending.isEmpty()) return FlushResult.Empty

        val secret = Secret.secret()
        val key = Crypto.key(secret)
        val mainStream = Crypto.topic("main", secret)
        var published = 0
        for (record in pending) {
            val envelope = Crypto.encrypt(key, linkJson(record))
            if (envelope.toByteArray(Charsets.UTF_8).size > MAX_ENVELOPE_BYTES) {
                RecordStore.fail(ctx, setOf(record.id), "Too large to send")
                continue
            }
            when (val r = Relay.publish(mainStream, envelope)) {
                is Relay.PublishResult.Ok -> {
                    RecordStore.markSent(ctx, record.id)
                    published++
                }
                is Relay.PublishResult.Error -> {
                    RecordStore.recordAttempt(ctx, record.id, r.message)
                    return FlushResult.Failed(r.message)
                }
            }
        }
        return FlushResult.Flushed(published)
    }

    private fun linkJson(record: LinkRecord): String = JSONObject().apply {
        put("v", 1)
        put("t", "link")
        put("id", record.id)
        put("text", record.text)
        record.url?.let { put("url", it) }
        put("createdAt", record.createdAt)
    }.toString()

}
