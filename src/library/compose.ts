import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A picture placed on the canvas, with an optional number badge and caption drawn over or under it. */
export interface Tile {
  /** A JPEG or PNG file. */
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** A number in a circle at the top left. */
  badge?: string;
  /** A line over the bottom of the picture (in a dark band). */
  overlay?: string;
}

/** A line of text on the canvas. */
export interface Label {
  text: string;
  x: number;
  y: number;
  w: number;
  size: number;
  bold?: boolean;
  /** 0 to 1: how bright the text is (1 is white). */
  shade?: number;
}

export interface Composition {
  width: number;
  height: number;
  /** Background, 0 to 255 each. */
  background: [number, number, number];
  tiles: Tile[];
  labels?: Label[];
  /** JPEG quality, 0 to 1. */
  quality?: number;
}

/**
 * Draws with macOS's own graphics (AppKit, through JavaScript for Automation), so nothing has to be installed.
 * Coordinates in the spec are from the top left; AppKit's start at the bottom left, hence the flips.
 */
const SCRIPT = String.raw`
ObjC.import('AppKit');
function run(argv) {
  const spec = JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null)));
  const W = spec.width, H = spec.height;
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, W, H, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(context);
  const color = (r, g, b, a) => $.NSColor.colorWithSRGBRedGreenBlueAlpha(r / 255, g / 255, b / 255, a);
  const rect = (x, y, w, h) => $.NSMakeRect(x, H - y - h, w, h);
  color(spec.background[0], spec.background[1], spec.background[2], 1).setFill;
  $.NSRectFill($.NSMakeRect(0, 0, W, H));

  const text = (value, x, y, w, size, bold, shade, align) => {
    // Always laid out from the left; centring is done by measuring, because the alignment constants differ between
    // Intel and Apple-silicon Macs and the bridge to them can hand over the wrong one.
    const style = $.NSMutableParagraphStyle.alloc.init;
    style.lineBreakMode = $.NSLineBreakByTruncatingTail;
    const font = bold ? $.NSFont.boldSystemFontOfSize(size) : $.NSFont.systemFontOfSize(size);
    const level = Math.round(255 * (shade === undefined ? 1 : shade));
    const attrs = $.NSDictionary.dictionaryWithObjectsForKeys(
      $([font, color(level, level, level, 1), style]),
      $([$.NSFontAttributeName, $.NSForegroundColorAttributeName, $.NSParagraphStyleAttributeName]),
    );
    const string = $.NSString.alloc.initWithUTF8String(value);
    let left = x;
    if (align === 'center') left = x + Math.max(0, (w - string.sizeWithAttributes(attrs).width) / 2);
    string.drawInRectWithAttributes(rect(left, y, w - (left - x), size * 1.35), attrs);
  };

  for (const tile of spec.tiles) {
    const image = $.NSImage.alloc.initWithContentsOfFile(tile.path);
    if (image.isNil()) continue;
    // Fill the tile, cropping the picture's longer side, centred.
    const iw = image.size.width, ih = image.size.height;
    const scale = Math.max(tile.w / iw, tile.h / ih);
    const sw = tile.w / scale, sh = tile.h / scale;
    const from = $.NSMakeRect((iw - sw) / 2, (ih - sh) / 2, sw, sh);
    image.drawInRectFromRectOperationFraction(rect(tile.x, tile.y, tile.w, tile.h), from, $.NSCompositingOperationSourceOver, 1);
    if (tile.overlay) {
      const band = Math.round(tile.h * 0.2);
      color(0, 0, 0, 0.62).setFill;
      $.NSBezierPath.fillRect(rect(tile.x, tile.y + tile.h - band, tile.w, band));
      const size = Math.round(band * 0.46);
      text(tile.overlay, tile.x + 12, tile.y + tile.h - band + (band - size * 1.35) / 2, tile.w - 24, size, true, 1);
    }
    if (tile.badge) {
      const d = Math.round(Math.min(tile.w, tile.h) * 0.24);
      color(11, 87, 208, 0.95).setFill;
      $.NSBezierPath.bezierPathWithOvalInRect(rect(tile.x + 10, tile.y + 10, d, d)).fill;
      const size = Math.round(d * 0.5);
      text(tile.badge, tile.x + 10, tile.y + 10 + (d - size * 1.35) / 2, d, size, true, 1, 'center');
    }
  }
  for (const label of spec.labels || []) text(label.text, label.x, label.y, label.w, label.size, label.bold, label.shade);

  $.NSGraphicsContext.restoreGraphicsState;
  const props = $.NSDictionary.dictionaryWithObjectForKey($(spec.quality || 0.82), $.NSImageCompressionFactor);
  const data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypeJPEG, props);
  if (!data.writeToFileAtomically(spec.output, true)) throw new Error('could not write the picture');
  return 'ok';
}
`;

const run = (file: string, args: string[], timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve();
    });
  });

/** True on a Mac, where pictures can be drawn. */
export const canCompose = (): boolean => process.platform === 'darwin';

/** Draws the composition and returns it as JPEG bytes. Pictures are given as files; `files` writes them first. */
export async function compose(composition: Composition, files: Record<string, Uint8Array> = {}, timeoutMs = 20_000): Promise<Buffer> {
  if (!canCompose()) throw new Error('drawing pictures needs macOS');
  const dir = await mkdtemp(join(tmpdir(), 'mors-picture-'));
  try {
    const paths: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(files)) {
      paths[name] = join(dir, name.replace(/[^\w.-]/g, '_'));
      await writeFile(paths[name], bytes);
    }
    const output = join(dir, 'out.jpg');
    const spec = {
      ...composition,
      tiles: composition.tiles.map((tile) => ({ ...tile, path: paths[tile.path] ?? tile.path })),
      output,
    };
    await writeFile(join(dir, 'spec.json'), JSON.stringify(spec));
    await writeFile(join(dir, 'draw.js'), SCRIPT);
    await run('/usr/bin/osascript', ['-l', 'JavaScript', join(dir, 'draw.js'), join(dir, 'spec.json')], timeoutMs);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
