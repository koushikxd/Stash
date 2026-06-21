package dev.koushik.stash.net

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.koushik.stash.StuckNotification
import dev.koushik.stash.data.RecordStore
import java.util.concurrent.TimeUnit

/**
 * Background flush of the pending queue. Runs on *any* connected network (the old
 * UNMETERED constraint was the headline bug — queued links could never flush on
 * mobile data) and retries with exponential backoff. Also expires links that have
 * sat pending past the retention window, and raises a "stuck" notification when a
 * link has exhausted its attempts.
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

        val helper = NsdHelper(applicationContext)
        Log.d(TAG, "flush start: worker")
        val result = try {
            LinkSender.flushQueue(applicationContext, helper)
        } finally {
            helper.shutdown()
        }
        Log.d(TAG, "flush result: $result")

        if (RecordStore.hasExhausted(applicationContext)) {
            StuckNotification.show(applicationContext)
        }

        return when (result) {
            is LinkSender.FlushResult.Empty,
            is LinkSender.FlushResult.Flushed -> Result.success()
            is LinkSender.FlushResult.Unauthorized,
            is LinkSender.FlushResult.NoMacFound,
            is LinkSender.FlushResult.Failed -> Result.retry()
        }
    }

    companion object {
        private const val TAG = "FlushQueueWorker"
        private const val UNIQUE_WORK_NAME = "stash-flush-queue"

        /** Pending links older than this become EXPIRED instead of retrying forever. */
        const val RETENTION_MS = 7L * 24 * 60 * 60 * 1000

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
    }
}
