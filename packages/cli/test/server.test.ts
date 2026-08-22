import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core, type EngineAdapter } from '@scenri/core';
import { createDemoEngine } from '@scenri/engine-demo';
import { buildServer } from '../src/server.js';
import { waitDone as waitDoneOn } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let home: string;
let core: Core;
let app: FastifyInstance;

function registryWith(...adapters: EngineAdapter[]) {
  const byId = new Map(adapters.map((a) => [a.capabilities().id, a]));
  return { all: () => adapters, get: (id: string) => byId.get(id) ?? null };
}

const waitDone = (nodeId: string) => waitDoneOn(app, nodeId);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sc-srv-'));
  core = createCore(home);
  app = buildServer({ core, engines: registryWith(createDemoEngine((b) => core.images.save(b))) });
});
afterEach(async () => {
  await app.close();
  core.close();
  rmSync(home, { recursive: true, force: true });
});

const mkBrand = async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/brands',
    payload: { brand: { specVersion: '0.1', meta: { name: 'Acme' }, palette: { primary: { hex: '#1F3D2B' } } } },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
};
const mkProject = async (brandId: string) => {
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { brandId, name: 'camp' } });
  return res.json();
};

/** One multipart body with a file part plus optional plain text fields. */
const filePayload = (file: Buffer, filename: string, contentType: string, fields: Record<string, string> = {}) => {
  const boundary = '----sctest';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
};
// 1x1 red gif — deliberately not a png, so normalization is exercised
const GIF_1PX = Buffer.from('R0lGODlhAQABAIAAAP8AAAAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
// A second, genuinely different image: the store is content-addressed, so two
// uploads of the same bytes are one asset and cannot be told apart by hash.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('brand marks', () => {
  const uploadLogo = async (brandId: string, fields: Record<string, string> = {}, file = GIF_1PX) =>
    app.inject({
      method: 'POST',
      url: `/api/brands/${brandId}/logos`,
      ...filePayload(file, 'logo.gif', 'image/gif', fields),
    });

  it('uploads a mark as a normalized asset ref and leaves the rest of the kit alone', async () => {
    const brand = await mkBrand();
    const res = await uploadLogo(brand.id);
    expect(res.statusCode).toBe(200);
    const json = res.json().json;
    expect(json.logos).toHaveLength(1);
    expect(json.logos[0].file).toMatch(/^asset:[0-9a-f]{32,}$/);
    // First mark is the primary; nothing else about the brand moved
    expect(json.logos[0]).toMatchObject({ role: 'primary', background: 'any' });
    expect(json.palette.primary.hex).toBe('#1F3D2B');
    expect(json.products).toBeUndefined();

    const served = await app.inject({ method: 'GET', url: `/api/images/${json.logos[0].file.slice(6)}` });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
  });

  it('defaults the second mark to alternate, and honours an explicit role', async () => {
    const brand = await mkBrand();
    await uploadLogo(brand.id);
    const second = await uploadLogo(brand.id, { role: 'wordmark', background: 'dark' }, PNG_1PX);
    expect(second.json().json.logos.map((l: any) => l.role)).toEqual(['primary', 'wordmark']);
    expect(second.json().json.logos[1].background).toBe('dark');
    const third = await app.inject({
      method: 'POST',
      url: `/api/brands/${brand.id}/logos`,
      ...filePayload(Buffer.from('other-bytes-entirely'), 'x.png', 'image/png'),
    });
    expect(third.statusCode).toBe(400);
    expect(third.json().error).toMatch(/not an image/);
  });

  it('rejects an unknown role rather than writing a document the schema will refuse', async () => {
    const brand = await mkBrand();
    const res = await uploadLogo(brand.id, { role: 'favicon' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unknown logo role/);
    const after = await app.inject({ method: 'GET', url: '/api/brands' });
    expect(after.json()[0].json.logos ?? []).toEqual([]);
  });

  it('patches and deletes by content hash, not by position', async () => {
    const brand = await mkBrand();
    await uploadLogo(brand.id);
    const second = await uploadLogo(brand.id, { role: 'mark' }, PNG_1PX);
    const [first, mark] = second.json().json.logos;
    const firstHash = first.file.slice(6);
    const markHash = mark.file.slice(6);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/brands/${brand.id}/logos/${markHash}`,
      payload: { background: 'light', clearSpace: '1x logo height' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().json.logos[1]).toMatchObject({ background: 'light', clearSpace: '1x logo height' });
    expect(patched.json().json.logos[0].background).toBe('any');

    // Clearing prose removes the key: '' would fail schema validation and take
    // the whole document down with it.
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/brands/${brand.id}/logos/${markHash}`,
      payload: { clearSpace: '' },
    });
    expect(cleared.json().json.logos[1].clearSpace).toBeUndefined();

    const gone = await app.inject({ method: 'DELETE', url: `/api/brands/${brand.id}/logos/${firstHash}` });
    expect(gone.statusCode).toBe(200);
    expect(gone.json().json.logos.map((l: any) => l.file.slice(6))).toEqual([markHash]);

    const missing = await app.inject({ method: 'DELETE', url: `/api/brands/${brand.id}/logos/nope` });
    expect(missing.statusCode).toBe(404);
  });

  it('refreshes from the website without undoing a single edit', async () => {
    const html = `<html><head><title>Zen Tea Company</title><meta name="description" content="Buy tea online"><meta name="theme-color" content="#2A6F4E"><link rel="icon" href="/i.gif"></head></html>`;
    const fetchImpl = (async (input: any) =>
      String(input).endsWith('/i.gif') ? new Response(GIF_1PX) : new Response(html)) as unknown as typeof fetch;
    const srv = buildServer({ core, engines: registryWith(), fetchImpl });
    const made = await srv.inject({
      method: 'POST',
      url: '/api/brands',
      payload: {
        brand: {
          specVersion: '0.1',
          meta: { name: 'Zen', tagline: 'Slow mornings' },
          palette: { primary: { hex: '#000000', name: 'Ink' } },
          rules: { never: ['competitor logos in frame'] },
        },
      },
    });
    const brand = made.json();
    const res = await srv.inject({
      method: 'POST',
      url: `/api/brands/${brand.id}/refresh-from-url`,
      payload: { url: 'https://zen.example' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.json.meta.name).toBe('Zen');
    expect(body.json.meta.tagline).toBe('Slow mornings');
    expect(body.json.meta.website).toBe('https://zen.example');
    expect(body.json.palette).toEqual({ primary: { hex: '#000000', name: 'Ink' } });
    expect(body.json.rules).toEqual({ never: ['competitor logos in frame'] });
    // The scraped colours are offered, not applied
    expect(body.suggestions.palette).toEqual([{ hex: '#2a6f4e' }]);
    expect(body.json.logos).toHaveLength(1);
    await srv.close();
  });

  it('reports the brand rules the compiler appends to every shot', async () => {
    const brand = await mkBrand();
    // A palette alone reaches no prompt: colours arrive as chips the user picks.
    const empty = await app.inject({ method: 'GET', url: `/api/brands/${brand.id}/directives` });
    expect(empty.json().directives).toEqual([]);

    await app.inject({
      method: 'PUT',
      url: `/api/brands/${brand.id}`,
      payload: {
        brand: {
          ...brand.json,
          imagery: { mood: 'crafted, tactile', avoid: ['neon'] },
          rules: { never: ['competitor logos in frame'] },
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: `/api/brands/${brand.id}/directives` });
    // Only the rules — never the palette, and never art direction a user cannot
    // set and nobody could write.
    expect(res.json().directives).toEqual(['Brand rules — never: competitor logos in frame.']);

    // And they apply to a brief that asked for nothing at all.
    const preview = await app.inject({
      method: 'POST',
      url: '/api/brief/preview',
      payload: { brandId: brand.id, engineId: 'demo', brief: { tokens: [{ t: 'text', v: 'a mug on a table' }] } },
    });
    expect(preview.statusCode).toBe(200);
    for (const line of res.json().directives) expect(preview.json().prompt).toContain(line);
    expect(preview.json().prompt).not.toContain('Brand palette:');
    expect(preview.json().prompt).not.toContain('Brand look');
  });

  it('serves the brand as a .brand zip named after its slug', async () => {
    const brand = await mkBrand();
    await uploadLogo(brand.id);
    const res = await app.inject({ method: 'GET', url: `/api/brands/${brand.id}/export` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="acme.brand"');
    expect(res.rawPayload.subarray(0, 2).toString()).toBe('PK');

    const missing = await app.inject({ method: 'GET', url: '/api/brands/nope/export' });
    expect(missing.statusCode).toBe(404);
  });

  it('404s directives for a brand that does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/brands/nope/directives' });
    expect(res.statusCode).toBe(404);
  });

  it('re-uploading the same artwork retags it instead of creating a twin no hash can address', async () => {
    const brand = await mkBrand();
    await uploadLogo(brand.id);
    const again = await uploadLogo(brand.id, { role: 'monochrome', background: 'dark' });
    expect(again.json().json.logos).toHaveLength(1);
    expect(again.json().json.logos[0]).toMatchObject({ role: 'monochrome', background: 'dark' });
  });
});

describe('brands API', () => {
  it('rejects invalid brand json', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/brands',
      payload: { brand: { specVersion: '0.1', meta: {} } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.length).toBeGreaterThan(0);
  });
  it('creates from URL via injected fetch, saving logo asset', async () => {
    const html = `<html><head><title>Zen Tea</title><meta name="theme-color" content="#2A6F4E"><link rel="icon" href="/i.png"></head></html>`;
    const fetchImpl = (async (input: any) =>
      String(input).endsWith('/i.png') ? new Response(GIF_1PX) : new Response(html)) as unknown as typeof fetch;
    const srv = buildServer({ core, engines: registryWith(), fetchImpl });
    const res = await srv.inject({
      method: 'POST',
      url: '/api/brands/from-url',
      payload: { url: 'https://zen.example' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.json.meta.name).toBe('Zen Tea');
    expect(body.json.logos[0].file).toMatch(/^asset:[a-f0-9]{32}$/);
    // A scraped mark is stored as a real PNG, not as raw favicon bytes wearing
    // a .png name — the store and /api/images both claim image/png regardless.
    const served = await srv.inject({ method: 'GET', url: `/api/images/${body.json.logos[0].file.slice(6)}` });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await srv.close();
  });
  it('degrades to a warning when the scraped favicon is not a decodable image', async () => {
    const html = `<html><head><title>Zen Tea</title><link rel="icon" href="/i.ico"></head></html>`;
    const fetchImpl = (async (input: any) =>
      String(input).endsWith('/i.ico')
        ? new Response(Buffer.from([1, 2, 3]))
        : new Response(html)) as unknown as typeof fetch;
    const srv = buildServer({ core, engines: registryWith(), fetchImpl });
    const res = await srv.inject({
      method: 'POST',
      url: '/api/brands/from-url',
      payload: { url: 'https://zen.example' },
    });
    expect(res.statusCode).toBe(200);
    // No logo is better than a logo that renders as a broken image everywhere
    expect(res.json().json.logos).toBeUndefined();
    expect(res.json().warnings.join(' ')).toMatch(/logo/i);
    await srv.close();
  });
  it('rejects non-http url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/brands/from-url',
      payload: { url: 'file:///etc/passwd' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('generation flow', () => {
  it('generate -> done with images; edit child; keep; tree', async () => {
    const brand = await mkBrand();
    const { project, root } = await mkProject(brand.id);

    const gen = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      payload: {
        projectId: project.id,
        parentId: root.id,
        kind: 'generation',
        prompt: 'hero',
        engineId: 'demo',
        count: 2,
        width: 256,
        height: 256,
      },
    });
    expect(gen.statusCode).toBe(202);
    const genNode = await waitDone(gen.json().id);
    expect(genNode.status).toBe('done');
    expect(genNode.images).toHaveLength(2);

    const img = await app.inject({ method: 'GET', url: `/api/images/${genNode.images[0]}` });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');

    const edit = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { projectId: project.id, parentId: genNode.id, kind: 'edit', prompt: 'warmer', engineId: 'demo' },
    });
    expect(edit.statusCode).toBe(202);
    const editNode = await waitDone(edit.json().id);
    expect(editNode.status).toBe('done');
    expect(editNode.parentId).toBe(genNode.id);

    const kept = await app.inject({ method: 'POST', url: `/api/nodes/${editNode.id}/keep`, payload: { kept: true } });
    expect(kept.json().kept).toBe(true);

    const tree = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/tree` });
    expect(tree.json().nodes).toHaveLength(3);
  });

  // A refinement used to compile to a bare sentence: no product reference, no
  // presenter reference, and so none of the fidelity language keyed on them.
  // The product in the picture had nothing to be held to.
  describe('a refinement keeps the shot it refines', () => {
    const briefWithProduct = () => ({
      tokens: [
        { t: 'format', id: 'square', w: 1024, h: 1024 },
        { t: 'product', id: 'p1' },
        { t: 'text', v: 'on a stone ledge' },
      ],
    });

    const seedBrand = async () => {
      const hash = core.images.save(PNG_1PX);
      const res = await app.inject({
        method: 'POST',
        url: '/api/brands',
        payload: {
          brand: {
            specVersion: '0.1',
            meta: { name: 'Acme' },
            palette: { primary: { hex: '#1F3D2B' } },
            products: [
              { id: 'p1', name: 'House Blend', shots: [{ file: `asset:${hash}`, angle: 'front', locked: true }] },
            ],
          },
        },
      });
      return { brand: res.json(), hash };
    };

    it('borrows the parent shot identity and says what must not move', async () => {
      const { brand } = await seedBrand();
      const { project } = await mkProject(brand.id);
      const gen = await app.inject({
        method: 'POST',
        url: '/api/nodes',
        payload: { projectId: project.id, kind: 'generation', engineId: 'demo', brief: briefWithProduct() },
      });
      const genNode = await waitDone(gen.json().id);

      const edit = await app.inject({
        method: 'POST',
        url: '/api/nodes',
        payload: {
          projectId: project.id,
          parentId: genNode.id,
          kind: 'edit',
          engineId: 'demo',
          sourceImage: genNode.images[0],
          brief: { tokens: [{ t: 'text', v: 'remove the cup on the left' }] },
        },
      });
      expect(edit.statusCode).toBe(202);
      const editNode = await waitDone(edit.json().id);

      // The instruction still reads as the user wrote it, and the preservation
      // clause is there to say the picture in hand is the shot.
      expect(editNode.prompt).toContain('remove the cup on the left');
      expect(editNode.prompt).toContain('This is a change to a photograph that already exists');
      expect(editNode.prompt).toContain('Change only what was asked for');
      // Identity came along, and it is named as identity rather than as a
      // reason to build a new composition.
      expect(editNode.prompt).toContain('the same product and the same person that are already in this picture');
      // And the product name is not prepended onto the instruction.
      expect(editNode.prompt.indexOf('remove the cup')).toBeLessThan(
        editNode.prompt.indexOf('This is a change to a photograph'),
      );
    });

    it('tells a whole frame change that it may move the frame, and a local one that it may not', async () => {
      const { brand } = await seedBrand();
      const { project } = await mkProject(brand.id);
      const gen = await app.inject({
        method: 'POST',
        url: '/api/nodes',
        payload: { projectId: project.id, kind: 'generation', engineId: 'demo', brief: briefWithProduct() },
      });
      const genNode = await waitDone(gen.json().id);

      const global = await app.inject({
        method: 'POST',
        url: '/api/nodes',
        payload: {
          projectId: project.id,
          parentId: genNode.id,
          kind: 'edit',
          engineId: 'demo',
          sourceImage: genNode.images[0],
          brief: { tokens: [{ t: 'text', v: 'make it nighttime' }] },
        },
      });
      const globalNode = await waitDone(global.json().id);
      expect(globalNode.prompt).toContain('Apply the instruction to the image you were given');
      expect(globalNode.prompt).not.toContain('Change only what was asked for');
    });
  });

  it('edit without parent image -> 400; unknown engine -> 400', async () => {
    const brand = await mkBrand();
    const { project, root } = await mkProject(brand.id);
    const noImg = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { projectId: project.id, parentId: root.id, kind: 'edit', prompt: 'x', engineId: 'demo' },
    });
    expect(noImg.statusCode).toBe(400);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { projectId: project.id, kind: 'generation', prompt: 'x', engineId: 'nope' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('spend cap blocks with 402', async () => {
    const paid: EngineAdapter = {
      capabilities: () => ({
        id: 'paid',
        displayName: 'Paid',
        localOnly: false,
        supportsEdit: false,
        supportsMask: false,
        maxReferenceImages: 0,
      }),
      isAvailable: async () => ({ ok: true }),
      costEstimate: async () => 0.5,
      generate: async () => ({ images: [], costUsd: 0.5 }),
      edit: async () => ({ images: [], costUsd: 0.5 }),
    };
    const srv = buildServer({ core, engines: registryWith(paid) });
    core.ledger.setCap('paid', 0.3);
    const brand = await mkBrand();
    const proj = await srv.inject({ method: 'POST', url: '/api/projects', payload: { brandId: brand.id, name: 'p' } });
    const res = await srv.inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { projectId: proj.json().project.id, kind: 'generation', prompt: 'x', engineId: 'paid' },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toMatch(/Spend cap/);
    await srv.close();
  });
});

describe('diff + export + settings', () => {
  it('diff scores identical images 0 and different images > 0, saves heatmap', async () => {
    const brand = await mkBrand();
    const { project, root } = await mkProject(brand.id);
    const gen = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      payload: {
        projectId: project.id,
        parentId: root.id,
        kind: 'generation',
        prompt: 'a vs b',
        engineId: 'demo',
        count: 2,
        width: 128,
        height: 128,
      },
    });
    const node = await waitDone(gen.json().id);
    const same = await app.inject({
      method: 'POST',
      url: '/api/diff',
      payload: { imageA: node.images[0], imageB: node.images[0] },
    });
    expect(same.json().score).toBe(0);
    const diff = await app.inject({
      method: 'POST',
      url: '/api/diff',
      payload: { imageA: node.images[0], imageB: node.images[1] },
    });
    expect(diff.json().score).toBeGreaterThan(0);
    expect(core.images.has(diff.json().heatmapHash)).toBe(true);
  });

  it('export returns a zip with selected presets', async () => {
    const brand = await mkBrand();
    const { project, root } = await mkProject(brand.id);
    const gen = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      payload: {
        projectId: project.id,
        parentId: root.id,
        kind: 'generation',
        prompt: 'x',
        engineId: 'demo',
        width: 128,
        height: 128,
      },
    });
    const node = await waitDone(gen.json().id);
    const res = await app.inject({
      method: 'POST',
      url: '/api/export',
      payload: { imageHash: node.images[0], presets: ['original', 'banner'], baseName: 'acme hero!' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });

  it('review fixes: null parent anchors to root; in-flight reservations enforce cap; non-PNG normalized', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: EngineAdapter = {
      capabilities: () => ({
        id: 'slow',
        displayName: 'Slow',
        localOnly: false,
        supportsEdit: false,
        supportsMask: false,
        maxReferenceImages: 0,
      }),
      isAvailable: async () => ({ ok: true }),
      costEstimate: async () => 0.4,
      generate: async () => {
        await gate;
        const jpeg = await (await import('sharp'))
          .default({ create: { width: 8, height: 8, channels: 3, background: '#aa3311' } })
          .jpeg()
          .toBuffer();
        return { images: [core.images.save(jpeg)], costUsd: 0.4 };
      },
      edit: async () => ({ images: [], costUsd: 0 }),
    };
    const srv = buildServer({ core, engines: registryWith(slow) });
    core.ledger.setCap('slow', 0.5);
    const brand = await mkBrand();
    const proj = (
      await srv.inject({ method: 'POST', url: '/api/projects', payload: { brandId: brand.id, name: 'p' } })
    ).json();

    // no parentId → anchored to root, not null
    const first = await srv.inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { projectId: proj.project.id, kind: 'generation', prompt: 'a', engineId: 'slow' },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().parentId).toBe(proj.root.id);

    // second request while first still in flight → reservation pushes past cap → 402
    const second = await srv.inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { projectId: proj.project.id, kind: 'generation', prompt: 'b', engineId: 'slow' },
    });
    expect(second.statusCode).toBe(402);

    release();
    const app0 = app;
    app = srv; // waitDone helper uses `app`
    const done = await waitDone(first.json().id);
    app = app0;
    // engine emitted JPEG; server must have normalized the stored image to PNG
    const stored = core.images.read(done.images[0]);
    expect(stored.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    // after completion the reservation is released → next request passes again... but spend (0.4)+est(0.4)>cap(0.5) → still 402 via recorded cost
    const third = await srv.inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { projectId: proj.project.id, kind: 'generation', prompt: 'c', engineId: 'slow' },
    });
    expect(third.statusCode).toBe(402);
    await srv.close();
  });

  it('overlays: round-trip, validation, 404', async () => {
    const brand = await mkBrand();
    const { project, root } = await mkProject(brand.id);
    const gen = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      payload: {
        projectId: project.id,
        parentId: root.id,
        kind: 'generation',
        prompt: 'x',
        engineId: 'demo',
        width: 64,
        height: 64,
      },
    });
    const node = await waitDone(gen.json().id);

    const layers = [
      {
        id: 'l1',
        text: 'Built to move.',
        x: 10,
        y: 8,
        width: 60,
        fontId: 'inter-tight',
        size: 72,
        weight: 700,
        color: '#ffffff',
        align: 'left',
        lineHeight: 1.1,
        opacity: 1,
        shadow: null,
      },
    ];
    const put = await app.inject({
      method: 'PUT',
      url: `/api/nodes/${node.id}/overlays`,
      payload: { overlays: { '0': layers } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().overlays['0'][0].text).toBe('Built to move.');

    const refetched = await app.inject({ method: 'GET', url: `/api/nodes/${node.id}` });
    expect(refetched.json().overlays['0']).toHaveLength(1);

    expect(
      (await app.inject({ method: 'PUT', url: `/api/nodes/${node.id}/overlays`, payload: { overlays: [1] } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/nodes/${node.id}/overlays`,
          payload: { overlays: { '0': 'nope' } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/nodes/00000000-0000-0000-0000-000000000000/overlays',
          payload: { overlays: {} },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('images: upload normalizes to png and serves back', async () => {
    // 1x1 red gif, deliberately not a png, so the normalize step is exercised
    const gif = Buffer.from('R0lGODlhAQABAIAAAP8AAAAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
    const boundary = '----btupload';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ref.gif"\r\nContent-Type: image/gif\r\n\r\n`,
      ),
      gif,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({
      method: 'POST',
      url: '/api/images',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(up.statusCode).toBe(200);
    const { hash } = up.json();
    expect(hash).toMatch(/^[0-9a-f]{32,}$/);

    const got = await app.inject({ method: 'GET', url: `/api/images/${hash}` });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.rawPayload.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    // multipart with no file part at all: our own guard, not the plugin's
    const fieldsOnly = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhi\r\n--${boundary}--\r\n`,
    );
    const bad = await app.inject({
      method: 'POST',
      url: '/api/images',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: fieldsOnly,
    });
    expect(bad.statusCode).toBe(400);
  });

  // A phone stores a portrait photo in its sensor orientation and records the
  // turn in an EXIF tag. Encoding straight to PNG drops that tag, so without
  // applying it first the picture lies on its side forever and nothing
  // downstream can tell that it should not.
  it('bakes in EXIF orientation on upload, so a phone photo is not stored sideways', async () => {
    const sharp = (await import('sharp')).default;
    // 40 wide by 20 tall, tagged "rotate 90" — upright it is 20 by 40.
    const sideways = await sharp({
      create: { width: 40, height: 20, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const boundary = '----scexif';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="phone.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      sideways,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({
      method: 'POST',
      url: '/api/images',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(up.statusCode).toBe(200);

    const stored = await sharp(core.images.read(up.json().hash)).metadata();
    expect({ width: stored.width, height: stored.height }).toEqual({ width: 20, height: 40 });
  });

  it('activity: every project in the brand, named, root excluded', async () => {
    const brand = await mkBrand();
    const other = await mkBrand();
    const a = await mkProject(brand.id);
    const b = await mkProject(brand.id);
    const away = await mkProject(other.id);

    const gen = async (p: any, prompt: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/nodes',
        payload: {
          projectId: p.project.id,
          parentId: p.root.id,
          kind: 'generation',
          prompt,
          engineId: 'demo',
          width: 64,
          height: 64,
        },
      });
      return waitDone(res.json().id);
    };
    const inA = await gen(a, 'first');
    const inB = await gen(b, 'second');
    const elsewhere = await gen(away, 'not mine');

    const res = await app.inject({ method: 'GET', url: `/api/brands/${brand.id}/activity` });
    expect(res.statusCode).toBe(200);
    const ids = res.json().nodes.map((n: any) => n.id);
    expect(ids).toContain(inA.id);
    expect(ids).toContain(inB.id);
    // another brand's work, and the project roots, are not activity
    expect(ids).not.toContain(elsewhere.id);
    expect(res.json().nodes.every((n: any) => n.kind !== 'root')).toBe(true);
    // every row carries its sets without a second request, and none is fine
    expect(res.json().nodes.every((n: any) => Array.isArray(n.setNames))).toBe(true);
    expect(res.json().jobs).toEqual([]);

    const missing = await app.inject({ method: 'GET', url: '/api/brands/nope/activity' });
    expect(missing.statusCode).toBe(404);
  });

  it('workspace: one request for the shots, the sets and who is in what', async () => {
    const brand = await mkBrand();
    const ws = await app.inject({ method: 'GET', url: `/api/brands/${brand.id}/workspace` });
    expect(ws.statusCode).toBe(200);
    // the brand had no project at all: asking is what makes the one
    expect(ws.json().project.brandId).toBe(brand.id);
    expect(ws.json().sets).toEqual([]);
    expect(ws.json().membership).toEqual({});

    const again = await app.inject({ method: 'GET', url: `/api/brands/${brand.id}/workspace` });
    expect(again.json().project.id).toBe(ws.json().project.id);

    const missing = await app.inject({ method: 'GET', url: '/api/brands/nope/workspace' });
    expect(missing.statusCode).toBe(404);
  });

  it('sets: create, rename, add a shot, and delete without taking the shot with it', async () => {
    const brand = await mkBrand();
    const ws = await app.inject({ method: 'GET', url: `/api/brands/${brand.id}/workspace` });
    const projectId = ws.json().project.id;
    const shot = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { projectId, kind: 'generation', prompt: 'a shot', engineId: 'demo', width: 64, height: 64 },
    });
    const nodeId = shot.json().id;

    const made = await app.inject({ method: 'POST', url: `/api/brands/${brand.id}/sets`, payload: { name: 'Spring' } });
    expect(made.statusCode).toBe(200);
    expect(made.json().slug).toBe('spring');
    const setId = made.json().id;

    // a set with no name is not a set
    const unnamed = await app.inject({ method: 'POST', url: `/api/brands/${brand.id}/sets`, payload: { name: '  ' } });
    expect(unnamed.statusCode).toBe(400);

    const added = await app.inject({ method: 'POST', url: `/api/sets/${setId}/nodes`, payload: { nodeIds: [nodeId] } });
    expect(added.json()).toEqual({ ok: true, added: 1 });
    const withShot = await app.inject({ method: 'GET', url: `/api/brands/${brand.id}/workspace` });
    expect(withShot.json().membership[setId]).toEqual([nodeId]);

    const renamed = await app.inject({ method: 'PATCH', url: `/api/sets/${setId}`, payload: { name: 'Autumn' } });
    expect(renamed.json().name).toBe('Autumn');
    expect(renamed.json().slug).toBe('autumn');

    // a shot id nobody knows is refused rather than quietly stored
    const bogus = await app.inject({ method: 'POST', url: `/api/sets/${setId}/nodes`, payload: { nodeIds: ['nope'] } });
    expect(bogus.statusCode).toBe(400);

    await app.inject({ method: 'DELETE', url: `/api/sets/${setId}/nodes/${nodeId}` });
    const emptied = await app.inject({ method: 'GET', url: `/api/brands/${brand.id}/workspace` });
    expect(emptied.json().membership[setId]).toBeUndefined();
    // removing from a set is not deleting: the shot is still on the feed
    expect(emptied.json().nodes.some((n: any) => n.id === nodeId)).toBe(true);

    expect((await app.inject({ method: 'DELETE', url: `/api/sets/${setId}` })).json()).toEqual({ ok: true });
    const gone = await app.inject({ method: 'GET', url: `/api/brands/${brand.id}/workspace` });
    expect(gone.json().sets).toEqual([]);
    expect(gone.json().nodes.some((n: any) => n.id === nodeId)).toBe(true);

    expect((await app.inject({ method: 'PATCH', url: '/api/sets/nope', payload: { name: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/sets/nope' })).statusCode).toBe(404);
  });

  it('wiping shots takes the sets with them, so no name is left pointing at nothing', async () => {
    const brand = await mkBrand();
    await app.inject({ method: 'GET', url: `/api/brands/${brand.id}/workspace` });
    await app.inject({ method: 'POST', url: `/api/brands/${brand.id}/sets`, payload: { name: 'Spring' } });

    const wiped = await app.inject({ method: 'DELETE', url: '/api/data?scope=shots' });
    expect(wiped.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: `/api/brands/${brand.id}/sets` });
    expect(after.json()).toEqual([]);
  });

  it('settings: secrets write-only', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { openrouter_api_key: 'sk-secret' } });
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.json().openrouter_api_key).toBe(true);
    expect(JSON.stringify(res.json())).not.toContain('sk-secret');
  });
});

describe('codex setup', () => {
  /** A scripted stand-in for the local Codex CLI, so no test touches a real binary. */
  function fakeSetup(states: ('not-installed' | 'not-authenticated' | 'ready')[]) {
    const seen = { install: 0, login: 0 };
    let i = 0;
    return {
      seen,
      setup: {
        status: async () => ({ state: states[Math.min(i, states.length - 1)] }),
        install: async () => {
          seen.install++;
          i++;
          return { ok: true };
        },
        login: async () => {
          seen.login++;
          i++;
          return { ok: true };
        },
      },
    };
  }

  it('reports the state the wizard switches on', async () => {
    const { setup } = fakeSetup(['not-installed']);
    const local = buildServer({ core, engines: registryWith(), codexSetup: setup });
    const res = await local.inject({ method: 'GET', url: '/api/engines/codex/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'not-installed' });
    await local.close();
  });

  it('installs, then reports what the probe now says', async () => {
    const { setup, seen } = fakeSetup(['not-installed', 'not-authenticated']);
    const local = buildServer({ core, engines: registryWith(), codexSetup: setup });
    const res = await local.inject({ method: 'POST', url: '/api/engines/codex/install' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, state: 'not-authenticated' });
    expect(seen.install).toBe(1);
    await local.close();
  });

  it('signs in, then reports ready', async () => {
    const { setup, seen } = fakeSetup(['not-authenticated', 'ready']);
    const local = buildServer({ core, engines: registryWith(), codexSetup: setup });
    const res = await local.inject({ method: 'POST', url: '/api/engines/codex/login' });
    expect(res.json()).toEqual({ ok: true, state: 'ready' });
    expect(seen.login).toBe(1);
    await local.close();
  });

  it('refuses a second setup run while one is in flight', async () => {
    // Two concurrent global installs fight over the same npm prefix.
    // definite-assignment: the Promise executor runs synchronously, but TS's
    // narrowing can't see that and pins a `| null` initializer to null
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const setup = {
      status: async () => ({ state: 'not-installed' as const }),
      install: async () => {
        await gate;
        return { ok: true };
      },
      login: async () => ({ ok: true }),
    };
    const local = buildServer({ core, engines: registryWith(), codexSetup: setup });
    const first = local.inject({ method: 'POST', url: '/api/engines/codex/install' });
    // let the first request take the lock before the second arrives
    await new Promise((r) => setTimeout(r, 10));
    const second = await local.inject({ method: 'POST', url: '/api/engines/codex/install' });
    expect(second.statusCode).toBe(409);
    release();
    await first;
    await local.close();
  });

  it('tells /api/engines which step an engine is missing', async () => {
    const stub: EngineAdapter = {
      capabilities: () => ({
        id: 'codex-cli',
        displayName: 'Codex CLI',
        localOnly: true,
        supportsEdit: true,
        supportsMask: false,
        maxReferenceImages: 6,
      }),
      isAvailable: async () => ({ ok: false, reason: 'not signed in', code: 'not-authenticated' as const }),
      costEstimate: async () => 0,
      generate: async () => ({ images: [], costUsd: 0 }),
      edit: async () => ({ images: [], costUsd: 0 }),
    };
    const local = buildServer({ core, engines: registryWith(stub) });
    const res = await local.inject({ method: 'GET', url: '/api/engines' });
    expect(res.json()[0]).toMatchObject({ available: false, code: 'not-authenticated' });
    await local.close();
  });

  it('reports no code for an engine whose fix is just a key', async () => {
    const local = buildServer({ core, engines: registryWith(createDemoEngine((b) => core.images.save(b))) });
    const res = await local.inject({ method: 'GET', url: '/api/engines' });
    expect(res.json()[0].code).toBeNull();
    await local.close();
  });
});
