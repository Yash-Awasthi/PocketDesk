pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
// JDK 25 pin: CI's actions/setup-java temurin 25 is auto-detected; without a local 25 JDK foojay
// downloads the same Temurin 25 into the Gradle JDK cache.
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "PocketDesk"
include(":app")
include(":benchmark")
