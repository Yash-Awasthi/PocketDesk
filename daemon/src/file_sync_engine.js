/**
 * File Sync Engine — Continuous file synchronization between devices.
 *
 * Inspired by syncthing and tailscale.
 * Provides real-time file sync, conflict resolution, and peer discovery.
 * Ported from TS-syntax-in-js to plain ESM (matches the daemon runtime).
 */

import { randomBytes } from 'crypto';
import { EventEmitter } from 'events';

export class FileSyncEngineManager extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map();
    this.folders = new Map();
    this.files = new Map();
    this.events = [];
  }

  /**
   * Register a device.
   */
  registerDevice(name, hostname, addresses) {
    const device = {
      id: randomBytes(8).toString('hex'),
      name,
      hostname,
      addresses,
      isOnline: true,
      lastSeen: new Date(),
      compression: true,
      paused: false,
    };

    this.devices.set(device.id, device);
    this.emit('device:registered', device);
    return device;
  }

  /**
   * Create a sync folder.
   */
  createFolder(label, path, deviceIds) {
    const folder = {
      id: randomBytes(8).toString('hex'),
      label,
      path,
      devices: deviceIds,
      status: 'idle',
      totalFiles: 0,
      syncedFiles: 0,
      lastSync: new Date(),
      ignorePatterns: ['.git', 'node_modules', '__pycache__', '.DS_Store'],
    };

    this.folders.set(folder.id, folder);
    this.files.set(folder.id, []);
    this.emit('folder:created', folder);
    return folder;
  }

  /**
   * Add a file to sync (starts as 'pending').
   */
  addFile(folderId, file) {
    const syncFile = { ...file, status: 'pending' };
    const files = this.files.get(folderId) || [];
    files.push(syncFile);
    this.files.set(folderId, files);

    const folder = this.folders.get(folderId);
    if (folder) {
      folder.totalFiles++;
    }

    return syncFile;
  }

  /**
   * Sync a file between devices.
   */
  syncFile(folderId, filePath, sourceDeviceId) {
    const files = this.files.get(folderId) || [];
    const file = files.find((f) => f.path === filePath);
    if (!file) return false;

    file.status = 'synced';
    file.deviceId = sourceDeviceId;

    const folder = this.folders.get(folderId);
    if (folder) {
      folder.syncedFiles++;
      folder.lastSync = new Date();
    }

    const event = {
      type: 'file_synced',
      folderId,
      deviceId: sourceDeviceId,
      filePath,
      timestamp: new Date(),
    };
    this.events.push(event);

    this.emit('file:synced', event);
    return true;
  }

  /**
   * Detect a file conflict.
   */
  detectConflict(folderId, filePath, deviceId1, deviceId2) {
    const files = this.files.get(folderId) || [];
    const file = files.find((f) => f.path === filePath);
    if (!file) return null;

    file.status = 'conflict';

    const event = {
      type: 'file_conflict',
      folderId,
      deviceId: deviceId1,
      filePath,
      timestamp: new Date(),
    };
    this.events.push(event);

    this.emit('file:conflict', { ...event, deviceId2 });
    return file;
  }

  /**
   * Resolve a conflict by keeping one version.
   */
  resolveConflict(folderId, filePath, keepDeviceId) {
    const files = this.files.get(folderId) || [];
    const file = files.find((f) => f.path === filePath);
    if (!file || file.status !== 'conflict') return false;

    file.status = 'synced';
    file.deviceId = keepDeviceId;
    file.version++;

    this.emit('conflict:resolved', { folderId, filePath, keepDeviceId });
    return true;
  }

  /**
   * Check device connectivity (1-minute timeout).
   */
  checkDevices() {
    const now = Date.now();
    for (const device of this.devices.values()) {
      const timeSinceLastSeen = now - device.lastSeen.getTime();
      const wasOnline = device.isOnline;
      device.isOnline = timeSinceLastSeen < 60000; // 1 minute timeout

      if (wasOnline && !device.isOnline) {
        this.emit('device:disconnected', device);
      } else if (!wasOnline && device.isOnline) {
        this.emit('device:connected', device);
      }
    }
  }

  /**
   * Get folder status.
   */
  getFolderStatus(folderId) {
    const files = this.files.get(folderId);
    if (!files) return null;

    return {
      synced: files.filter((f) => f.status === 'synced').length,
      pending: files.filter((f) => f.status === 'pending').length,
      conflicts: files.filter((f) => f.status === 'conflict').length,
    };
  }

  /**
   * Get all files in a folder.
   */
  getFiles(folderId) {
    return this.files.get(folderId) || [];
  }

  /**
   * Get all devices.
   */
  getDevices() {
    return Array.from(this.devices.values());
  }

  /**
   * Get all folders.
   */
  getFolders() {
    return Array.from(this.folders.values());
  }

  /**
   * Get sync events.
   */
  getEvents(limit = 100) {
    return this.events.slice(-limit);
  }

  /**
   * Get statistics.
   */
  getStats() {
    const devices = Array.from(this.devices.values());
    const files = Array.from(this.files.values()).flat();

    return {
      totalDevices: devices.length,
      onlineDevices: devices.filter((d) => d.isOnline).length,
      totalFolders: this.folders.size,
      totalFiles: files.length,
      syncedFiles: files.filter((f) => f.status === 'synced').length,
      conflicts: files.filter((f) => f.status === 'conflict').length,
    };
  }
}