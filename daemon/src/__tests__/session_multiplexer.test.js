import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateName,
  MuxError,
  InvalidName,
} from '../session_multiplexer.js';

describe('Session Multiplexer', () => {
  describe('validateName', () => {
    it('accepts valid names', () => {
      assert.doesNotThrow(() => validateName('my-session'));
      assert.doesNotThrow(() => validateName('test_session'));
      assert.doesNotThrow(() => validateName('Session123'));
    });

    it('rejects empty names', () => {
      assert.throws(() => validateName(''), InvalidName);
    });

    it('rejects names with special chars', () => {
      assert.throws(() => validateName('my/session'), InvalidName);
      assert.throws(() => validateName('my.session'), InvalidName);
    });

    it('allows spaces when configured', () => {
      assert.doesNotThrow(() => validateName('my session', true));
      assert.throws(() => validateName('my/session', true), InvalidName);
    });
  });

  describe('Error types', () => {
    it('MuxError is an Error', () => {
      const err = new MuxError('test');
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'MuxError');
    });

    it('InvalidName is a MuxError', () => {
      const err = new InvalidName('bad name');
      assert.ok(err instanceof MuxError);
      assert.equal(err.name, 'InvalidName');
    });
  });
});
