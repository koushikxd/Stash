package dev.koushik.stash.net

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.koushik.stash.StuckNotification
import dev.koushik.stash.data.RecordStore
import java.util.concurrent.TimeUnit

/**
 * Background flush of the pending queue over the relay. Runs on *any* connected
 * network and retries with exponential backoff. Two schedules use this one worker:
 *
 *  - a one-time expedited request kicked off on reconnect / share (fast delivery),
 *  - a 15-minute periodic sweep, so a record queued while offline still goes out
 *    even if the phone never reconnects in a way the watcher sees.
 *
 * Only a publish failure (offline) retries. It also expires links past the retention
 * window and raises a "stuck" notification when a record has exhausted its attempts.
 */
class FlushQueueWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val expired = RecordStore.expireOlderThan(applicationContext, RETENTION_MS)
        if (expired > 0) Log.d(TAG, "expired $expired stale pending link(s)")

        if (RecordStore.isPendingEmpty(applicationContext)) {
            Log.d(TAG, "flush skipped: nothing pending")
            return Result.success()
        }

        Log.d(TAG, "flush start: worker")
        val result = LinkSender.flushQueue(applicationContext)
        Log.d(TAG, "flush result: $result")

        if (RecordStore.hasExhausted(applicationContext)) {
            StuckNotification.show(applicationContext)
        }

        return when (result) {
            is LinkSender.FlushResult.Empty,
            is LinkSender.FlushResult.Flushed -> Result.success()
            is LinkSender.FlushResult.Failed -> Result.retry()
        }
    }

    companion object {
        private const val TAG = "FlushQueueWorker"
        private const val UNIQUE_WORK_NAME = "stash-flush-queue"
        private const val PERIODIC_WORK_NAME = "stash-flush-periodic"
        private const val LEGACY_PERIODIC_WORK_NAME = "stash-ack-poll"

        /** Pending links older than this become EXPIRED instead of retrying forever. */
        const val RETENTION_MS = 30L * 24 * 60 * 60 * 1000

        fun schedule(ctx: Context) {
            val request = OneTimeWorkRequestBuilder<FlushQueueWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                // Non-expedited fallback avoids exhausting the expedited quota, since
                // ConnectivityWatcher schedules this on every reconnect.
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(ctx.applicationContext).enqueueUniqueWork(
                UNIQUE_WORK_NAME,
                ExistingWorkPolicy.REPLACE,
                request
            )
        }

        /** Sweep the pending queue every 15 minutes as a safety net. */
        fun schedulePeriodic(ctx: Context) {
            // A periodic unique work request outlives the install that created it.
            WorkManager.getInstance(ctx.applicationContext)
                .cancelUniqueWork(LEGACY_PERIODIC_WORK_NAME)
            val request = PeriodicWorkRequestBuilder<FlushQueueWorker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(ctx.applicationContext).enqueueUniquePeriodicWork(
                PERIODIC_WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )
        }
    }
}
