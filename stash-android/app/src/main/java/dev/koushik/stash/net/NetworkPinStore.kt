package dev.koushik.stash.net

import android.content.Context
import android.net.ConnectivityManager
import android.util.Log
import java.net.Inet4Address

/**
 * Remembers the last address the Mac was successfully reached at, keyed by the
 * *current network's subnet*. This is the fallback for routers that block mDNS
 * multicast: once we've delivered to the Mac on a given Wi-Fi, we can dial that
 * same IP directly on the next visit even if discovery turns up nothing.
 *
 * The subnet key is derived from [android.net.LinkProperties] (gateway/prefix),
 * which needs no location permission — unlike reading the Wi-Fi SSID on API 29+.
 */
object NetworkPinStore {

    private const val PREFS_FILE = "stash-pins.prefs"
    private const val TAG = "NetworkPinStore"

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)

    /** Record that [host]:[port] worked on the network we're currently on. */
    fun put(ctx: Context, host: String, port: Int) {
        val key = networkKey(ctx) ?: return
        prefs(ctx).edit().putString(key, "$host:$port").apply()
    }

    /** The last-good host:port for the network we're currently on, if any. */
    fun get(ctx: Context): Pair<String, Int>? {
        val key = networkKey(ctx) ?: return null
        val raw = prefs(ctx).getString(key, null) ?: return null
        val host = raw.substringBeforeLast(':').takeIf { it.isNotBlank() } ?: return null
        val port = raw.substringAfterLast(':').toIntOrNull() ?: return null
        return host to port
    }

    /**
     * A stable identifier for the LAN we're on, from the active network's first
     * IPv4 subnet (e.g. "v4:192.168.1.0/24"). Falls back to the interface name.
     */
    private fun networkKey(ctx: Context): String? {
        return try {
            val cm = ctx.applicationContext
                .getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null
            val net = cm.activeNetwork ?: return null
            val lp = cm.getLinkProperties(net) ?: return null
            for (la in lp.linkAddresses) {
                val addr = la.address
                if (addr is Inet4Address) {
                    val subnet = maskedSubnet(addr.address, la.prefixLength) ?: continue
                    return "v4:$subnet/${la.prefixLength}"
                }
            }
            lp.interfaceName?.let { "if:$it" }
        } catch (t: Throwable) {
            Log.w(TAG, "networkKey failed", t)
            null
        }
    }

    /** Applies a CIDR prefix mask to 4 address bytes, returning a dotted-quad. */
    private fun maskedSubnet(bytes: ByteArray, prefixLen: Int): String? {
        if (bytes.size != 4) return null
        val masked = ByteArray(4)
        for (i in 0 until 4) {
            val bitsInByte = (prefixLen - i * 8).coerceIn(0, 8)
            val mask = if (bitsInByte == 0) 0 else (0xFF shl (8 - bitsInByte)) and 0xFF
            masked[i] = (bytes[i].toInt() and mask).toByte()
        }
        return masked.joinToString(".") { (it.toInt() and 0xFF).toString() }
    }
}
