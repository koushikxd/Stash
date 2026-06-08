package dev.koushik.stash.util

import kotlin.math.min
import kotlin.math.pow

/**
 * Exponential backoff with full jitter, used when retrying a queued link send.
 * The schedule is deterministic given a seed so it can be exercised in tests.
 */
class Backoff(
    private val baseMillis: Long = 500L,
    private val maxMillis: Long = 60_000L,
    private val factor: Double = 2.0,
    private val maxAttempts: Int = 8,
) {

    init {
        require(baseMillis > 0) { "baseMillis must be positive" }
        require(maxMillis >= baseMillis) { "maxMillis must be >= baseMillis" }
        require(factor > 1.0) { "factor must be greater than 1" }
    }

    /** Upper bound (before jitter) for the delay after [attempt] failures. */
    fun ceilingFor(attempt: Int): Long {
        val raw = baseMillis * factor.pow(attempt.coerceAtLeast(0))
        return min(raw, maxMillis.toDouble()).toLong()
    }

    /**
     * Delay for [attempt] using full jitter. [random] is a value in [0,1) and is
     * injectable so callers can make the schedule reproducible.
     */
    fun delayFor(attempt: Int, random: Double): Long {
        val ceiling = ceilingFor(attempt)
        val clamped = random.coerceIn(0.0, 1.0)
        return (ceiling * clamped).toLong()
    }

    fun shouldRetry(attempt: Int): Boolean = attempt < maxAttempts

    /** Materializes the full ceiling schedule, handy for logging or debugging. */
    fun schedule(): List<Long> = (0 until maxAttempts).map { ceilingFor(it) }
}
