package dev.koushik.pop

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import dev.koushik.pop.data.Secret
import dev.koushik.pop.net.LinkSender
import dev.koushik.pop.net.NsdHelper

class ShareActivity : Activity() {

    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!Secret.isPaired(this)) {
            toast(R.string.toast_not_paired)
            startActivity(Intent(this, PairActivity::class.java))
            finish()
            return
        }

        val raw = intent?.getStringExtra(Intent.EXTRA_TEXT)?.trim()
        val url = raw?.let { extractFirstUrl(it) }
        if (url == null) {
            toast(R.string.toast_not_a_link)
            finish()
            return
        }

        val appCtx = applicationContext
        Thread({
            val helper = NsdHelper(appCtx)
            val result = try {
                LinkSender.send(appCtx, url, helper)
            } finally {
                helper.shutdown()
            }
            mainHandler.post {
                toast(toastFor(result))
                finish()
            }
        }, "pop-share-send").start()
    }

    private fun toastFor(r: LinkSender.Result): Int = when (r) {
        is LinkSender.Result.Sent -> R.string.toast_sent
        is LinkSender.Result.NotPaired -> R.string.toast_not_paired
        is LinkSender.Result.Unauthorized -> R.string.toast_unauthorized
        is LinkSender.Result.NoMacFound -> R.string.toast_no_mac
        is LinkSender.Result.NetworkError -> R.string.toast_offline
    }

    private fun toast(resId: Int) {
        Toast.makeText(applicationContext, resId, Toast.LENGTH_SHORT).show()
    }

    private fun extractFirstUrl(text: String): String? {
        // Common case: the share extra is just the URL.
        if (looksLikeHttpUrl(text)) return text
        // Fallback: find first http(s) token in mixed text (e.g. "Look: https://x.com")
        return text.split(Regex("\\s+")).firstOrNull { looksLikeHttpUrl(it) }
    }

    private fun looksLikeHttpUrl(s: String): Boolean {
        if (s.length < 8 || s.length > 4096) return false
        if (!s.startsWith("http://") && !s.startsWith("https://")) return false
        return try {
            java.net.URI(s).host?.isNotBlank() == true
        } catch (_: Exception) { false }
    }
}
