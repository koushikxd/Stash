package dev.koushik.stash.data

import android.content.Context

/**
 * Tracks how far the phone has read the Mac's ack topic. We store the ntfy *message
 * id* of the last ack we processed and poll with `since=<id>`, so there are no wall
 * clocks and no skew — ntfy replays exactly the acks we haven't seen. Defaults to
 * "all" on first run to catch up on anything still in the relay's 12h cache.
 */
object RelayState {

    private const val PREFS_FILE = "stash-relay.prefs"
    private const val KEY_ACK_SINCE = "ack_since"
    private const val DEFAULT_SINCE = "all"

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)

    fun getAckSince(ctx: Context): String =
        prefs(ctx).getString(KEY_ACK_SINCE, DEFAULT_SINCE) ?: DEFAULT_SINCE

    fun setAckSince(ctx: Context, ntfyMessageId: String) {
        prefs(ctx).edit().putString(KEY_ACK_SINCE, ntfyMessageId).apply()
    }
}
