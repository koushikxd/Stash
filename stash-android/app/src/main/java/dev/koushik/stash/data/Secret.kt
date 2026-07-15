package dev.koushik.stash.data

import dev.koushik.stash.BuildConfig

/**
 * The shared identity secret baked into both apps. There is no pairing: both apps
 * carry the same [secret] at build time, and it is stretched (via `util/Crypto`)
 * into the AES-256 key and the unguessable ntfy topic names — so only a device with
 * this secret can publish to, read from, or decrypt the relay. "It knows it's me"
 * is intrinsic. The secret is a compile-time constant and is never persisted.
 */
object Secret {

    fun secret(): String = BuildConfig.STASH_SECRET
}
