package dev.koushik.stash

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import dev.koushik.stash.data.Secret
import dev.koushik.stash.net.LinkSender
import dev.koushik.stash.net.NsdHelper

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

        val text = intent?.getStringExtra(Intent.EXTRA_TEXT)?.trim()
        if (text.isNullOrBlank()) {
            toast(R.string.toast_not_text)
            finish()
            return
        }
        val url = extractFirstUrl(text)

        val appCtx = applicationContext
        Thread({
            val helper = NsdHelper(appCtx)
            val result = try {
                LinkSender.send(appCtx, text, url, helper)
            } finally {
                helper.shutdown()
            }
            mainHandler.post {
                if (result is LinkSender.Result.Unauthorized) {
                    RepairNotification.show(applicationContext)
                    val intent = Intent(this, PairActivity::class.java)
                        .putExtra(PairActivity.EXTRA_REASON, PairActivity.REASON_UNAUTHORIZED)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(intent)
                } else {
                    toast(toastFor(result))
                }
                finish()
            }
        }, "stash-share-send").start()
    }

    private fun toastFor(r: LinkSender.Result): Int = when (r) {
        is LinkSender.Result.Sent -> R.string.toast_sent
        is LinkSender.Result.Queued -> R.string.toast_queued
        is LinkSender.Result.NotPaired -> R.string.toast_not_paired
        is LinkSender.Result.Unauthorized -> R.string.toast_unauthorized
        is LinkSender.Result.NoMacFound -> R.string.toast_no_mac
        is LinkSender.Result.NetworkError -> R.string.toast_offline
    }

    private fun toast(resId: Int) {
        Toast.makeText(applicationContext, resId, Toast.LENGTH_SHORT).show()
    }

    private fun extractFirstUrl(text: String): String? {
        if (looksLikeHttpUrl(text)) return text
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
