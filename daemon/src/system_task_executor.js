/**
 * System Task Executor
 *
 * Extracted from happier (inspiration).
 * Manages system task execution with cancellation, event emission,
 * signal handling, and result validation.
 */

import { randomUUID } from 'crypto';
import { createInterface } from 'readline';

// --- Task Types ---

/**
 * @typedef {'install' | 'setup' | 'configure' | 'deploy' | 'custom'} TaskKind
 */

/**
 * @typedef {Object} SystemTaskSpec
 * @property {string} kind
 * @property {Object} params
 * @property {Object} [metadata]
 */

/**
 * @typedef {Object} TaskEvent
 * @property {string} taskId
 * @property {string} type
 * @property {*} [data]
 * @property {number} timestamp
 */

/**
 * @typedef {Object} TaskResult
 * @property {string} taskId
 * @property {boolean} ok
 * @property {*} [output]
 * @property {string} [error]
 */

// --- Task Registry ---

export class SystemTaskRegistry {
  constructor() {
    this.handlers = new Map();
  }

  register(kind, handler) {
    if (this.handlers.has(kind)) {
      throw new Error(`Handler already registered for kind: ${kind}`);
    }
    this.handlers.set(kind, handler);
  }

  getHandler(kind) {
    return this.handlers.get(kind);
  }

  hasHandler(kind) {
    return this.handlers.has(kind);
  }

  listKinds() {
    return Array.from(this.handlers.keys());
  }
}

// --- Cancellation ---

export function createCancellationState(signalSource = process) {
  let cancelled = false;
  let cancelReason = null;
  const listeners = new Set();

  const signal = {
    get isCancelled() { return cancelled; },
    get reason() { return cancelReason; },
    throwIfCancelled() {
      if (cancelled) throw new CancellationError(cancelReason || 'Task cancelled');
    },
  };

  function cancel(reason = 'Cancelled') {
    if (cancelled) return;
    cancelled = true;
    cancelReason = reason;
    for (const listener of listeners) {
      try { listener(reason); } catch {}
    }
  }

  function onSignal() {
    cancel('Process signal received');
  }

  signalSource.on?.('SIGINT', onSignal);
  signalSource.on?.('SIGTERM', onSignal);

  function dispose() {
    signalSource.off?.('SIGINT', onSignal);
    signalSource.off?.('SIGTERM', onSignal);
    listeners.clear();
  }

  function onCancel(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { signal, cancel, dispose, onCancel };
}

export class CancellationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CancellationError';
  }
}

// --- Event Emitter ---

export class TaskEventEmitter {
  constructor(taskId, emitFn = null) {
    this.taskId = taskId;
    this.emitFn = emitFn;
  }

  emit(type, data) {
    const event = {
      taskId: this.taskId,
      type,
      data,
      timestamp: Date.now(),
    };
    if (this.emitFn) {
      this.emitFn(event);
    }
    return event;
  }

  progress(current, total, message) {
    return this.emit('progress', { current, total, message });
  }

  log(message, level = 'info') {
    return this.emit('log', { message, level });
  }

  error(message, details) {
    return this.emit('error', { message, details });
  }

  warning(message) {
    return this.emit('warning', { message });
  }
}

// --- Task Executor ---

export async function executeSystemTask(spec, options = {}) {
  const {
    taskId = createTaskId(),
    registry = new SystemTaskRegistry(),
    signal = { isCancelled: false, throwIfCancelled: () => {} },
    now = () => Date.now(),
    emitEvent = () => {},
  } = options;

  const emitter = new TaskEventEmitter(taskId, emitEvent);

  try {
    signal.throwIfCancelled();

    // Validate spec
    if (!spec || typeof spec.kind !== 'string') {
      return { taskId, ok: false, error: 'Invalid task spec: missing kind' };
    }

    const handler = registry.getHandler(spec.kind);
    if (!handler) {
      return { taskId, ok: false, error: `No handler registered for kind: ${spec.kind}` };
    }

    emitter.emit('started', { kind: spec.kind, params: spec.params });

    const result = await handler(spec.params, {
      taskId,
      signal,
      emitter,
      now,
    });

    emitter.emit('completed', result);

    return {
      taskId,
      ok: true,
      output: result,
    };

  } catch (error) {
    if (error instanceof CancellationError) {
      emitter.emit('cancelled', { reason: error.message });
      return { taskId, ok: false, error: error.message };
    }

    emitter.error(error.message, error.stack);
    return { taskId, ok: false, error: error.message };
  }
}

// --- Helpers ---

export function createTaskId() {
  return randomUUID().slice(0, 8);
}

export function createSystemTaskSpec(kind, params = {}, metadata = {}) {
  return { kind, params, metadata };
}

// --- IO Helpers ---

export function createDefaultIo() {
  const rl = createInterface({ input: process.stdin });

  return {
    stdin: {
      readLine: () => new Promise((resolve) => {
        rl.question('', (answer) => resolve(answer || null));
      }),
      close: () => rl.close(),
    },
    stdout: { write: (chunk) => process.stdout.write(chunk) },
    stderr: { write: (chunk) => process.stderr.write(chunk) },
  };
}

export async function readAllFromStdin(stdin) {
  const lines = [];
  let line;
  while ((line = await stdin.readLine()) !== null) {
    lines.push(line);
  }
  return lines.join('\n');
}
