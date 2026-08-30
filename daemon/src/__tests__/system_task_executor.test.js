import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SystemTaskRegistry,
  createCancellationState,
  CancellationError,
  TaskEventEmitter,
  executeSystemTask,
  createTaskId,
  createSystemTaskSpec,
} from '../system_task_executor.js';

describe('System Task Executor', () => {
  describe('Task Registry', () => {
    it('registers and retrieves handlers', () => {
      const registry = new SystemTaskRegistry();
      registry.register('test', () => 'done');
      assert.ok(registry.hasHandler('test'));
      assert.equal(registry.getHandler('test')(), 'done');
    });

    it('throws on duplicate registration', () => {
      const registry = new SystemTaskRegistry();
      registry.register('test', () => {});
      assert.throws(() => registry.register('test', () => {}));
    });

    it('lists registered kinds', () => {
      const registry = new SystemTaskRegistry();
      registry.register('a', () => {});
      registry.register('b', () => {});
      assert.deepEqual(registry.listKinds().sort(), ['a', 'b']);
    });
  });

  describe('Cancellation', () => {
    it('creates cancellation state', () => {
      const { signal, cancel, dispose } = createCancellationState();
      assert.equal(signal.isCancelled, false);
      cancel('test');
      assert.equal(signal.isCancelled, true);
      assert.equal(signal.reason, 'test');
      dispose();
    });

    it('throws on cancelled signal', () => {
      const { signal, cancel, dispose } = createCancellationState();
      cancel();
      assert.throws(() => signal.throwIfCancelled(), CancellationError);
      dispose();
    });
  });

  describe('Event Emitter', () => {
    it('emits events', () => {
      const events = [];
      const emitter = new TaskEventEmitter('t1', (e) => events.push(e));
      emitter.emit('test', { value: 42 });
      assert.equal(events.length, 1);
      assert.equal(events[0].taskId, 't1');
      assert.equal(events[0].type, 'test');
    });

    it('emits progress', () => {
      const events = [];
      const emitter = new TaskEventEmitter('t1', (e) => events.push(e));
      emitter.progress(5, 10, 'Half done');
      assert.equal(events[0].data.current, 5);
      assert.equal(events[0].data.total, 10);
    });
  });

  describe('Task Execution', () => {
    it('executes successfully', async () => {
      const registry = new SystemTaskRegistry();
      registry.register('test', (params) => ({ result: params.input * 2 }));
      const result = await executeSystemTask(
        createSystemTaskSpec('test', { input: 21 }),
        { registry },
      );
      assert.equal(result.ok, true);
      assert.equal(result.output.result, 42);
    });

    it('fails on unknown kind', async () => {
      const result = await executeSystemTask(
        createSystemTaskSpec('unknown'),
        { registry: new SystemTaskRegistry() },
      );
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('No handler'));
    });

    it('fails on invalid spec', async () => {
      const result = await executeSystemTask(null);
      assert.equal(result.ok, false);
    });

    it('handles cancellation', async () => {
      const { signal, cancel, dispose } = createCancellationState();
      cancel();
      const result = await executeSystemTask(
        createSystemTaskSpec('test'),
        { signal },
      );
      assert.equal(result.ok, false);
      dispose();
    });
  });

  describe('Helpers', () => {
    it('creates task ID', () => {
      const id = createTaskId();
      assert.equal(typeof id, 'string');
      assert.equal(id.length, 8);
    });

    it('creates task spec', () => {
      const spec = createSystemTaskSpec('install', { package: 'foo' });
      assert.equal(spec.kind, 'install');
      assert.equal(spec.params.package, 'foo');
    });
  });
});
