package com.yasha.pocketdesk

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.security.cert.CertificateException
import javax.net.ssl.SSLServerSocket
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Certificate pinning, exercised with a real TLS handshake on the device.
 *
 * The PC serves a self-signed certificate and the phone trusts exactly one SHA-256
 * fingerprint of it (`Tls.pinnedClient`). If that pinning is wrong in either direction the
 * app either talks to something it should not, or refuses the PC it was just paired with —
 * so both the accept and the refuse path are checked here, not in a JVM stub.
 */
@RunWith(AndroidJUnit4::class)
class TlsInstrumentedTest {

    private class Server : AutoCloseable {
        val held: HeldCertificate = HeldCertificate.Builder()
            .commonName("PocketDesk test PC")
            .addSubjectAlternativeName("127.0.0.1")
            .build()
        val pin: String = Tls.sha256(held.certificate)
        private val socket: SSLServerSocket = run {
            val server = HandshakeCertificates.Builder().heldCertificate(held).build()
            (server.sslContext().serverSocketFactory.createServerSocket(0) as SSLServerSocket).apply {
                reuseAddress = true
            }
        }
        val port: Int get() = socket.localPort
        private val thread = Thread {
            runCatching {
                while (!socket.isClosed) {
                    val s = socket.accept()
                    // One request, one response, then close: the test only needs the handshake plus a 200.
                    s.use {
                        val input = it.inputStream
                        val buffer = ByteArray(4096)
                        if (input.read(buffer) > 0) {
                            it.outputStream.write(
                                ("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").toByteArray(),
                            )
                            it.outputStream.flush()
                        }
                    }
                }
            }
        }.apply { isDaemon = true; start() }

        override fun close() {
            runCatching { socket.close() }
            thread.interrupt()
        }
    }

    private fun body(client: OkHttpClient, port: Int): String =
        client.newCall(Request.Builder().url("https://127.0.0.1:$port/").build()).execute().use { it.body!!.string() }

    @Test
    fun thePairedFingerprintIsAccepted() {
        Server().use { server ->
            val client = Tls.pinnedClient(OkHttpClient(), server.pin)
            assertEquals("ok", body(client, server.port))
        }
    }

    @Test
    fun aDifferentFingerprintIsRefused() {
        Server().use { server ->
            val wrong = "0".repeat(64)
            val client = Tls.pinnedClient(OkHttpClient(), wrong)
            val failure = runCatching { body(client, server.port) }.exceptionOrNull()
            assertTrue("expected the handshake to be refused, got $failure", failure is CertificateException || failure is javax.net.ssl.SSLHandshakeException || failure is java.io.IOException)
        }
    }

    @Test
    fun theCollectingTrustManagerReportsTheFingerprintItSaw() {
        Server().use { server ->
            val (client, tm) = Tls.collectingClient(OkHttpClient())
            body(client, server.port)
            assertEquals(server.pin, tm.seen)
        }
    }

    @Test
    fun theFingerprintIsStableForTheSameCertificate() {
        val held = HeldCertificate.Builder().commonName("stable").build()
        val first = Tls.sha256(held.certificate)
        val second = Tls.sha256(held.certificate)
        assertEquals(first, second)
        assertEquals(64, first.length)
        assertTrue(first.all { it in "0123456789abcdef" })
    }
}
