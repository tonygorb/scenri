import type { FastifyReply, FastifyRequest } from 'fastify';
import { existsSync, readFileSync, statSync } from 'node:fs';
import sharp from 'sharp';
import type { BrandContext, Core, GenerateRequest } from '@scenri/core';

/** Human-readable "A", "A and B", "A, B and C" for error copy. */
export function joinNames(labels: string[]): string {
  const uniq = [...new Set(labels)];
  if (uniq.length <= 1) return uniq[0] ?? '';
  return `${uniq.slice(0, -1).join(', ')} and ${uniq[uniq.length - 1]}`;
}

export function brandContext(core: Core, brandId: string): BrandContext {
  const brand = core.store.getBrand(brandId);
  if (!brand) throw new Error('brand not found');
  const assetPaths: Record<string, string> = {};
  const json = brand.json as any;
  for (const logo of json.logos ?? []) {
    const ref = String(logo.file ?? '');
    if (ref.startsWith('asset:') && core.images.has(ref.slice(6))) assetPaths[ref] = core.images.pathFor(ref.slice(6));
  }
  return { brand: brand.json, assetPaths };
}

export const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `asset:<hash>` → `<hash>`; anything else (a URL, a relative path) → null. */
export const assetHash = (ref: unknown): string | null => {
  const s = String(ref ?? '');
  return s.startsWith('asset:') ? s.slice(6) : null;
};

export const LOGO_ROLES = ['primary', 'mark', 'wordmark', 'monochrome', 'alternate'] as const;
export const LOGO_BACKGROUNDS = ['light', 'dark', 'any'] as const;

/**
 * Normalize an uploaded product shot: whatever arrived, store a PNG.
 *
 * `.rotate()` takes no argument on purpose. That form applies the EXIF
 * orientation tag, and it has to run before `.png()`, which drops the tag: a
 * shot taken in portrait on a phone otherwise stores in its sensor orientation
 * and lies on its side permanently, with nothing downstream able to recover it.
 */
export const toPng = (buf: Buffer): Promise<Buffer> => sharp(buf).rotate().png().toBuffer();

/** One standard image, for asking an engine what it charges. */
export const COST_PROBE = {
  prompt: '',
  brand: { brand: {}, assetPaths: {} },
  width: 1024,
  height: 1024,
  count: 1,
} as GenerateRequest;

/**
 * The same for a brand mark, with two differences that only matter for marks.
 *
 * `density` because a vector mark otherwise rasterizes at its intrinsic box —
 * for a favicon that is 16px, which is unusable as a reference image. The size
 * cap because a mark arriving as a 6000px export is a reference the model never
 * reads at that resolution, and every attachment is copied per generation.
 */
export const MARK_MAX_EDGE = 2048;
export const toMarkPng = (buf: Buffer): Promise<Buffer> =>
  sharp(buf, { density: 384 })
    .rotate()
    .resize({ width: MARK_MAX_EDGE, height: MARK_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();

/**
 * The half of an upload every asset route shares: read the multipart file,
 * reject the empty and the unreadable, and store the normalized bytes.
 *
 * Returns a result rather than throwing, because each caller has its own
 * 404-first ordering and its own idea of what a bad file means.
 */
export const readImagePart = async (
  core: Core,
  req: any,
  normalize: (buf: Buffer) => Promise<Buffer>,
): Promise<{ hash: string; fields: any; filename?: string } | { error: string }> => {
  const part = await req.file();
  if (!part) return { error: 'multipart file field required' };
  const buf: Buffer = await part.toBuffer();
  if (buf.length === 0) return { error: 'empty file' };
  try {
    return { hash: core.images.save(await normalize(buf)), fields: part.fields ?? {}, filename: part.filename };
  } catch {
    // sharp throws on anything it cannot decode. Without this the user gets a
    // 500 through setErrorHandler for the entirely ordinary act of dragging a
    // PDF onto a dropzone.
    return { error: 'that file is not an image we can read' };
  }
};

// A generated look's own jpg can be regenerated at the same filename (a
// rejected preview, redone). `max-age=0, must-revalidate` (an earlier fix)
// still left every already-open tab showing pre-regeneration bytes
// indefinitely — a browser that cached the URL under an old, longer-lived
// policy has no reason to ever re-ask, hard reload included in at least
// one observed browser/OS combination, and there is no way to reach into
// a user's disk cache from the server to evict the old entry. The actual
// fix is to stop reusing the same URL for different content: `mtimeQS`
// appends the file's own mtime as a query string everywhere a preview/
// reference-frame URL is built, so a regenerated file is a genuinely new
// URL the browser has never cached anything under. That makes it safe to
// cache aggressively again — correctness now comes from the URL changing,
// not from asking the server to re-check.
export const mtimeQS = (path: string) => (existsSync(path) ? `?v=${Math.round(statSync(path).mtimeMs)}` : '');
export const serveJpeg = (req: FastifyRequest, reply: FastifyReply, path: string) => {
  const etag = `"${statSync(path).mtimeMs}"`;
  reply.header('cache-control', 'public, max-age=31536000, immutable').header('etag', etag);
  if (req.headers['if-none-match'] === etag) return reply.status(304).send();
  return reply.header('content-type', 'image/jpeg').send(readFileSync(path));
};
