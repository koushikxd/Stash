package dev.koushik.stash.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Network
import android.util.Log
import dev.koushik.stash.data.RecordStore
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Flushes the pending queue whenever the device regains internet. Delivery now goes
 * through the relay, so *any* internet-capable network (Wi-Fi or mobile data) can
 * deliver — hence NET_CAPABILITY_INTERNET rather than the old Wi-Fi-only filter.
 */
class ConnectivityWatcher(private val ctx: Context) {

    private val appCtx = ctx.applicationContext
    private val cm = appCtx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val executor = Executors.newSingleThreadExecutor()
    private val flushing = AtomicBoolean(false)

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            flushAsync("network available")
        }

        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
                flushAsync("internet capability changed")
            }
        }
    }

    fun start() {
        try {
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            cm.registerNetworkCallback(request, callback)
        } catch (t: Throwable) {
            Log.w(TAG, "network callback registration failed", t)
        }
        flushAsync("app start")
        FlushQueueWorker.schedule(appCtx)
    }

    private fun flushAsync(reason: String) {
        RecordStore.expireOlderThan(appCtx, FlushQueueWorker.RETENTION_MS)
        if (RecordStore.isPendingEmpty(appCtx)) return
        if (!flushing.compareAndSet(false, true)) {
            Log.d(TAG, "flush already running: $reason")
            return
        }
        executor.execute {
            try {
                Log.d(TAG, "flush start: $reason")
                val result = LinkSender.flushQueue(appCtx)
                Log.d(TAG, "flush result: $result")
            } finally {
                flushing.set(false)
            }
        }
    }

    companion object {
        private const val TAG = "ConnectivityWatcher"
    }
}
