import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { upsertEnvLine } from '../src/dotenv.ts';

describe('upsertEnvLine', () => {
  test('adds the key to an empty file', () => {
    assert.equal(upsertEnvLine('', 'A', '1'), 'A=1\n');
  });

  test('appends after existing lines, with or without a trailing newline', () => {
    assert.equal(upsertEnvLine('B=2\n', 'A', '1'), 'B=2\nA=1\n');
    assert.equal(upsertEnvLine('B=2', 'A', '1'), 'B=2\nA=1\n');
  });

  test('replaces an existing line and leaves everything else alone', () => {
    const before = '# comment\nA=old\nB=2\n# A=commented out\n';
    assert.equal(upsertEnvLine(before, 'A', 'new'), '# comment\nA=new\nB=2\n# A=commented out\n');
  });

  test('keeps characters that are special in replacements', () => {
    assert.equal(upsertEnvLine('A=old\n', 'A', "a$&b$1'c"), "A=a$&b$1'c\n");
  });

  test('does not touch a key that merely starts with the same letters', () => {
    assert.equal(upsertEnvLine('AB=2\n', 'A', '1'), 'AB=2\nA=1\n');
  });
});
