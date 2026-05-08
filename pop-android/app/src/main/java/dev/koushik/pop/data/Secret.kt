package dev.koushik.pop.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

object Secret {

    private const val PREFS_FILE = "pop-secret.prefs"
    private const val KEY_SECRET = "secret"
    private const val KEY_HOST = "host"
    private const val KEY_PORT = "port"
    private const val DEFAULT_PORT = 7891

    @Volatile
    private var prefs: SharedPreferences? = null

    private fun prefs(ctx: Context): SharedPreferences {
        prefs?.let { return it }
        synchronized(this) {
            prefs?.let { return it }
            val masterKey = MasterKey.Builder(ctx.applicationContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            val p = EncryptedSharedPreferences.create(
                ctx.applicationContext,
                PREFS_FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
            prefs = p
            return p
        }
    }

    fun save(ctx: Context, host: String, port: Int, secret: String) {
        prefs(ctx).edit()
            .putString(KEY_HOST, host)
            .putInt(KEY_PORT, port)
            .putString(KEY_SECRET, secret)
            .apply()
    }

    fun saveHostPort(ctx: Context, host: String, port: Int) {
        prefs(ctx).edit()
            .putString(KEY_HOST, host)
            .putInt(KEY_PORT, port)
            .apply()
    }

    fun getSecret(ctx: Context): String? = prefs(ctx).getString(KEY_SECRET, null)
    fun getHost(ctx: Context): String? = prefs(ctx).getString(KEY_HOST, null)
    fun getPort(ctx: Context): Int = prefs(ctx).getInt(KEY_PORT, DEFAULT_PORT)
    fun isPaired(ctx: Context): Boolean = !getSecret(ctx).isNullOrBlank()

    fun clear(ctx: Context) {
        prefs(ctx).edit().clear().apply()
    }
}
