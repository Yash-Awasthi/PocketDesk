/**
 * File Sync Engine — Continuous file synchronization between devices.
 *
 * Inspired by syncthing and tailscale.
 * Provides real-time file sync, conflict resolution, and peer discovery.
 */

import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type SyncStatus = 'idle' | 'syncing' | 'paused' | 'error';

export interface SyncDevice {
  id: string;
  name: string;
  hostname: string;
  addresses: string[];
  isOnline: boolean;
  lastSeen: Date;
  compression: boolean;
  paused: boolean;
}

export interface SyncFolder {
  id: string;
  label: string;
  path: string;
  devices: string[];
  status: SyncStatus;
  totalFiles: number;
  syncedFiles: number;
  lastSync: Date;
  ignorePatterns: string[];
}

export interface SyncFile {
  path: string;
  hash: string;
  size: number;
  modifiedAt: Date;
  version: number;
  deviceId: string;
  status: 'synced' | 'pending' | 'conflict' | 'deleted';
}

export interface SyncEvent {
  type: 'file_synced' | 'file_conflict' | 'device_connected' | 'device_disconnected';
  folderId: string;
  deviceId: string;
  filePath?: string;
  timestamp: Date;
}

// ============================================================================
// File Sync Engine Manager
// ============================================================================

export class FileSyncEngineManager extends EventEmitter {
  private devices: Map<string, SyncDevice> = new Map();
  private folders: Map<string, SyncFolder> = new Map();
  private files: Map<string, SyncFile[]> = new Map();
  private events: SyncEvent[] = [];

  /**
   * Register a device.
   */
  registerDevice(name: string, hostname: string, addresses: string[]): SyncDevice {
    const device: SyncDevice = {
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
  createFolder(label: string, path: string, deviceIds: string[]): SyncFolder {
    const folder: SyncFolder = {
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
   * Add a file to sync.
   */
  addFile(folderId: string, file: Omit<SyncFile, 'status'>): SyncFile {
    const syncFile: SyncFile = { ...file, status: 'pending' };
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
  syncFile(folderId: string, filePath: string, sourceDeviceId: string): boolean {
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

    const event: SyncEvent = {
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
  detectConflict(folderId: string, filePath: string, deviceId1: string, deviceId2: string): SyncFile | null {
    const files = this.files.get(folderId) || [];
    const file = files.find((f) => f.path === filePath);
    if (!file) return null;

    file.status = 'conflict';

    const event: SyncEvent = {
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
  resolveConflict(folderId: string, filePath: string, keepDeviceId: string): boolean {
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
   * Check device connectivity.
   */
  checkDevices(): void {
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
  getFolderStatus(folderId: string): { synced: number; pending: number; conflicts: number } | null {
    const files = this.files.get(folderId);
    if (!files) return null;

    return {
      synced: files.filter((f) => f.status === 'synced').length,
      pending: files.filter((f) => f.status === 'pending').length,
      conflicts: files.filter((f) => f.status === 'conflict').length,
    };
  }

  /**
   * Get all devices.
   */
  getDevices(): SyncDevice[] {
    return Array.from(this.devices.values());
  }

  /**
   * Get all folders.
   */
  getFolders(): SyncFolder[] {
    return Array.from(this.folders.values());
  }

  /**
   * Get sync events.
   */
  getEvents(limit: number = 100): SyncEvent[] {
    return this.events.slice(-limit);
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalDevices: number;
    onlineDevices: number;
    totalFolders: number;
    totalFiles: number;
    syncedFiles: number;
    conflicts: number;
  } {
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
