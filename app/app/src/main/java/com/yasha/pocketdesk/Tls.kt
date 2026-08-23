package com.yasha.pocketdesk

import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient

object Tls {
    fun sha256(cert: X509Certificate): String =
        MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }

    /** Trust manager that accepts anything but records the leaf fingerprint it saw. */
    class CollectingTrustManager : X509TrustManager {
        @Volatile
        var seen: String? = null

        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
            if (chain.isEmpty()) throw CertificateException("empty chain")
            seen = sha256(chain[0])
        }
    }

    fun collectingClient(base: OkHttpClient): Pair<OkHttpClient, CollectingTrustManager> {
        val tm = CollectingTrustManager()
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf(tm), null)
        return base.newBuilder()
            .sslSocketFactory(ctx.socketFactory, tm)
            .hostnameVerifier { _, _ -> true }
            .build() to tm
    }

    private class PinnedTrustManager(private val pinned: String) : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
            if (chain.isEmpty()) throw CertificateException("empty chain")
            if (sha256(chain[0]) != pinned) throw CertificateException("certificate does not match the pinned fingerprint")
        }
    }

    fun pinnedClient(base: OkHttpClient, pinnedFp: String): OkHttpClient {
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf(PinnedTrustManager(pinnedFp)), null)
        return base.newBuilder()
            .sslSocketFactory(ctx.socketFactory, PinnedTrustManager(pinnedFp))
            .hostnameVerifier { _, _ -> true }
            .build()
    }
}
