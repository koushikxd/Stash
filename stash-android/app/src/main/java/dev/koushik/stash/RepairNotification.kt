package dev.koushik.stash

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

object RepairNotification {
    private const val CHANNEL_ID = "repair"
    private const val NOTIFICATION_ID = 401

    fun createChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, ctx.getString(R.string.repair_channel_name), NotificationManager.IMPORTANCE_DEFAULT)
        )
    }

    fun show(ctx: Context) {
        createChannel(ctx)
        val intent = Intent(ctx, PairActivity::class.java)
            .putExtra(PairActivity.EXTRA_REASON, PairActivity.REASON_UNAUTHORIZED)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pi = PendingIntent.getActivity(
            ctx,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_stash)
            .setContentTitle(ctx.getString(R.string.repair_title))
            .setContentText(ctx.getString(R.string.repair_body))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
    }
}
