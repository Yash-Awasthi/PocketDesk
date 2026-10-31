// SPDX-License-Identifier: GPL-3.0-or-later
package com.yasha.pocketdesk

import android.database.Cursor
import android.database.MatrixCursor
import android.os.CancellationSignal
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import android.webkit.MimeTypeMap
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.io.FileNotFoundException

/**
 * The linked PC's files in Android's Files app and every app's file picker: browse, open, save,
 * create folders, rename and delete. Document ids are paths on the PC; the root is its home folder.
 * Shown only while the PC is linked. Idea from TwinDesk's shared folders (GPL-3.0).
 */
class PcFilesProvider : DocumentsProvider() {
    private val io by lazy { Handler(HandlerThread("pc-files").apply { start() }.looper) }

    override fun onCreate() = true

    override fun queryRoots(projection: Array<out String>?): Cursor {
        val c = MatrixCursor(projection ?: ROOT_COLS)
        if (Link.client.status != Status.Connected) return c
        c.newRow().apply {
            add(Root.COLUMN_ROOT_ID, "pc")
            add(Root.COLUMN_DOCUMENT_ID, HOME)
            add(Root.COLUMN_TITLE, "Your PC")
            add(Root.COLUMN_SUMMARY, "Through PocketDesk")
            add(Root.COLUMN_ICON, R.mipmap.ic_launcher)
            add(Root.COLUMN_FLAGS, Root.FLAG_SUPPORTS_CREATE or Root.FLAG_SUPPORTS_IS_CHILD)
        }
        return c
    }

