import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStdinFrame,
  createSignalFrame,
  createResizeFrame,
  parseFrame,
  buildSynPayload,
  parseFinPayload,
} from '../shell_transport.js';

describe('Shell Transport', () => {
  describe('Frame Creation', () => {
    it('creates stdin frame', () => {
      const frame = createStdinFrame('hello');
      assert.equal(frame[0], 0); // TAG_STDIN
      assert.equal(frame.length, 6); // 1 tag + 5 bytes
    });

    it('creates signal frame', () => {
      const frame = createSignalFrame('SIGINT');
      assert.equal(frame[0], 3); // TAG_SIGNAL
    });

    it('creates resize frame', () => {
      const frame = createResizeFrame(120, 40);
      assert.equal(frame[0], 4); // TAG_RESIZE
      assert.equal(frame.length, 5);
      assert.equal((frame[1] << 8) | frame[2], 120);
      assert.equal((frame[3] << 8) | frame[4], 40);
    });
  });

  describe('Frame Parsing', () => {
    it('parses stdout frame', () => {
      const data = new Uint8Array([1, ...new TextEncoder().encode('hello')]);
      const frame = parseFrame(data.buffer);
      assert.equal(frame.type, 'stdout');
      assert.equal(frame.data, 'hello');
    });

    it('parses stderr frame', () => {
      const data = new Uint8Array([2, ...new TextEncoder().encode('error')]);
      const frame = parseFrame(data.buffer);
      assert.equal(frame.type, 'stderr');
      assert.equal(frame.data, 'error');
    });

    it('parses resize frame', () => {
      const data = new Uint8Array([4, 0, 80, 0, 24]);
      const frame = parseFrame(data.buffer);
      assert.equal(frame.type, 'resize');
      assert.equal(frame.cols, 80);
      assert.equal(frame.rows, 24);
    });

    it('parses signal frame', () => {
      const data = new Uint8Array([3, ...new TextEncoder().encode('SIGTERM')]);
      const frame = parseFrame(data.buffer);
      assert.equal(frame.type, 'signal');
      assert.equal(frame.signal, 'SIGTERM');
    });

    it('returns null for empty data', () => {
      assert.equal(parseFrame(null), null);
      assert.equal(parseFrame(new Uint8Array(0).buffer), null);
    });
  });

  describe('Syn/Fin Payloads', () => {
    it('builds syn payload', () => {
      const payload = buildSynPayload({ cols: 120, rows: 40 });
      assert.equal(payload.type, 'shell');
      assert.equal(payload.pty, true);
      assert.equal(payload.cols, 120);
      assert.equal(payload.rows, 40);
    });

    it('parses fin payload', () => {
      const result = parseFinPayload('{"exit_code":0}');
      assert.equal(result.exitCode, 0);
      assert.equal(result.signal, null);
    });

    it('parses fin with signal', () => {
      const result = parseFinPayload('{"signal":"SIGTERM"}');
      assert.equal(result.signal, 'SIGTERM');
    });

    it('parses fin with error', () => {
      const result = parseFinPayload('{"error":"spawn failed"}');
      assert.equal(result.error, 'spawn failed');
    });

    it('handles null reason', () => {
      const result = parseFinPayload(null);
      assert.equal(result.exitCode, 0);
    });
  });
});
