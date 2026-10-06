import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { groupPastedLines, type PastedMessage } from '../src/matrix/paste.ts';

async function group(...lines: string[]): Promise<PastedMessage[]> {
  async function* source() {
    yield* lines;
  }
  const out: PastedMessage[] = [];
  for await (const message of groupPastedLines(source())) out.push(message);
  return out;
}

describe('groupPastedLines', () => {
  test('ordinary lines are separate messages, trimmed, and blank lines are skipped', async () => {
    assert.deepEqual(await group('help', '', '  login google  ', '   ', 'help'), [
      { text: 'help', lines: 1 },
      { text: 'login google', lines: 1 },
      { text: 'help', lines: 1 },
    ]);
  });

  test('a command copied from devtools, with a backslash ending each line, becomes one line', async () => {
    const curl = [
      "curl --url 'https://messages.google.com/web/config?pli=1' \\",
      "  -H 'accept: text/html' \\",
      "  -b 'SID=a; HSID=b; OSID=c' \\",
      "  -H 'user-agent: Mozilla/5.0'",
    ];
    assert.deepEqual(await group(...curl), [
      {
        text: "curl --url 'https://messages.google.com/web/config?pli=1' -H 'accept: text/html' -b 'SID=a; HSID=b; OSID=c' -H 'user-agent: Mozilla/5.0'",
        lines: 4,
      },
    ]);
  });

  test('a second command after the first is its own message', async () => {
    assert.deepEqual(await group('curl one \\', '  -H x', 'help'), [
      { text: 'curl one -H x', lines: 2 },
      { text: 'help', lines: 1 },
    ]);
  });

  test('a JSON object spread over several lines is sent whole, with its line breaks', async () => {
    assert.deepEqual(await group('{', '  "SID": "a",', '  "HSID": "b"', '}', 'help'), [
      { text: '{\n  "SID": "a",\n  "HSID": "b"\n}', lines: 4 },
      { text: 'help', lines: 1 },
    ]);
  });

  test('braces and escaped quotes inside JSON strings do not end the object early', async () => {
    assert.deepEqual(await group('{', '  "a": "}",', '  "b": "x\\"}y"', '}'), [{ text: '{\n  "a": "}",\n  "b": "x\\"}y"\n}', lines: 4 }]);
  });

  test('JSON on one line stays one message', async () => {
    assert.deepEqual(await group('{"SID": "a", "HSID": "b"}'), [{ text: '{"SID": "a", "HSID": "b"}', lines: 1 }]);
  });

  test('a blank line ends a group that never finished, and so does the end of the input', async () => {
    assert.deepEqual(await group('curl one \\', '  -H x \\', '', 'help'), [
      { text: 'curl one -H x', lines: 2 },
      { text: 'help', lines: 1 },
    ]);
    assert.deepEqual(await group('{', '"a": 1'), [{ text: '{\n"a": 1', lines: 2 }]);
    assert.deepEqual(await group('curl one \\'), [{ text: 'curl one', lines: 1 }]);
  });

  test('Windows line endings are ignored', async () => {
    assert.deepEqual(await group('curl one \\\r', '  -H x\r'), [{ text: 'curl one -H x', lines: 2 }]);
  });
});
