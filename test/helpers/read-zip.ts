import assert from 'node:assert/strict';

/** Reads a ZIP by its central directory, the way an extractor does, so a writer isn't tested against itself. */
export function readZip(zip: Uint8Array): Array<{ name: string; data: Uint8Array; crc: number }> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, 'end of central directory');
  const count = view.getUint16(end + 10, true);
  assert.equal(view.getUint16(end + 8, true), count);
  let at = view.getUint32(end + 16, true);
  assert.equal(view.getUint32(end + 12, true) + at, end, 'the directory ends where the end record starts');
  const out = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(at, true), 0x02014b50, 'central header');
    assert.equal(view.getUint16(at + 10, true), 0, 'stored');
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint32(offset, true), 0x04034b50, 'local header');
    assert.equal(view.getUint16(offset + 6, true) & 0x0800, 0x0800, 'UTF-8 names');
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    out.push({ name, data: zip.subarray(start, start + size), crc });
    at += 46 + nameLength;
  }
  return out;
}