    override fun queryChildDocuments(parentId: String, projection: Array<out String>?, sortOrder: String?): Cursor {
        val c = MatrixCursor(projection ?: DOC_COLS)
        val l = list(parentId)
        for (e in l.items) row(c, child(l.path, e.name), e.name, e.isDir, e.size, e.mtime)
        c.setNotificationUri(context!!.contentResolver, DocumentsContract.buildChildDocumentsUri(AUTH, parentId))
        return c
    }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
        val c = MatrixCursor(projection ?: DOC_COLS)
        if (documentId == HOME) { row(c, HOME, "Your PC", true, null, null); return c }
        val (parent, name) = split(documentId)
        val e = list(parent).items.firstOrNull { it.name == name } ?: throw FileNotFoundException(documentId)
        row(c, documentId, e.name, e.isDir, e.size, e.mtime)
        return c
    }

    override fun isChildDocument(parentId: String, documentId: String) =
        parentId == HOME || documentId.startsWith(parentId.trimEnd('/', '\\') + sep(parentId))

    override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor {
        val ctx = context!!
        val cache = File(File(ctx.cacheDir, "pcfiles").apply { mkdirs() }, documentId.hashCode().toUInt().toString(16) + "-" + split(documentId).second)
        val writing = mode.contains('w')
        if (!writing || mode.contains('r') || mode.contains('a')) {
            if (!fetch(documentId, cache) && !writing) throw FileNotFoundException("could not read $documentId from the PC")
        } else cache.writeBytes(ByteArray(0))
        val pfdMode = ParcelFileDescriptor.parseMode(mode)
        if (!writing) return ParcelFileDescriptor.open(cache, pfdMode)
        // Written files go up to the PC once the app closes them.
        return ParcelFileDescriptor.open(cache, pfdMode, io) { e ->
            if (e == null) Link.client.uploadFile(documentId, { cache.inputStream() }, cache.length(), {}) { notifyChanged(split(documentId).first) }
        }
    }

    override fun createDocument(parentId: String, mimeType: String, displayName: String): String {
        val path = child(if (parentId == HOME) list(HOME).path else parentId, displayName.replace(Regex("[\\\\/:*?\"<>|]"), "_"))
        if (mimeType == Document.MIME_TYPE_DIR) op("mkdir", path) else {
            val done = java.util.concurrent.CountDownLatch(1)
            var err: String? = null
            Link.client.uploadFile(path, { java.io.ByteArrayInputStream(ByteArray(0)) }, 0, {}) { err = it; done.countDown() }
            done.await(20, java.util.concurrent.TimeUnit.SECONDS)
            err?.let { throw FileNotFoundException(it) }
        }
        notifyChanged(parentId)
        return path
    }

    override fun deleteDocument(documentId: String) { op("delete", documentId); notifyChanged(split(documentId).first) }

    override fun renameDocument(documentId: String, displayName: String): String {
        val (parent, _) = split(documentId)
        val to = child(parent, displayName)
        op("rename", documentId, to)
        notifyChanged(parent)
        return to
    }

    private fun list(id: String): FsListing = runBlocking { Link.client.listFolder(if (id == HOME) null else id) }
        ?: throw FileNotFoundException("the PC is not linked")

    private fun op(op: String, path: String, to: String? = null) {
        val r = runBlocking {
            withTimeoutOrNull(20_000) {
                kotlinx.coroutines.coroutineScope {
                    val wait = async(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { Link.client.fsResults.first { it.path == path || it.path == to } }
                    Link.client.fileOp(op, path, to)
                    wait.await()
                }
            }
        } ?: throw FileNotFoundException("the PC did not answer")
        if (!r.ok) throw FileNotFoundException(r.error ?: "$op failed")
    }

    private fun fetch(path: String, into: File): Boolean {
        val done = java.util.concurrent.CountDownLatch(1)
        var ok = false
        into.outputStream().use { out ->
            Link.client.downloadFile(path, out::write, { _, _ -> }) { err -> ok = err == null; done.countDown() }
            done.await(10, java.util.concurrent.TimeUnit.MINUTES)
        }
        return ok
    }

    private fun notifyChanged(parent: String) =
        context?.contentResolver?.notifyChange(DocumentsContract.buildChildDocumentsUri(AUTH, parent), null)

    private fun row(c: MatrixCursor, id: String, name: String, dir: Boolean, size: Long?, mtime: Long?) {
        c.newRow().apply {
            add(Document.COLUMN_DOCUMENT_ID, id)
            add(Document.COLUMN_DISPLAY_NAME, name)
            add(Document.COLUMN_MIME_TYPE, if (dir) Document.MIME_TYPE_DIR else mime(name))
            add(Document.COLUMN_SIZE, if (dir) null else size)
            add(Document.COLUMN_LAST_MODIFIED, mtime)
            add(Document.COLUMN_FLAGS, if (dir) Document.FLAG_DIR_SUPPORTS_CREATE or Document.FLAG_SUPPORTS_DELETE or Document.FLAG_SUPPORTS_RENAME
                else Document.FLAG_SUPPORTS_WRITE or Document.FLAG_SUPPORTS_DELETE or Document.FLAG_SUPPORTS_RENAME)
        }
    }

    companion object {
        const val AUTH = "com.yasha.pocketdesk.pcfiles"
        private const val HOME = "~"
        private val ROOT_COLS = arrayOf(Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE, Root.COLUMN_SUMMARY, Root.COLUMN_ICON, Root.COLUMN_FLAGS)
        private val DOC_COLS = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS)

        private fun sep(path: String) = if (path.contains('\\')) "\\" else "/"
        private fun child(parent: String, name: String) = parent.trimEnd('/', '\\') + sep(parent) + name
        private fun split(id: String): Pair<String, String> {
            val i = maxOf(id.lastIndexOf('/'), id.lastIndexOf('\\'))
            return if (i <= 0) HOME to id else (id.substring(0, i).let { if (it.endsWith(':')) it + "\\" else it }) to id.substring(i + 1)
        }
        private fun mime(name: String) = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

        /** The Files app re-reads the roots: the PC appears when linked and goes when not. */
        fun rootsChanged(ctx: android.content.Context) = ctx.contentResolver.notifyChange(DocumentsContract.buildRootsUri(AUTH), null)
    }
}
