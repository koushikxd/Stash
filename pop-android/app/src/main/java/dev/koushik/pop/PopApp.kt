package dev.koushik.pop

import android.app.Application
import dev.koushik.pop.net.ConnectivityWatcher

class PopApp : Application() {

    private lateinit var connectivityWatcher: ConnectivityWatcher

    override fun onCreate() {
        super.onCreate()
        RepairNotification.createChannel(this)
        connectivityWatcher = ConnectivityWatcher(this)
        connectivityWatcher.start()
    }
}
