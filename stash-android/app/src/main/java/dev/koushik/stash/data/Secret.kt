package dev.koushik.stash.data

import android.content.Context
import android.content.SharedPreferences
import dev.koushik.stash.BuildConfig

/**
 * The Mac's last-known address on the LAN, plus the shared identity secret.
 *
 * There is no pairing any more: both apps bake in the same [secret] at build time
 * and the Mac validates the `Authorization: Bearer` token against it, so "it knows
 * it's me" is intrinsic. This object only *caches* where the Mac was last reached
 * so the happy path can skip discovery; the secret itself is a compile-time
 * constant ([BuildConfig.STASH_SECRET]) and is never persisted.
 */
object Secret {

    private const val PREFS_FILE = "stash-endpoint.prefs"
    private const val KEY_HOST = "host"
    private const val KEY_PORT = "port"
    private const val KEY_HOSTNAME = "hostname"
    private const val DEFAULT_PORT = 7891

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.applicationContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)

    /** The shared secret baked into both apps. Always present. */
    fun secret(): String = BuildConfig.STASH_SECRET

    fun saveHostPort(ctx: Context, host: String, port: Int) {
        prefs(ctx).edit().putString(KEY_HOST, host).putInt(KEY_PORT, port).apply()
    }

    fun saveHostname(ctx: Context, hostname: String?) {
        prefs(ctx).edit().apply {
            if (hostname.isNullOrBlank()) remove(KEY_HOSTNAME) else putString(KEY_HOSTNAME, hostname)
        }.apply()
    }

    fun getHost(ctx: Context): String? = prefs(ctx).getString(KEY_HOST, null)
    fun getPort(ctx: Context): Int = prefs(ctx).getInt(KEY_PORT, DEFAULT_PORT)
    fun getHostname(ctx: Context): String? = prefs(ctx).getString(KEY_HOSTNAME, null)
}
