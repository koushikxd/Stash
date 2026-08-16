package dev.koushik.stash

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import dev.koushik.stash.net.LinkSender
import dev.koushik.stash.util.PayloadValidator

/**
 * Invisible activity behind the system share sheet. It classifies the shared
 * text, persists it (write-ahead) and kicks off delivery, then toasts the outcome
 * and finishes. There is no pairing step: identity is the baked-in shared secret.
 */
class ShareActivity : Activity() {

    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val raw = intent?.getStringExtra(Intent.EXTRA_TEXT)
        val (text, url) = when (val verdict = PayloadValidator.classify(raw)) {
            is PayloadValidator.Verdict.Url -> verdict.normalized to verdict.normalized
            is PayloadValidator.Verdict.Text -> verdict.cleaned to PayloadValidator.firstUrlIn(verdict.cleaned)
            is PayloadValidator.Verdict.Rejected -> {
                toast(R.string.toast_not_text)
                finish()
                return
            }
        }

        val appCtx = applicationContext
        Thread({
            val result = LinkSender.send(appCtx, text, url)
            mainHandler.post {
                toast(toastFor(result))
                finish()
            }
        }, "stash-share-send").start()
    }

    private fun toastFor(r: LinkSender.Result): Int = when (r) {
        is LinkSender.Result.Sent -> R.string.toast_sent
        is LinkSender.Result.Queued -> R.string.toast_queued
        is LinkSender.Result.TooLarge -> R.string.toast_too_large
    }

    private fun toast(resId: Int) {
        Toast.makeText(applicationContext, resId, Toast.LENGTH_SHORT).show()
    }
}
