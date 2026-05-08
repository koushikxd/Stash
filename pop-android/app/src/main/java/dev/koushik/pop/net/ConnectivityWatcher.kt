package dev.koushik.pop.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import dev.koushik.pop.data.QueueManager
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class ConnectivityWatcher(private val ctx: Context) {

    private val appCtx = ctx.applicationContext
    private val cm = appCtx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val executor = Executors.newSingleThreadExecutor()
    private val flushing = AtomicBoolean(false)

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            flushAsync()
        }
    }

    fun start() {
        try {
            cm.registerDefaultNetworkCallback(callback)
        } catch (t: Throwable) {
            Log.w(TAG, "network callback registration failed", t)
        }
        FlushQueueWorker.schedule(appCtx)
    }

    private fun flushAsync() {
        if (QueueManager.isEmpty(appCtx)) return
        if (!flushing.compareAndSet(false, true)) return
        executor.execute {
            val helper = NsdHelper(appCtx)
            try {
                LinkSender.flushQueue(appCtx, helper)
            } finally {
                helper.shutdown()
                flushing.set(false)
            }
        }
    }

    companion object {
        private const val TAG = "ConnectivityWatcher"
    }
}
