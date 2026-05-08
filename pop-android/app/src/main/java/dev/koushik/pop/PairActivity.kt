package dev.koushik.pop

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import dev.koushik.pop.data.Secret
import dev.koushik.pop.net.NsdHelper
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
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
    private lateinit var rescanButton: Button
    private lateinit var scanButton: Button
    private lateinit var banner: TextView

    private val scanLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val raw = result.data?.getStringExtra(ScanActivity.EXTRA_PAYLOAD)
            if (result.resultCode == RESULT_OK && !raw.isNullOrBlank()) {
                applyQrPayload(raw)
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pair)

        val hostInput = findViewById<EditText>(R.id.hostInput)
        val portInput = findViewById<EditText>(R.id.portInput)
        val secretInput = findViewById<EditText>(R.id.secretInput)
        val saveButton = findViewById<Button>(R.id.saveButton)
        val discoverButton = findViewById<Button>(R.id.discoverButton)
        scanButton = findViewById(R.id.scanButton)
        rescanButton = findViewById(R.id.rescanButton)
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

        scanButton.setOnClickListener { launchScanner() }
        rescanButton.setOnClickListener { launchScanner() }

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
            renderPairedState(false)

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

    private fun launchScanner() {
        banner.visibility = View.GONE
        scanLauncher.launch(Intent(this, ScanActivity::class.java))
    }

    private fun renderPairedState(unauthorized: Boolean) {
        val paired = Secret.isPaired(this)
        if (paired && !unauthorized) {
            status.setText(R.string.pair_already)
            scanButton.visibility = View.GONE
            rescanButton.visibility = View.VISIBLE
        } else {
            scanButton.visibility = View.VISIBLE
            rescanButton.visibility = View.GONE
            if (!paired) status.setText(R.string.pair_status_idle)
        }
    }

    private fun applyQrPayload(raw: String) {
        val parsed = try { JSONObject(raw) } catch (_: Throwable) { null }
        val secret = parsed?.optString("secret")?.takeIf { it.isNotBlank() }
        val port = parsed?.optInt("port", 0) ?: 0
        if (parsed == null || parsed.optInt("v", -1) != 1 || secret == null || port !in 1..65535) {
            status.setText(R.string.pair_status_invalid_qr)
            return
        }
        // Save secret + port immediately. Host will be resolved via NSD on the verify step
        // (and refreshed automatically on every Wi-Fi change in LinkSender).
        Secret.save(this, host = "", port = port, secret = secret)
        banner.visibility = View.GONE
        status.setText(R.string.pair_status_verifying)

        val appCtx = applicationContext
        Thread({
            val helper = NsdHelper(appCtx)
            val resolved = try { helper.findMac(4000) } finally { helper.shutdown() }
            if (resolved == null) {
                mainHandler.post {
                    status.setText(R.string.pair_status_not_found)
                    renderPairedState(false)
                }
                return@Thread
            }
            val (host, resolvedPort) = resolved
            // Trust the QR's port over mDNS port (they should match). Cache the host.
            Secret.saveHostPort(appCtx, host, resolvedPort)
            val ok = ping(host, resolvedPort, secret)
            mainHandler.post {
                status.setText(if (ok) R.string.pair_status_saved else R.string.pair_status_unreachable)
                renderPairedState(false)
            }
        }, "pop-pair-verify").start()
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
