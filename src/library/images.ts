import { createImageFetcher, type DownloadedImage } from '../image-fetch.ts';
import type { Reply } from '../types.ts';
import { canCompose, compose, type Composition } from './compose.ts';

/** A picture the bot sends: one cover (with the song's name to draw under it), or the daily message's collage. */
export type Picture = Extract<Reply, { kind: 'image' | 'collage' }>;

/** A picture ready to send; `captioned` says whether the song's name is drawn on it (otherwise it goes as text). */
export interface PreparedPicture {
  image: DownloadedImage;
  captioned: boolean;
}

const BACKGROUND: [number, number, number] = [18, 18, 20];
const TILE_W = 480;
const TILE_H = 270;
const GAP = 8;

const jpeg = (bytes: Buffer, fileName: string): DownloadedImage => ({
  data: new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }),
  fileName,
  mimeType: 'image/jpeg',
  bytes: bytes.byteLength,
  // Lets the simulator show the very picture the phone gets.
  sourceUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
});

/** A song's card: its cover with the title (large) and the artist under it. */
export async function drawCard(cover: Uint8Array, caption: { title: string; artist: string }): Promise<DownloadedImage> {
  const width = 720;
  const art = 405;
  const composition: Composition = {
    width,
    height: art + (caption.artist ? 110 : 76),
    background: BACKGROUND,
    tiles: [{ path: 'cover', x: 0, y: 0, w: width, h: art }],
    labels: [
      { text: caption.title, x: 24, y: art + 18, w: width - 48, size: 34, bold: true },
      ...(caption.artist ? [{ text: caption.artist, x: 24, y: art + 64, w: width - 48, size: 24, shade: 0.72 }] : []),
    ],
  };
  return jpeg(await compose(composition, { cover }), 'cover.jpg');
}

/** The daily message's picture: the covers in a grid (up to nine), each numbered, with its name over its foot. */
export async function drawCollage(items: Array<{ cover: Uint8Array; label: string; number: number }>): Promise<DownloadedImage> {
  const shown = items.slice(0, 9);
  if (shown.length === 0) throw new Error('no pictures to put together');
  const columns = shown.length <= 2 ? shown.length : shown.length <= 4 ? 2 : 3;
  const rows = Math.ceil(shown.length / columns);
  const files: Record<string, Uint8Array> = {};
  const composition: Composition = {
    width: columns * TILE_W + (columns + 1) * GAP,
    height: rows * TILE_H + (rows + 1) * GAP,
    background: BACKGROUND,
    tiles: shown.map((item, i) => {
      files[`cover${i}`] = item.cover;
      return {
        path: `cover${i}`,
        x: GAP + (i % columns) * (TILE_W + GAP),
        y: GAP + Math.floor(i / columns) * (TILE_H + GAP),
        w: TILE_W,
        h: TILE_H,
        badge: String(item.number),
        overlay: item.label,
      };
    }),
  };
  return jpeg(await compose(composition, files), 'new-music.jpg');
}

/**
 * Gets pictures ready to send. Covers are downloaded once (and remembered); a song's card is drawn with its name, and
 * the daily message's collage from all its covers. Where pictures can't be drawn (not a Mac), or drawing fails, a song
 * gets its plain cover and its name goes as text.
 */
export function createPictures(
  options: { fetchImage?: (url: string) => Promise<DownloadedImage>; draw?: boolean; log?: (line: string) => void } = {},
): (picture: Picture) => Promise<PreparedPicture> {
  const fetchImage = options.fetchImage ?? createImageFetcher();
  const draw = options.draw ?? canCompose();
  const log = options.log ?? (() => {});
  const cards = new Map<string, Promise<DownloadedImage>>();
  const bytesOf = async (url: string) => new Uint8Array(await (await fetchImage(url)).data.arrayBuffer());

  return async (picture) => {
    if (picture.kind === 'collage') {
      if (!draw) throw new Error('pictures can only be put together on a Mac');
      const items = await Promise.all(
        picture.images.map(async (item) => {
          try {
            return { cover: await bytesOf(item.url), label: item.label, number: item.number };
          } catch {
            return undefined; // one missing cover leaves a gap, not a failure
          }
        }),
      );
      return { image: await drawCollage(items.filter((item) => item !== undefined)), captioned: true };
    }
    if (picture.caption && draw) {
      const key = `${picture.url}\n${picture.caption.title}\n${picture.caption.artist}`;
      let card = cards.get(key);
      if (!card) {
        card = bytesOf(picture.url).then((cover) => drawCard(cover, picture.caption!));
        cards.set(key, card);
        card.catch(() => cards.delete(key));
        while (cards.size > 64) cards.delete(cards.keys().next().value!);
      }
      try {
        return { image: await card, captioned: true };
      } catch (err) {
        log(`could not draw the song's card, sending the plain cover: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { image: await fetchImage(picture.url), captioned: false };
  };
}
