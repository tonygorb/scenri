import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import type { Core } from '@scenri/core';
import { driftDiff } from '../diff.js';
import { buildExportZip, EXPORT_PRESETS } from '../exportPack.js';
import { buildBrandBundle } from '../exportBrand.js';

export function registerImageRoutes(app: FastifyInstance, deps: { core: Core }): void {
  const { core } = deps;
  // ---- images / diff / export
  app.get('/api/images/:hash', async (req, reply) => {
    const hash = String((req.params as any).hash);
    if (!core.images.has(hash)) return reply.status(404).send({ error: 'image not found' });
    reply.header('content-type', 'image/png').header('cache-control', 'public, max-age=31536000, immutable');
    return reply.send(core.images.read(hash));
  });

  // upload an arbitrary image (moodboard, reference) into the content store
  app.post('/api/images', async (req, reply) => {
    const part = await (req as any).file();
    if (!part) return reply.status(400).send({ error: 'multipart file field required' });
    const buf: Buffer = await part.toBuffer();
    if (buf.length === 0) return reply.status(400).send({ error: 'empty file' });
    // .rotate() with no argument bakes in EXIF orientation, and it has to come
    // before .png(), which drops the tag. Without it a photo taken in portrait
    // on a phone is stored in its sensor orientation and lies on its side for
    // the rest of its life, because nothing downstream can recover the tag.
    // catalogImport does it in this order for the same reason.
    const png = await sharp(buf).rotate().png().toBuffer(); // normalize any input format
    return { hash: core.images.save(png) };
  });

  app.post('/api/diff', async (req, reply) => {
    const { imageA, imageB } = req.body as any;
    if (!core.images.has(String(imageA)) || !core.images.has(String(imageB)))
      return reply.status(404).send({ error: 'image not found' });
    const d = await driftDiff(core.images.read(String(imageA)), core.images.read(String(imageB)));
    const heatmapHash = core.images.save(d.heatmap);
    return { score: d.score, heatmapHash, width: d.width, height: d.height };
  });

  app.get('/api/export/presets', async () => EXPORT_PRESETS);
  /**
   * The brand as a portable `.brand` bundle.
   *
   * GET, not POST: the client is then a plain anchor with a download
   * attribute, with no blob juggling and no second copy of the filename rule.
   */
  app.get('/api/brands/:id/export', async (req, reply) => {
    const brandId = String((req.params as any).id);
    if (!core.store.getBrand(brandId)) return reply.status(404).send({ error: 'brand not found' });
    const { zip, filename } = await buildBrandBundle(core, brandId);
    reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="${filename}"`);
    return reply.send(zip);
  });

  app.post('/api/export', async (req, reply) => {
    const { imageHash, presets, baseName = 'scenri-export' } = req.body as any;
    if (!core.images.has(String(imageHash))) return reply.status(404).send({ error: 'image not found' });
    // one sanitized name for the zip entries and the header alike: a quote or
    // separator in a user-supplied name must not reach content-disposition
    const safeBase =
      String(baseName)
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .slice(0, 60) || 'export';
    const zip = await buildExportZip(
      core.images.read(String(imageHash)),
      safeBase,
      Array.isArray(presets) ? presets.map(String) : [],
    );
    reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${safeBase}.zip"`);
    return reply.send(zip);
  });
}
