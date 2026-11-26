// Macrobenchmarks and the baseline-profile generator for the app. A test-only module: it drives
// the app from outside and ships in no APK. Both workloads need a device, so this module is
// outside the normal gate. See README.md and docs/BASELINE-PROFILE.md for the one-command flow.
plugins {
    id("com.android.test")
    // The producer side of the generator: this module supplies the profile-collecting test.
    alias(libs.plugins.androidx.baselineprofile)
}

android {
    namespace = "com.yasha.pocketdesk.benchmark"
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }

    defaultConfig {
        minSdk = 30
        targetSdk = 37
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // The app's native libraries are arm64-only outside debug, so an emulator cannot run this
        // benchmark variant. The suppression is for a physical device only; see the doc.
        testInstrumentationRunnerArguments["androidx.benchmark.suppressErrors"] = "LOW-BATTERY,UNLOCKED"
        // The generator runs in this same APK. Pin each run to its own rules so a benchmark run
        // never records a profile and a generation run never measures: the plugin flips this to
        // `baselineprofile` for `generateBaselineProfile`.
        testInstrumentationRunnerArguments["androidx.benchmark.enabledRules"] = "macrobenchmark"
    }

    buildTypes {
        // Matches the app build type the plugin creates for measuring. The test APK and the app
        // APK must be the same variant, or the benchmark measures a build nobody ships.
        create("benchmark") {
            isDebuggable = true
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += listOf("release")
        }
    }

    targetProjectPath = ":app"
    experimentalProperties["android.experimental.self-instrumenting"] = true

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
    implementation(libs.benchmark.macro.junit4)
    implementation(libs.benchmark.junit4)
    implementation(libs.androidx.test.junit)
    implementation(libs.androidx.test.runner)
    implementation(libs.uiautomator)
}

// The requested one-command flow; the generator itself belongs to the app target, because that is
// where the baselineProfile dependency and the consumed profile file live.
tasks.register("generateBaselineProfile") {
    group = "benchmark"
    description = "Records the baseline profile on a device and writes app/src/main/baseline-prof.txt."
    dependsOn(":app:generateBaselineProfile")
}