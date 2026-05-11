package dev.koushik.stash

import android.app.Application
import dev.koushik.stash.net.ConnectivityWatcher

class StashApp : Application() {

    private lateinit var connectivityWatcher: ConnectivityWatcher

    override fun onCreate() {
        super.onCreate()
        RepairNotification.createChannel(this)
        connectivityWatcher = ConnectivityWatcher(this)
        connectivityWatcher.start()
    }
}
