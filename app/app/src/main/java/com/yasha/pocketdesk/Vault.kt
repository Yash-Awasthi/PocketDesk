package com.yasha.pocketdesk

import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Secrets at rest (PC tokens, the iroh key) sealed with AES-GCM under a key that never leaves the Android Keystore. */
object Vault {
    private const val ALIAS = "pocketdesk-vault"
    private const val SUFFIX = ".sealed"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build())
        }.generateKey()
    }

    private fun seal(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return Base64.getEncoder().encodeToString(c.iv + c.doFinal(plain.toByteArray()))
    }

    private fun open(sealed: String): String? = runCatching {
        val b = Base64.getDecoder().decode(sealed)
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, b, 0, 12)) }
        String(c.doFinal(b, 12, b.size - 12))
    }.getOrNull()

    /** The secret saved under [name]; a value from before the vault is sealed on the way out. */
    fun get(prefs: SharedPreferences, name: String): String? {
        prefs.getString(name + SUFFIX, null)?.let { return open(it) }
        return prefs.getString(name, null)?.also { put(prefs, name, it) }
    }

    fun put(prefs: SharedPreferences, name: String, value: String) {
        prefs.edit().putString(name + SUFFIX, seal(value)).remove(name).apply()
    }
}
