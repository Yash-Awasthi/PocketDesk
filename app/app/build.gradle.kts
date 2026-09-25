import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.yasha.pocketdesk"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.yasha.pocketdesk"
        minSdk = 30
        targetSdk = 36
        versionCode = 6
        versionName = "0.3.3"
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
        jniLibs { pickFirsts += "**/libiroh_ffi.so" }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.09.02"))
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Brings the Kotlin API, libiroh_ffi.so for each ABI, and JNA's Android build.
    implementation("computer.iroh:iroh-android:1.1.0")
    // iroh pulls JNA 5.15, whose x86 libraries are 4 KB-aligned; 5.19 aligns every ABI to 16 KB.
    implementation("net.java.dev.jna:jna:5.19.1@aar")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    testImplementation("junit:junit:4.13.2")
}
