package dev.koushik.stash.net

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.koushik.stash.data.QueueManager

class FlushQueueWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        if (QueueManager.isEmpty(applicationContext)) return Result.success()
        val helper = NsdHelper(applicationContext)
        val result = try {
            LinkSender.flushQueue(applicationContext, helper)
        } finally {
            helper.shutdown()
        }
        return when (result) {
            is LinkSender.FlushResult.Empty,
            is LinkSender.FlushResult.Flushed,
            is LinkSender.FlushResult.NotPaired,
            is LinkSender.FlushResult.Unauthorized -> Result.success()
            is LinkSender.FlushResult.NoMacFound,
            is LinkSender.FlushResult.Failed -> Result.retry()
        }
    }

    companion object {
        private const val UNIQUE_WORK_NAME = "stash-flush-queue"

        fun schedule(ctx: Context) {
            val request = OneTimeWorkRequestBuilder<FlushQueueWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .build()
            WorkManager.getInstance(ctx.applicationContext).enqueueUniqueWork(
                UNIQUE_WORK_NAME,
                ExistingWorkPolicy.REPLACE,
                request
            )
        }
    }
}
