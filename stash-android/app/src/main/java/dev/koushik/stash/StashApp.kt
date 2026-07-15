package dev.koushik.stash

import android.app.Application
import dev.koushik.stash.net.ConnectivityWatcher
import dev.koushik.stash.net.FlushQueueWorker

class StashApp : Application() {

    private lateinit var connectivityWatcher: ConnectivityWatcher

    override fun onCreate() {
        super.onCreate()
        StuckNotification.createChannel(this)
        connectivityWatcher = ConnectivityWatcher(this)
        connectivityWatcher.start()
        FlushQueueWorker.schedulePeriodic(this)
    }
}
