package dev.koushik.stash.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Network
import android.util.Log
import dev.koushik.stash.data.QueueManager
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class ConnectivityWatcher(private val ctx: Context) {

    private val appCtx = ctx.applicationContext
    private val cm = appCtx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val executor = Executors.newSingleThreadExecutor()
    private val flushing = AtomicBoolean(false)

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            flushAsync("wifi available")
        }

        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                flushAsync("wifi capabilities changed")
            }
        }
    }

    fun start() {
        try {
            val request = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .build()
            cm.registerNetworkCallback(request, callback)
        } catch (t: Throwable) {
            Log.w(TAG, "wifi callback registration failed", t)
        }
        flushAsync("app start")
        FlushQueueWorker.schedule(appCtx)
    }

    private fun flushAsync(reason: String) {
        if (QueueManager.isEmpty(appCtx)) return
        if (!flushing.compareAndSet(false, true)) {
            Log.d(TAG, "flush already running: $reason")
            return
        }
        executor.execute {
            val helper = NsdHelper(appCtx)
            try {
                Log.d(TAG, "flush start: $reason")
                val result = LinkSender.flushQueue(appCtx, helper)
                Log.d(TAG, "flush result: $result")
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
