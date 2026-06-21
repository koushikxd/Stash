package dev.koushik.stash

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * Raised when a link can't be delivered after all its retry attempts. Tapping it
 * opens the Links screen so the failure is visible and retryable — never silent.
 */
object StuckNotification {
    private const val CHANNEL_ID = "delivery"
    private const val NOTIFICATION_ID = 402

    fun createChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                ctx.getString(R.string.stuck_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT
            )
        )
    }

    fun show(ctx: Context) {
        createChannel(ctx)
        val intent = Intent(ctx, LinksActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pi = PendingIntent.getActivity(
            ctx,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_stash)
            .setContentTitle(ctx.getString(R.string.stuck_title))
            .setContentText(ctx.getString(R.string.stuck_body))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
    }
}
