package com.yasha.pocketdesk

import android.app.KeyguardManager
import android.content.Context
import android.hardware.biometrics.BiometricManager.Authenticators
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import androidx.activity.ComponentActivity

/**
 * Biometric / device-credential gate in front of the app. Re-locks after the app
 * has been in the background for [GRACE_MS]; never locks when no screen lock is set.
 */
class AppLock(private val activity: ComponentActivity, private val onUnlocked: () -> Unit) {

    private val prefs = activity.getSharedPreferences("pocketdesk", Context.MODE_PRIVATE)
    private val keyguard = activity.getSystemService(KeyguardManager::class.java)

    var enabled: Boolean
        get() = prefs.getBoolean("lock", false)
        set(v) = prefs.edit().putBoolean("lock", v).apply()

    val available: Boolean get() = keyguard.isDeviceSecure

    // While locked, a stop (rotation) must not open the grace window for the next activity.
    fun onStop() { if (!locked) stoppedAt = System.currentTimeMillis() }

    /** True when the UI must stay hidden until [prompt] succeeds. */
    fun shouldLock(): Boolean {
        locked = decide(enabled, available, locked, stoppedAt, System.currentTimeMillis())
        return locked
    }

    fun unlocked() {
        locked = false
        onUnlocked()
    }

    fun prompt() {
        BiometricPrompt.Builder(activity)
            .setTitle("Unlock PocketDesk")
            .setAllowedAuthenticators(Authenticators.BIOMETRIC_WEAK or Authenticators.DEVICE_CREDENTIAL)
            .build()
            .authenticate(CancellationSignal(), activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = unlocked()
            })
    }

    companion object {
        internal const val GRACE_MS = 30_000L
        // Process-lived so a rotation (stop, then a fresh activity) does not re-lock.
        private var stoppedAt = 0L
        private var locked = false

        /**
         * The lock decision on its own, so the grace window can be tested without a phone
         * that has a screen lock: never lock a phone with no lock set, never lock while the
         * app has been away for less than [GRACE_MS], and stay locked once locked.
         * `stoppedAt == 0` means the app has not been stopped yet in this process.
         */
        internal fun decide(enabled: Boolean, available: Boolean, locked: Boolean, stoppedAt: Long, now: Long): Boolean =
            locked || (enabled && available && (stoppedAt == 0L || now - stoppedAt > GRACE_MS))
    }
}
