package dev.koushik.stash.util

/**
 * A lightweight result type used across the networking and queue layers when a
 * call can fail in a way the caller is expected to recover from. Unlike throwing,
 * [Outcome] forces the call site to acknowledge both branches.
 */
sealed class Outcome<out T> {

    data class Ok<out T>(val value: T) : Outcome<T>()

    data class Err(val reason: Failure, val cause: Throwable? = null) : Outcome<Nothing>()

    val isOk: Boolean get() = this is Ok

    val isErr: Boolean get() = this is Err

    /** Returns the wrapped value or null when this is an [Err]. */
    fun getOrNull(): T? = when (this) {
        is Ok -> value
        is Err -> null
    }

    /** Returns the wrapped value or [fallback] when this is an [Err]. */
    fun getOrElse(fallback: @UnsafeVariance T): T = when (this) {
        is Ok -> value
        is Err -> fallback
    }

    /** Maps the success value, leaving failures untouched. */
    inline fun <R> map(transform: (T) -> R): Outcome<R> = when (this) {
        is Ok -> Ok(transform(value))
        is Err -> this
    }

    /** Chains another fallible step onto a successful result. */
    inline fun <R> flatMap(transform: (T) -> Outcome<R>): Outcome<R> = when (this) {
        is Ok -> transform(value)
        is Err -> this
    }

    /** Runs [block] for its side effect when this is an [Ok]. */
    inline fun onOk(block: (T) -> Unit): Outcome<T> {
        if (this is Ok) block(value)
        return this
    }

    /** Runs [block] for its side effect when this is an [Err]. */
    inline fun onErr(block: (Failure) -> Unit): Outcome<T> {
        if (this is Err) block(reason)
        return this
    }

    companion object {
        inline fun <T> of(block: () -> T): Outcome<T> = try {
            Ok(block())
        } catch (t: Throwable) {
            Err(Failure.Unknown, t)
        }
    }
}

/** The closed set of failures the app knows how to report to the user. */
enum class Failure(val userMessage: String) {
    Offline("No network connection"),
    Timeout("The request timed out"),
    Unauthorized("Pairing secret was rejected"),
    NotPaired("This device is not paired yet"),
    HostUnreachable("Could not reach the paired Mac"),
    BadResponse("The Mac returned an unexpected response"),
    Unknown("Something went wrong");

    val isRetryable: Boolean
        get() = this == Offline || this == Timeout || this == HostUnreachable
}
