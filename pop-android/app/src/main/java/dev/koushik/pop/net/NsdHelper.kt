package dev.koushik.pop.net

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import java.util.ArrayDeque
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Wraps NsdManager. Discoveries are started, then resolves are serialised on a
 * single worker Handler so we never call resolveService() while another resolve
 * is in flight (the "already active" race in DEEP-RESEARCH §6.2).
 */
class NsdHelper(context: Context) {

    private val appCtx = context.applicationContext
    private val nsd = appCtx.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val workerThread = HandlerThread("pop-nsd").also { it.start() }
    private val handler = Handler(workerThread.looper)

    /** Blocks the calling thread until first successful resolve or timeout. */
    fun findMac(timeoutMs: Long = 3000, expectedServiceName: String? = null): Pair<String, Int>? {
        val pending = ArrayDeque<NsdServiceInfo>()
        val pendingLock = Any()
        val resolving = AtomicBoolean(false)
        val done = AtomicBoolean(false)
        val resultQueue = LinkedBlockingQueue<Pair<String, Int>>(1)

        fun scheduleDrain(): Unit = run {
            handler.post {
                if (done.get()) return@post
                if (!resolving.compareAndSet(false, true)) return@post
                val next = synchronized(pendingLock) {
                    if (pending.isEmpty()) null else pending.pollFirst()
                }
                if (next == null) {
                    resolving.set(false)
                    return@post
                }
                val resolveListener = object : NsdManager.ResolveListener {
                    override fun onResolveFailed(info: NsdServiceInfo?, errorCode: Int) {
                        Log.w(TAG, "resolve failed: $errorCode for ${info?.serviceName}")
                        resolving.set(false)
                        scheduleDrain()
                    }

                    override fun onServiceResolved(info: NsdServiceInfo) {
                        val host = info.host?.hostAddress
                        val port = info.port
                        val txt = info.attributes
                        val versionOk = txt == null || !txt.containsKey("version") ||
                            txt["version"]?.let { String(it) } == "1"
                        resolving.set(false)
                        if (versionOk && host != null && port > 0) {
                            if (done.compareAndSet(false, true)) {
                                resultQueue.offer(host to port)
                                return
                            }
                        }
                        scheduleDrain()
                    }
                }
                try {
                    nsd.resolveService(next, resolveListener)
                } catch (t: Throwable) {
                    Log.w(TAG, "resolveService threw", t)
                    resolving.set(false)
                    scheduleDrain()
                }
            }
        }

        val discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onStartDiscoveryFailed(serviceType: String?, errorCode: Int) {
                Log.w(TAG, "discovery start failed: $errorCode")
                done.set(true)
            }
            override fun onStopDiscoveryFailed(serviceType: String?, errorCode: Int) {}
            override fun onDiscoveryStarted(serviceType: String?) {}
            override fun onDiscoveryStopped(serviceType: String?) {}

            override fun onServiceFound(info: NsdServiceInfo) {
                val name = info.serviceName ?: return
                if (expectedServiceName != null) {
                    if (name != expectedServiceName) return
                } else if (!name.startsWith("pop-")) return
                synchronized(pendingLock) { pending.addLast(info) }
                scheduleDrain()
            }
            override fun onServiceLost(info: NsdServiceInfo?) {}
        }

        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
        } catch (t: Throwable) {
            Log.w(TAG, "discoverServices threw", t)
            return null
        }

        val result = try {
            resultQueue.poll(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            null
        }
        done.set(true)
        try { nsd.stopServiceDiscovery(discoveryListener) } catch (_: Throwable) {}
        return result
    }

    fun shutdown() {
        workerThread.quitSafely()
    }

    companion object {
        private const val TAG = "NsdHelper"
        private const val SERVICE_TYPE = "_pop._tcp."
    }
}
