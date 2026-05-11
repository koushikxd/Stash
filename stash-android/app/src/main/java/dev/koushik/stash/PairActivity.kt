package dev.koushik.stash

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import dev.koushik.stash.data.Secret
import dev.koushik.stash.net.NsdHelper
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

class PairActivity : AppCompatActivity() {

    private val mainHandler = Handler(Looper.getMainLooper())

    private val pingClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(800, TimeUnit.MILLISECONDS)
            .readTimeout(800, TimeUnit.MILLISECONDS)
            .writeTimeout(800, TimeUnit.MILLISECONDS)
            .build()
    }

    private lateinit var status: TextView
    private lateinit var banner: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pair)
        requestNotificationPermission()

        val hostInput = findViewById<EditText>(R.id.hostInput)
        val portInput = findViewById<EditText>(R.id.portInput)
        val secretInput = findViewById<EditText>(R.id.secretInput)
        val saveButton = findViewById<Button>(R.id.saveButton)
        val discoverButton = findViewById<Button>(R.id.discoverButton)
        status = findViewById(R.id.statusText)
        banner = findViewById(R.id.unauthorizedBanner)

        val unauthorized = intent?.getStringExtra(EXTRA_REASON) == REASON_UNAUTHORIZED
        if (unauthorized) {
            banner.visibility = View.VISIBLE
        }

        Secret.getHost(this)?.let { hostInput.setText(it) }
        portInput.setText(Secret.getPort(this).toString())
        Secret.getSecret(this)?.let { secretInput.setText(it) }
        renderPairedState(unauthorized)

        discoverButton.setOnClickListener {
            status.setText(R.string.pair_status_discovering)
            val appCtx = applicationContext
            Thread({
                val helper = NsdHelper(appCtx)
                val resolved = try { helper.findMac(4000) } finally { helper.shutdown() }
                mainHandler.post {
                    if (resolved == null) {
                        status.setText(R.string.pair_status_not_found)
                    } else if (resolved.secret.isNullOrBlank()) {
                        hostInput.setText(resolved.host)
                        portInput.setText(resolved.port.toString())
                        status.setText(R.string.pair_status_secret_missing)
                    } else {
                        hostInput.setText(resolved.host)
                        portInput.setText(resolved.port.toString())
                        secretInput.setText(resolved.secret)
                        status.setText(R.string.pair_status_verifying)
                        verifyAndSave(appCtx, resolved.host, resolved.port, resolved.secret)
                    }
                }
            }, "stash-pair-discover").start()
        }

        saveButton.setOnClickListener {
            val host = hostInput.text.toString().trim()
            val port = portInput.text.toString().trim().toIntOrNull() ?: 0
            val secret = secretInput.text.toString().trim()
            if (host.isEmpty() || port !in 1..65535 || secret.length < 8) {
                status.text = "Fix host / port (1-65535) / secret (≥8 chars)"
                return@setOnClickListener
            }
            status.setText(R.string.pair_status_verifying)
            verifyAndSave(applicationContext, host, port, secret)
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 12)
    }

    private fun renderPairedState(unauthorized: Boolean) {
        val paired = Secret.isPaired(this)
        if (paired && !unauthorized) status.setText(R.string.pair_already)
        else if (!paired) status.setText(R.string.pair_status_idle)
    }

    private fun verifyAndSave(ctx: android.content.Context, host: String, port: Int, secret: String) {
        Thread({
            val ok = ping(host, port, secret)
            if (ok) Secret.save(ctx, host, port, secret)
            mainHandler.post {
                status.setText(if (ok) R.string.pair_status_saved else R.string.pair_status_unreachable)
                renderPairedState(false)
            }
        }, "stash-pair-ping").start()
    }

    private fun ping(host: String, port: Int, secret: String): Boolean {
        val req = Request.Builder()
            .url("http://$host:$port/ping")
            .header("Authorization", "Bearer $secret")
            .get()
            .build()
        return try {
            pingClient.newCall(req).execute().use { it.isSuccessful }
        } catch (_: IOException) {
            false
        }
    }

    companion object {
        const val EXTRA_REASON = "reason"
        const val REASON_UNAUTHORIZED = "unauthorized"
    }
}
