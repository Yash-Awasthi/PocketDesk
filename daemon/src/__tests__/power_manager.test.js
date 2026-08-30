import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PowerManager, normalizeAwakeMode, isStatusStale } from '../power_manager.js';

describe('Power Manager', () => {
  describe('normalizeAwakeMode', () => {
    it('normalizes valid modes', () => {
      assert.equal(normalizeAwakeMode('off'), 'off');
      assert.equal(normalizeAwakeMode('auto'), 'auto');
      assert.equal(normalizeAwakeMode('on'), 'on');
      assert.equal(normalizeAwakeMode('ON'), 'on');
    });

    it('defaults to off for invalid', () => {
      assert.equal(normalizeAwakeMode('invalid'), 'off');
      assert.equal(normalizeAwakeMode(null), 'off');
    });
  });

  describe('isStatusStale', () => {
    it('detects stale status', () => {
      const stale = { receivedAt: Date.now() - 3 * 60 * 60 * 1000 };
      assert.equal(isStatusStale(stale), true);
    });

    it('detects fresh status', () => {
      const fresh = { receivedAt: Date.now() - 1000 };
      assert.equal(isStatusStale(fresh), false);
    });
  });

  describe('PowerManager', () => {
    it('creates with default options', () => {
      const pm = new PowerManager({ platform: 'linux' });
      const status = pm.getStatus();
      assert.equal(status.mode, 'auto');
      assert.equal(status.active, false);
      pm.dispose();
    });

    it('sets mode', () => {
      const pm = new PowerManager({ platform: 'linux' });
      pm.setMode('on');
      assert.equal(pm.getStatus().mode, 'on');
      assert.equal(pm.getStatus().active, true);
      pm.dispose();
    });

    it('rejects invalid mode', () => {
      const pm = new PowerManager({ platform: 'linux' });
      assert.throws(() => pm.setMode('invalid'), /Invalid mode/);
      pm.dispose();
    });

    it('activates with running agents in auto mode', () => {
      const pm = new PowerManager({ platform: 'linux' });
      pm.setStatuses([
        { agentId: 'a1', state: 'running', receivedAt: Date.now() },
      ]);
      assert.equal(pm.getStatus().active, true);
      pm.dispose();
    });

    it('deactivates when no running agents', () => {
      const pm = new PowerManager({ platform: 'linux' });
      pm.setStatuses([
        { agentId: 'a1', state: 'idle', receivedAt: Date.now() },
      ]);
      assert.equal(pm.getStatus().active, false);
      pm.dispose();
    });

    it('ignores stale statuses', () => {
      const pm = new PowerManager({ platform: 'linux' });
      pm.setStatuses([
        { agentId: 'a1', state: 'running', receivedAt: Date.now() - 3 * 60 * 60 * 1000 },
      ]);
      assert.equal(pm.getStatus().active, false);
      pm.dispose();
    });

    it('subscribes to status changes', () => {
      const pm = new PowerManager({ platform: 'linux' });
      let received = null;
      pm.subscribe((status) => { received = status; });
      pm.setMode('on');
      assert.deepEqual(received, { mode: 'on', active: true });
      pm.dispose();
    });

    it('removes status', () => {
      const pm = new PowerManager({ platform: 'linux' });
      pm.setStatuses([{ agentId: 'a1', state: 'running', receivedAt: Date.now() }]);
      pm.removeStatus('a1');
      assert.equal(pm.getStatus().active, false);
      pm.dispose();
    });
  });
});
