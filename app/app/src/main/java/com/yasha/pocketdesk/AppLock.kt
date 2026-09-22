package com.yasha.pocketdesk

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.hardware.biometrics.BiometricManager.Authenticators
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts

/**
 * Biometric / device-credential gate in front of the app. Re-locks after the app
 * has been in the background for [GRACE_MS]; never locks when no screen lock is set.
 */
class AppLock(private val activity: ComponentActivity, private val onUnlocked: () -> Unit) {

    private val prefs = activity.getSharedPreferences("pocketdesk", Context.MODE_PRIVATE)
    private val keyguard = activity.getSystemService(KeyguardManager::class.java)
    private val legacy: ActivityResultLauncher<android.content.Intent> =
        activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            if (it.resultCode == Activity.RESULT_OK) onUnlocked()
        }

    var enabled: Boolean
        get() = prefs.getBoolean("lock", false)
        set(v) = prefs.edit().putBoolean("lock", v).apply()

    val available: Boolean get() = keyguard.isDeviceSecure

    fun onStop() { stoppedAt = System.currentTimeMillis() }

    /** True when the UI must stay hidden until [prompt] succeeds. */
    fun shouldLock(): Boolean =
        enabled && available && (stoppedAt == 0L || System.currentTimeMillis() - stoppedAt > GRACE_MS)

    fun prompt() {
        if (Build.VERSION.SDK_INT >= 30) {
            BiometricPrompt.Builder(activity)
                .setTitle("Unlock PocketDesk")
                .setAllowedAuthenticators(Authenticators.BIOMETRIC_WEAK or Authenticators.DEVICE_CREDENTIAL)
                .build()
                .authenticate(CancellationSignal(), activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onUnlocked()
                })
        } else {
            @Suppress("DEPRECATION")
            keyguard.createConfirmDeviceCredentialIntent("Unlock PocketDesk", null)?.let { legacy.launch(it) }
                ?: onUnlocked()
        }
    }

    companion object {
        private const val GRACE_MS = 30_000L
        // Process-lived so a rotation (stop, then a fresh activity) does not re-lock.
        private var stoppedAt = 0L
    }
}
