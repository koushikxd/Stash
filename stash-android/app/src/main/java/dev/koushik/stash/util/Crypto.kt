package dev.koushik.stash.util

import android.util.Base64
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * End-to-end encryption for the ntfy relay. The shared secret both apps bake in is
 * stretched into a symmetric AES-256 key and into the (unguessable) topic names, so
 * only a device holding the secret can publish to, read from, or decrypt the relay.
 *
 * Wire format of an encrypted body: base64(IV(12) || ciphertext || GCM tag(16)),
 * standard Base64 with no line wrapping. Decrypt returns null on any failure — the
 * receiver silently drops anything it can't authenticate.
 */
object Crypto {

    private const val IV_BYTES = 12
    private const val TAG_BITS = 128
    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    private val random = SecureRandom()

    fun sha256(input: String): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))

    fun key(secret: String): SecretKeySpec =
        SecretKeySpec(sha256("key:$secret"), "AES")

    /** An unguessable ntfy topic derived from the secret: "st-" + 32 hex chars. */
    fun topic(label: String, secret: String): String =
        "st-" + HexCodec.encode(sha256("topic:$label:$secret")).substring(0, 32)

    fun encrypt(key: SecretKeySpec, plaintext: String): String {
        val iv = ByteArray(IV_BYTES).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
        val ct = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(iv + ct, Base64.NO_WRAP)
    }

    fun decrypt(key: SecretKeySpec, body: String): String? = try {
        val raw = Base64.decode(body.trim(), Base64.DEFAULT)
        require(raw.size > IV_BYTES)
        val iv = raw.copyOfRange(0, IV_BYTES)
        val ct = raw.copyOfRange(IV_BYTES, raw.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
        String(cipher.doFinal(ct), Charsets.UTF_8)
    } catch (_: Throwable) {
        null
    }
}
