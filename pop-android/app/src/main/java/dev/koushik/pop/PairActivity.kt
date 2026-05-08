package dev.koushik.pop

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import dev.koushik.pop.data.Secret
import dev.koushik.pop.net.NsdHelper
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pair)

        val hostInput = findViewById<EditText>(R.id.hostInput)
        val portInput = findViewById<EditText>(R.id.portInput)
        val secretInput = findViewById<EditText>(R.id.secretInput)
        val saveButton = findViewById<Button>(R.id.saveButton)
        val discoverButton = findViewById<Button>(R.id.discoverButton)
        val status = findViewById<TextView>(R.id.statusText)

        // Pre-fill with whatever is already saved.
        Secret.getHost(this)?.let { hostInput.setText(it) }
        portInput.setText(Secret.getPort(this).toString())
        Secret.getSecret(this)?.let { secretInput.setText(it) }
        if (Secret.isPaired(this)) {
            status.setText(R.string.pair_status_saved)
        }

        discoverButton.setOnClickListener {
            status.setText(R.string.pair_status_discovering)
            val appCtx = applicationContext
            Thread({
                val helper = NsdHelper(appCtx)
                val resolved = try { helper.findMac(4000) } finally { helper.shutdown() }
                mainHandler.post {
                    if (resolved == null) {
                        status.setText(R.string.pair_status_not_found)
                    } else {
                        hostInput.setText(resolved.first)
                        portInput.setText(resolved.second.toString())
                        status.text = "Found: ${resolved.first}:${resolved.second}"
                    }
                }
            }, "pop-pair-discover").start()
        }

        saveButton.setOnClickListener {
            val host = hostInput.text.toString().trim()
            val port = portInput.text.toString().trim().toIntOrNull() ?: 0
            val secret = secretInput.text.toString().trim()
            if (host.isEmpty() || port !in 1..65535 || secret.length < 8) {
                status.text = "Fix host / port (1-65535) / secret (≥8 chars)"
                return@setOnClickListener
            }
            Secret.save(this, host, port, secret)
            status.setText(R.string.pair_status_saved)

            Thread({
                val ok = ping(host, port, secret)
                mainHandler.post {
                    status.setText(
                        if (ok) R.string.pair_status_saved else R.string.pair_status_unreachable
                    )
                }
            }, "pop-pair-ping").start()
        }
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
}
