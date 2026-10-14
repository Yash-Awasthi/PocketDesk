import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.yasha.pocketdesk"
    compileSdk {
        // Compose 1.13 needs the 37.1+ platform APIs.
        version = release(37) { minorApiLevel = 2 }
    }

    defaultConfig {
        applicationId = "com.yasha.pocketdesk"
        minSdk = 30
        targetSdk = 37
        versionCode = 21
        versionName = "0.8.0"
        // iroh's native library is ~14 MB per ABI: phones are arm64, debug adds the emulator's.
        ndk { abiFilters += "arm64-v8a" }
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            ndk { abiFilters += "x86_64" }
        }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystoreProps.isNotEmpty()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    // The iroh JVM jar also carries desktop builds of its native library.
    packaging {
        resources { excludes += listOf("darwin-*/**", "win32-*/**", "linux-*/**") }
        // Our 16 KB-aligned rebuild in src/main/jniLibs replaces the AAR's; see scripts/build-iroh-android.sh.
        jniLibs {
            pickFirsts += "**/libiroh_ffi.so"
            // Compressed in the APK (14 MB of iroh shrinks to about 6); Android unpacks it once at install.
            useLegacyPackaging = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    testOptions {
        unitTests.all { it.useJUnitPlatform() }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_21
    }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.activity.compose)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.core)
    implementation(libs.compose.ui)
    implementation(libs.core.ktx)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.navigation3.runtime)
    implementation(libs.navigation3.ui)
    implementation(platform(libs.okhttp.bom))
    implementation(libs.okhttp)
    // Brings the Kotlin API, libiroh_ffi.so for each ABI, and JNA's Android build.
    implementation(libs.iroh.android)
    // iroh pulls JNA 5.15, whose x86 libraries are 4 KB-aligned; 5.19 aligns every ABI to 16 KB.
    implementation(libs.jna) { artifact { type = "aar" } }
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
}
