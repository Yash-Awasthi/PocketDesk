/**
 * Terminal Recording — Record and replay terminal sessions.
 *
 * Inspired by terminal-mcp's RecordingManager.
 * Supports multiple recording modes, formats, and replay.
 */

import { createHash } from 'crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// ============================================================================
// Types
// ============================================================================

export type RecordingMode = 'off' | 'metadata' | 'full';
export type RecordingFormat = 'v1' | 'v2';
export type StopReason = 'user' | 'timeout' | 'idle' | 'max_duration' | 'inactivity' | 'error';

export interface RecordingOptions {
  mode: RecordingMode;
  format: RecordingFormat;
  outputDir: string;
  idleTimeLimit: number;    // seconds before considering idle
  maxDuration: number;      // max recording duration in seconds
  inactivityTimeout: number; // seconds of inactivity before auto-stop
}

export interface RecordingEvent {
  timestamp: number;
  type: 'input' | 'output' | 'resize' | 'start' | 'stop' | 'metadata';
  data: string | Buffer;
  duration?: number;
}

export interface RecordingMetadata {
  id: string;
  startTime: Date;
  endTime?: Date;
  stopReason?: StopReason;
  format: RecordingFormat;
  totalInputEvents: number;
  totalOutputEvents: number;
  totalBytesIn: number;
  totalBytesOut: number;
  terminalSize?: { cols: number; rows: number };
}

export interface RecordingEntry {
  id: string;
  metadata: RecordingMetadata;
  events: RecordingEvent[];
  filePath: string;
}

// ============================================================================
// Recorder
// ============================================================================

export class Recorder {
  private id: string;
  private mode: RecordingMode;
  private format: RecordingFormat;
  private outputDir: string;
  private idleTimeLimit: number;
  private maxDuration: number;
  private inactivityTimeout: number;

  private events: RecordingEvent[] = [];
  private startTime: Date | null = null;
  private lastActivityTime: number = 0;
  private active = false;
  private metadata: RecordingMetadata | null = null;

  private inputCount = 0;
  private outputCount = 0;
  private bytesIn = 0;
  private bytesOut = 0;

  constructor(
    id: string,
    mode: RecordingMode,
    outputDir: string,
    format: RecordingFormat,
    idleTimeLimit: number,
    maxDuration: number,
    inactivityTimeout: number
  ) {
    this.id = id;
    this.mode = mode;
    this.format = format;
    this.outputDir = outputDir;
    this.idleTimeLimit = idleTimeLimit;
    this.maxDuration = maxDuration;
    this.inactivityTimeout = inactivityTimeout;
  }

  /**
   * Start recording.
   */
  start(): void {
    if (this.mode === 'off') return;
    this.active = true;
    this.startTime = new Date();
    this.lastActivityTime = Date.now();

    this.events.push({
      timestamp: Date.now(),
      type: 'start',
      data: '',
    });

    this.metadata = {
      id: this.id,
      startTime: this.startTime,
      format: this.format,
      totalInputEvents: 0,
      totalOutputEvents: 0,
      totalBytesIn: 0,
      totalBytesOut: 0,
    };
  }

  /**
   * Stop recording.
   */
  stop(reason: StopReason = 'user'): RecordingEntry | null {
    if (!this.active || !this.startTime) return null;
    this.active = false;

    this.events.push({
      timestamp: Date.now(),
      type: 'stop',
      data: reason,
      duration: Date.now() - this.startTime.getTime(),
    });

    if (this.metadata) {
      this.metadata.endTime = new Date();
      this.metadata.stopReason = reason;
      this.metadata.totalInputEvents = this.inputCount;
      this.metadata.totalOutputEvents = this.outputCount;
      this.metadata.totalBytesIn = this.bytesIn;
      this.metadata.totalBytesOut = this.bytesOut;
    }

    const filePath = this.save();
    return {
      id: this.id,
      metadata: this.metadata!,
      events: this.events,
      filePath,
    };
  }

  /**
   * Record an input event.
   */
  recordInput(data: string | Buffer): void {
    if (!this.active || this.mode === 'off') return;
    this.lastActivityTime = Date.now();
    this.inputCount++;
    this.bytesIn += typeof data === 'string' ? Buffer.byteLength(data) : data.length;

    this.events.push({
      timestamp: Date.now(),
      type: 'input',
      data,
    });
  }

  /**
   * Record an output event.
   */
  recordOutput(data: string | Buffer): void {
    if (!this.active || this.mode === 'off') return;
    this.lastActivityTime = Date.now();
    this.outputCount++;
    this.bytesOut += typeof data === 'string' ? Buffer.byteLength(data) : data.length;

    this.events.push({
      timestamp: Date.now(),
      type: 'output',
      data,
    });
  }

