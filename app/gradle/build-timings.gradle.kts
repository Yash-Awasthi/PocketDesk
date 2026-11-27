// One line for the three CI tasks: the last of them to finish prints the wall time of the task
// phase; close() prints it when all three were up to date, so every build reports exactly once.
import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters
import java.util.Collections
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

abstract class BuildTimingsService : BuildService<BuildServiceParameters.None>, AutoCloseable {
    private val startedAt = System.nanoTime()
    private val finished = Collections.synchronizedSet(LinkedHashSet<String>())
    private val printed = AtomicBoolean(false)
    private val watched = listOf("lintDebug", "testDebugUnitTest", "assembleDebug")

    fun markFinished(taskName: String) {
        finished.add(taskName)
        if (finished.containsAll(watched)) printOnce()
    }

    override fun close() = printOnce()

    private fun printOnce() {
        if (!printed.compareAndSet(false, true)) return
        val seconds = String.format(Locale.ROOT, "%.1f", (System.nanoTime() - startedAt) / 1e9)
        println("build timings: lintDebug+testDebugUnitTest+assembleDebug took ${seconds}s (task phase; Gradle prints its own BUILD SUCCESSFUL total)")
    }
}

val buildTimings = gradle.sharedServices.registerIfAbsent("build-timings", BuildTimingsService::class) {}
val timedTaskNames = setOf("lintDebug", "testDebugUnitTest", "assembleDebug")

// Only locals are captured, so the stored action holds no script object reference.
tasks.matching { it.name in timedTaskNames }.configureEach {
    val service = buildTimings
    val taskName = this.name
    usesService(service)
    doLast { service.get().markFinished(taskName) }
}
