// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk

import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import com.google.mlkit.vision.documentscanner.GmsDocumentScanner
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import com.yasha.pocketdesk.hub.ClipSync
import java.io.File

/**
 * Continuity Camera: a photo or a scanned document taken on the phone lands on the PC's clipboard,
 * ready to paste. A scan of several pages also goes to the PC's Downloads as one PDF.
 * Started with "mode" = "photo" or "scan" from the app, a tile, a shortcut or the PC's request.
 */
class CaptureActivity : ComponentActivity() {
    private lateinit var shot: Uri

    private val photo = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        if (ok) send(listOf(shot), null) else finish()
    }

    private val scan = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { r ->
        val res = if (r.resultCode == Activity.RESULT_OK) GmsDocumentScanningResult.fromActivityResultIntent(r.data) else null
        val pages = res?.pages.orEmpty().map { it.imageUri }
        if (pages.isEmpty()) finish() else send(pages, res?.pdf?.uri?.takeIf { pages.size > 1 })
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return
        if (Link.client.status != Status.Connected) {
            Toast.makeText(this, "Connect PocketDesk to your PC first", Toast.LENGTH_LONG).show()
            return finish()
        }
        if (intent.getStringExtra("mode") == "scan") startScan() else startPhoto()
    }

    private fun startPhoto() {
        val f = File(File(cacheDir, "shot").apply { mkdirs() }, "photo.jpg")
        shot = FileProvider.getUriForFile(this, "$packageName.files", f)
        photo.launch(shot)
    }

    private fun startScan() {
        val opts = GmsDocumentScannerOptions.Builder()
            .setGalleryImportAllowed(true)
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG, GmsDocumentScannerOptions.RESULT_FORMAT_PDF)
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .build()
        val scanner: GmsDocumentScanner = GmsDocumentScanning.getClient(opts)
        scanner.getStartScanIntent(this)
            .addOnSuccessListener { scan.launch(IntentSenderRequest.Builder(it).build()) }
            .addOnFailureListener {
                // Without Google Play services' scanner module, a plain photo is the next best thing.
                Toast.makeText(this, "The document scanner is not available here; taking a photo instead", Toast.LENGTH_LONG).show()
                startPhoto()
            }
    }

    private fun send(pages: List<Uri>, pdf: Uri?) {
        val app = applicationContext
        Toast.makeText(app, "Sending to your PC…", Toast.LENGTH_SHORT).show()
        Thread {
            val png = ClipSync.picture(app, pages.first())
            if (png != null) ClipSync.sendPicture(png, paste = true)
            if (pdf != null) {
                val name = "Scan ${java.text.SimpleDateFormat("yyyy-MM-dd HH.mm.ss", java.util.Locale.US).format(java.util.Date())}.pdf"
                Link.client.uploadFile("~/Downloads/$name", { app.contentResolver.openInputStream(pdf) }, null, {}) { err ->
                    android.os.Handler(app.mainLooper).post { Toast.makeText(app, err?.let { "PDF: $it" } ?: "$name is in the PC's Downloads", Toast.LENGTH_SHORT).show() }
                }
            }
            android.os.Handler(app.mainLooper).post {
                Toast.makeText(app, if (png != null) "On your PC's clipboard: paste with Ctrl+V" else "Could not read the picture", Toast.LENGTH_SHORT).show()
            }
        }.start()
        finish()
    }
}