  /**
   * Record a terminal resize.
   */
  recordResize(cols: number, rows: number): void {
    if (!this.active || this.mode === 'off') return;

    this.events.push({
      timestamp: Date.now(),
      type: 'resize',
      data: `${cols}x${rows}`,
    });

    if (this.metadata) {
      this.metadata.terminalSize = { cols, rows };
    }
  }

  /**
   * Check if recording should auto-stop.
   */
  shouldAutoStop(): StopReason | null {
    if (!this.active || !this.startTime) return null;

    const elapsed = (Date.now() - this.startTime.getTime()) / 1000;
    const sinceActivity = (Date.now() - this.lastActivityTime) / 1000;

    if (elapsed > this.maxDuration) return 'max_duration';
    if (sinceActivity > this.inactivityTimeout) return 'inactivity';
    return null;
  }

  /**
   * Check if the recording is active.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Save recording to disk.
   */
  private save(): string {
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }

    const filename = `recording-${this.id}-${Date.now()}.json`;
    const filePath = join(this.outputDir, filename);

    const recording = {
      metadata: this.metadata,
      events: this.events.map((e) => ({
        ...e,
        data: typeof e.data === 'string' ? e.data : e.data.toString('base64'),
      })),
    };

    writeFileSync(filePath, JSON.stringify(recording, null, 2));
    return filePath;
  }

  /**
   * Get current stats.
   */
  getStats(): { inputCount: number; outputCount: number; bytesIn: number; bytesOut: number; durationMs: number } {
    return {
      inputCount: this.inputCount,
      outputCount: this.outputCount,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      durationMs: this.startTime ? Date.now() - this.startTime.getTime() : 0,
    };
  }
}

// ============================================================================
// Recording Manager
// ============================================================================

export class RecordingManager {
  private recordings: Map<string, Recorder> = new Map();
  private defaultOptions: RecordingOptions;

  constructor(options?: Partial<RecordingOptions>) {
    this.defaultOptions = {
      mode: options?.mode ?? 'metadata',
      format: options?.format ?? 'v2',
      outputDir: options?.outputDir ?? join(process.env.HOME || '', '.pocketdesk', 'recordings'),
      idleTimeLimit: options?.idleTimeLimit ?? 2,
      maxDuration: options?.maxDuration ?? 3600,
      inactivityTimeout: options?.inactivityTimeout ?? 600,
    };
  }

  /**
   * Create a new recording.
   */
  createRecording(options?: Partial<RecordingOptions>): Recorder {
    const id = createHash('sha256')
      .update(`${Date.now()}-${Math.random()}`)
      .digest('hex')
      .slice(0, 12);

    const merged = { ...this.defaultOptions, ...options };
    const recorder = new Recorder(
      id,
      merged.mode,
      merged.outputDir,
      merged.format,
      merged.idleTimeLimit,
      merged.maxDuration,
      merged.inactivityTimeout
    );

    this.recordings.set(id, recorder);
    return recorder;
  }

  /**
   * Get a recording by ID.
   */
  getRecording(id: string): Recorder | undefined {
    return this.recordings.get(id);
  }

  /**
   * Get all active recordings.
   */
  getActiveRecordings(): Recorder[] {
    return Array.from(this.recordings.values()).filter((r) => r.isActive());
  }

  /**
   * Auto-stop recordings that have exceeded limits.
   */
  checkAutoStops(): RecordingEntry[] {
    const stopped: RecordingEntry[] = [];
    for (const [id, recorder] of this.recordings) {
      const reason = recorder.shouldAutoStop();
      if (reason) {
        const entry = recorder.stop(reason);
        if (entry) stopped.push(entry);
      }
    }
    return stopped;
  }

  /**
   * List all saved recordings.
   */
  listRecordings(): string[] {
    return Array.from(this.recordings.keys());
  }
}

// ============================================================================
// Replay
// ============================================================================

/**
 * Replay a recording by replaying events with original timing.
 */
export function replayRecording(
  entry: RecordingEntry,
  callbacks: {
    onInput?: (data: string) => void;
    onOutput?: (data: string) => void;
    onResize?: (cols: number, rows: number) => void;
  },
  speed = 1
): { cancel: () => void } {
  let cancelled = false;
  const timers: NodeJS.Timeout[] = [];

  const events = entry.events.filter(
    (e) => e.type === 'input' || e.type === 'output' || e.type === 'resize'
  );

  if (events.length === 0) return { cancel: () => {} };

  const startTime = events[0].timestamp;

  for (const event of events) {
    const delay = ((event.timestamp - startTime) / speed);
    const timer = setTimeout(() => {
      if (cancelled) return;
      switch (event.type) {
        case 'input':
          callbacks.onInput?.(event.data as string);
          break;
        case 'output':
          callbacks.onOutput?.(event.data as string);
          break;
        case 'resize': {
          const [cols, rows] = (event.data as string).split('x').map(Number);
          callbacks.onResize?.(cols, rows);
          break;
        }
      }
    }, delay);
    timers.push(timer);
  }

  return {
    cancel: () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    },
  };
}
