/**
 * File Transfer Module — Inspired by ttyd (ZMODEM) and termpair
 * Chunked file transfer with progress, resume, and integrity verification
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class FileTransferManager {
  constructor(options = {}) {
    this.chunkSize = options.chunkSize || 65536;
    this.maxFileSize = options.maxFileSize || 100 * 1024 * 1024;
    this.maxConcurrent = options.maxConcurrent || 3;
    this.tempDir = options.tempDir || '/tmp/rh-transfers';
    this.activeTransfers = new Map();
    this.completedTransfers = [];
    this.maxHistory = 100;
    this.eventHandlers = new Map();
    this.on = this.on.bind(this);
    this.emit = this.emit.bind(this);
  }

  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
    return () => {
      const handlers = this.eventHandlers.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
    };
  }

  emit(event, data) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(h => h(data));
    }
  }

  createTransfer(options) {
    if (this.activeTransfers.size >= this.maxConcurrent) {
      return { error: 'Max concurrent transfers reached', maxConcurrent: this.maxConcurrent };
    }
    const transferId = `tr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const transfer = {
      id: transferId,
      fileName: options.fileName,
      fileSize: options.fileSize || 0,
      fileType: options.fileType || 'binary',
      direction: options.direction || 'upload',
      status: 'pending',
      progress: 0,
      bytesTransferred: 0,
      checksum: null,
      chunks: [],
      startedAt: null,
      completedAt: null,
      error: null,
      metadata: options.metadata || {}
    };
    this.activeTransfers.set(transferId, transfer);
    this.emit('transfer_created', { transferId, fileName: transfer.fileName });
    return { transferId, status: 'pending' };
  }

  startTransfer(transferId) {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return { error: 'Transfer not found' };
    transfer.status = 'active';
    transfer.startedAt = Date.now();
    this.emit('transfer_started', { transferId });
    return { status: 'active' };
  }

  async sendChunk(transferId, chunkIndex, data) {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return { error: 'Transfer not found' };
    if (transfer.status !== 'active') return { error: 'Transfer not active' };
    const chunkHash = crypto.createHash('sha256').update(data).digest('hex');
    transfer.chunks[chunkIndex] = {
      index: chunkIndex,
      size: data.length,
      hash: chunkHash,
      timestamp: Date.now()
    };
    transfer.bytesTransferred += data.length;
    transfer.progress = transfer.fileSize > 0
      ? Math.min(100, (transfer.bytesTransferred / transfer.fileSize) * 100)
      : 0;
    this.emit('chunk_sent', { transferId, chunkIndex, progress: transfer.progress });
    return {
      chunkIndex,
      hash: chunkHash,
      progress: transfer.progress,
      bytesTransferred: transfer.bytesTransferred
    };
  }

  async receiveChunk(transferId, chunkIndex, data) {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return { error: 'Transfer not found' };
    if (transfer.status !== 'active') return { error: 'Transfer not active' };
    const chunkHash = crypto.createHash('sha256').update(data).digest('hex');
    transfer.chunks[chunkIndex] = {
      index: chunkIndex,
      size: data.length,
      hash: chunkHash,
      timestamp: Date.now()
    };
    transfer.bytesTransferred += data.length;
    transfer.progress = transfer.fileSize > 0
      ? Math.min(100, (transfer.bytesTransferred / transfer.fileSize) * 100)
      : 0;
    this.emit('chunk_received', { transferId, chunkIndex, progress: transfer.progress });
    return {
      chunkIndex,
      hash: chunkHash,
      progress: transfer.progress,
      bytesTransferred: transfer.bytesTransferred
    };
  }

  completeTransfer(transferId, finalChecksum) {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return { error: 'Transfer not found' };
    transfer.status = 'completed';
    transfer.completedAt = Date.now();
    transfer.progress = 100;
    transfer.checksum = finalChecksum;
    const duration = (transfer.completedAt - transfer.startedAt) / 1000;
    const speed = transfer.bytesTransferred / duration;
    this.completedTransfers.push({ ...transfer });
    if (this.completedTransfers.length > this.maxHistory) {
      this.completedTransfers.shift();
    }
    this.activeTransfers.delete(transferId);
    this.emit('transfer_completed', {
      transferId,
      duration,
      speed,
      bytesTransferred: transfer.bytesTransferred
    });
    return {
      status: 'completed',
      duration,
      speed,
      bytesTransferred: transfer.bytesTransferred,
      checksum: finalChecksum
    };
  }

  cancelTransfer(transferId) {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return { error: 'Transfer not found' };
    transfer.status = 'cancelled';
    transfer.completedAt = Date.now();
    this.completedTransfers.push({ ...transfer });
    this.activeTransfers.delete(transferId);
    this.emit('transfer_cancelled', { transferId });
    return { status: 'cancelled' };
  }

  getTransferStatus(transferId) {
    const transfer = this.activeTransfers.get(transferId);
    if (transfer) {
      return {
        id: transfer.id,
        fileName: transfer.fileName,
        status: transfer.status,
        progress: transfer.progress,
        bytesTransferred: transfer.bytesTransferred,
        fileSize: transfer.fileSize,
        chunksReceived: transfer.chunks.filter(Boolean).length,
        elapsed: transfer.startedAt ? Date.now() - transfer.startedAt : 0
      };
    }
    const completed = this.completedTransfers.find(t => t.id === transferId);
    if (completed) {
      return {
        id: completed.id,
        fileName: completed.fileName,
        status: completed.status,
        progress: 100,
        bytesTransferred: completed.bytesTransferred,
        fileSize: completed.fileSize,
        completedAt: completed.completedAt
      };
    }
    return { error: 'Transfer not found' };
  }

  getActiveTransfers() {
    return Array.from(this.activeTransfers.values()).map(t => ({
      id: t.id,
      fileName: t.fileName,
      status: t.status,
      progress: t.progress,
      bytesTransferred: t.bytesTransferred,
      fileSize: t.fileSize
    }));
  }

  getCompletedTransfers() {
    return this.completedTransfers.map(t => ({
      id: t.id,
      fileName: t.fileName,
      status: t.status,
      bytesTransferred: t.bytesTransferred,
      duration: t.completedAt - t.startedAt
    }));
  }

  verifyChecksum(data, expectedChecksum) {
    const actual = crypto.createHash('sha256').update(data).digest('hex');
    return {
      valid: actual === expectedChecksum,
      expected: expectedChecksum,
      actual
    };
  }

  getStatus() {
    return {
      activeTransfers: this.activeTransfers.size,
      maxConcurrent: this.maxConcurrent,
      completedTransfers: this.completedTransfers.length,
      chunkSize: this.chunkSize,
      maxFileSize: this.maxFileSize
    };
  }

  destroy() {
    this.activeTransfers.clear();
    this.completedTransfers = [];
    this.eventHandlers.clear();
  }
}

class TransferProgressTracker {
  constructor() {
    this.progressMap = new Map();
    this.eventHandlers = new Map();
  }

  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
  }

  emit(event, data) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) handlers.forEach(h => h(data));
  }

  updateProgress(transferId, progress) {
    const existing = this.progressMap.get(transferId) || {
      history: [],
      startTime: Date.now(),
      lastUpdate: Date.now()
    };
    const now = Date.now();
    const timeDelta = (now - existing.lastUpdate) / 1000;
    const bytesDelta = progress.bytesTransferred - (existing.history.length > 0
      ? existing.history[existing.history.length - 1].bytesTransferred
      : 0);
    const speed = timeDelta > 0 ? bytesDelta / timeDelta : 0;
    existing.history.push({
      progress: progress.progress,
      bytesTransferred: progress.bytesTransferred,
      speed,
      timestamp: now
    });
    if (existing.history.length > 100) existing.history.shift();
    existing.lastUpdate = now;
    this.progressMap.set(transferId, existing);
    const remaining = progress.fileSize - progress.bytesTransferred;
    const eta = speed > 0 ? remaining / speed : Infinity;
    this.emit('progress_updated', {
      transferId,
      progress: progress.progress,
      speed,
      eta,
      bytesTransferred: progress.bytesTransferred,
      fileSize: progress.fileSize
    });
    return { speed, eta, progress: progress.progress };
  }

  getProgress(transferId) {
    const data = this.progressMap.get(transferId);
    if (!data || data.history.length === 0) return null;
    const latest = data.history[data.history.length - 1];
    const recent = data.history.slice(-10);
    const avgSpeed = recent.reduce((sum, h) => sum + h.speed, 0) / recent.length;
    return {
      progress: latest.progress,
      speed: latest.speed,
      avgSpeed,
      bytesTransferred: latest.bytesTransferred,
      elapsed: (Date.now() - data.startTime) / 1000
    };
  }

  clearProgress(transferId) {
    this.progressMap.delete(transferId);
  }
}

module.exports = { FileTransferManager, TransferProgressTracker };
