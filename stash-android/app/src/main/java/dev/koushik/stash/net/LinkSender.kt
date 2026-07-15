package dev.koushik.stash.net

import android.content.Context
import android.util.Log
import dev.koushik.stash.data.LinkRecord
import dev.koushik.stash.data.RecordStore
import dev.koushik.stash.data.RelayState
import dev.koushik.stash.data.Secret
import dev.koushik.stash.util.Crypto
import dev.koushik.stash.util.PayloadValidator
import org.json.JSONObject
import javax.crypto.spec.SecretKeySpec

/**
 * Delivers shared links to the Mac through the ntfy.sh relay. Every send is
 * *write-ahead*: the link is persisted as a PENDING [LinkRecord] before any network
 * call, so nothing is lost if the process dies mid-send.
 *
 * Delivery is end-to-end: the phone encrypts each record and publishes it to a
 * secret-derived topic; the Mac decrypts, displays, and publishes an encrypted ack
 * to a second topic. A record is only marked SENT once its ack arrives — so
 * "nothing silently lost" holds even though the transport is a public relay.
 */
object LinkSender {

    sealed class Result {
        object Sent : Result()       // acked by the Mac
        object Published : Result()  // on the relay, awaiting the Mac's ack
        object Queued : Result()     // offline — will publish on reconnect
    }

    sealed class FlushResult {
        object Empty : FlushResult()
        data class Flushed(val published: Int) : FlushResult()
        data class Failed(val message: String) : FlushResult()
    }

    /** Re-publish an unacked record only after this long (ntfy caches messages ~12h). */
    private const val REPUBLISH_AFTER_MS = 11L * 60 * 60 * 1000

    /** ntfy turns bodies larger than this into attachments, which breaks decrypt. */
    private const val MAX_ENVELOPE_BYTES = 4096

    /** Brief wait for the Mac's ack after a foreground share, before we toast. */
    private const val ACK_WAIT_MS = 1500L

    /** Persist the link (PENDING), publish it, then briefly wait for the ack. */
    fun send(ctx: Context, text: String, url: String?): Result {
        val record = RecordStore.enqueue(ctx, text, url)

        if (flushQueue(ctx) is FlushResult.Failed) {
            FlushQueueWorker.schedule(ctx)
            return Result.Queued
        }

        // Published (or retired). Give the Mac a moment to ack, then check once.
        val afterFlush = RecordStore.find(ctx, record.id)
        if (afterFlush?.status == LinkRecord.Status.PENDING && afterFlush.publishedAt != null) {
            try { Thread.sleep(ACK_WAIT_MS) } catch (_: InterruptedException) {}
            val secret = Secret.secret()
            checkAcks(ctx, Crypto.key(secret), Crypto.topic("ack", secret))
        }

        return when (RecordStore.find(ctx, record.id)?.status) {
            LinkRecord.Status.SENT -> Result.Sent
            LinkRecord.Status.PENDING -> {
                FlushQueueWorker.schedule(ctx)
                Result.Published
            }
            else -> Result.Queued
        }
    }

    /**
     * Apply any acks waiting on the relay, then publish every eligible PENDING
     * record (never published, or last published over [REPUBLISH_AFTER_MS] ago).
     * Aborts on the first publish failure — we're offline; WorkManager will retry.
     */
    fun flushQueue(ctx: Context): FlushResult {
        retireOversize(ctx)

        val secret = Secret.secret()
        val key = Crypto.key(secret)
        checkAcks(ctx, key, Crypto.topic("ack", secret))

        val pending = RecordStore.pending(ctx)
        if (pending.isEmpty()) return FlushResult.Empty

        val mainTopic = Crypto.topic("main", secret)
        val now = System.currentTimeMillis()
        var published = 0
        for (record in pending) {
            val age = record.publishedAt?.let { now - it }
            if (age != null && age < REPUBLISH_AFTER_MS) continue // already on the relay, awaiting ack

            val envelope = Crypto.encrypt(key, linkJson(record))
            if (envelope.toByteArray(Charsets.UTF_8).size > MAX_ENVELOPE_BYTES) {
                RecordStore.fail(ctx, setOf(record.id), "Too large to send")
                continue
            }
            when (val r = Relay.publish(mainTopic, envelope)) {
                is Relay.PublishResult.Ok -> {
                    RecordStore.markPublished(ctx, record.id)
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

    /** Poll the ack topic, apply acks to PENDING records, and advance our read cursor. */
    private fun checkAcks(ctx: Context, key: SecretKeySpec, ackTopic: String) {
        val since = RelayState.getAckSince(ctx)
        val messages = Relay.poll(ackTopic, since) ?: return // network error — try again later
        if (messages.isEmpty()) return

        val ackedIds = HashSet<String>()
        for (msg in messages) {
            val plain = Crypto.decrypt(key, msg.body) ?: continue
            val obj = try { JSONObject(plain) } catch (_: Throwable) { continue }
            if (obj.optInt("v") != 1 || obj.optString("t") != "ack") continue
            val ids = obj.optJSONArray("ids") ?: continue
            for (i in 0 until ids.length()) ids.optString(i).takeIf { it.isNotBlank() }?.let(ackedIds::add)
        }
        RecordStore.markSentIfPending(ctx, ackedIds)
        RelayState.setAckSince(ctx, messages.last().ntfyId)
    }

    private fun linkJson(record: LinkRecord): String = JSONObject().apply {
        put("v", 1)
        put("t", "link")
        put("id", record.id)
        put("text", record.text)
        record.url?.let { put("url", it) }
        put("createdAt", record.createdAt)
    }.toString()

    private fun retireOversize(ctx: Context) {
        val ids = RecordStore.pending(ctx)
            .filter { it.text.toByteArray(Charsets.UTF_8).size > PayloadValidator.MAX_PAYLOAD_BYTES }
            .map { it.id }
            .toSet()
        if (ids.isNotEmpty()) {
            Log.d(TAG, "retiring ${ids.size} oversize record(s)")
            RecordStore.fail(ctx, ids, "Payload too large")
        }
    }

    private const val TAG = "LinkSender"
}
