import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { loadScenes, sceneResolver, defaultScenesDir } from './scenes.js';
import { brandJsonWithResolvedPresenters, loadPresenters } from './presenters.js';
import { brandJsonWithResolvedDemoProducts, loadDemoProducts, demoProductResolver } from './demoProducts.js';
import { compileBrief, validateBrief, FORMATS, type Brief, type BriefToken } from './brief.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Core, EngineAdapter, GenerateRequest, EditRequest, ReferenceRole } from '@scenri/core';
import { SpendCapError, ASPECT_TOLERANCE } from '@scenri/core';
import { readMeta } from './meta.js';
import { createUpdateChecker, type UpdateChecker } from './update/check.js';
import { createContentFetcher, type ContentFetcher } from './content/fetch.js';
import type { stageVersion } from './update/stage.js';
import { validateBrand, buildFromUrl, mergeScrape } from '@scenri/brand';
import type { EngineRegistry } from './engines.js';
import { brandJsonWithCatalogProducts, resolveLibraryProduct, runningImportCount } from './catalogImport.js';
import { brandSceneById, runningAssetBuildCount, type Analyzer } from './customAssets.js';
import type { CodexSetup } from '@scenri/engine-codex';
import { registerAccessGuard, type AccessOptions } from './access.js';
import { inheritedIdentityTokens } from './editIdentity.js';
import { scopeOfInstruction, type EditScope } from './editScopeRules.js';
import { brandContext, joinNames, PNG_SIG, readImagePart, toMarkPng, toPng } from './routes/shared.js';
import { registerLogoRoutes } from './routes/logos.js';
import { registerCatalogImportRoutes } from './routes/catalogImport.js';
import { registerSceneRoutes } from './routes/scenes.js';
import { registerPresenterRoutes } from './routes/presenters.js';
import { registerAssetBuildRoutes } from './routes/assetBuilds.js';
import { registerDemoProductRoutes } from './routes/demoProducts.js';
import { registerShowcaseRoutes } from './routes/showcase.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerCodexSetupRoutes } from './routes/codexSetup.js';
import { registerImageRoutes } from './routes/images.js';
import { registerUpdateRoutes } from './routes/updates.js';
import { registerSystemRoutes } from './routes/system.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Abort in-flight generations, close the server, close the database. Idempotent. */
    drain(): Promise<void>;
    /** The update checker; serve.ts starts its daily schedule after listen. */
    updates: UpdateChecker;
    /** The one-time library download; serve.ts triggers it after listen. */
    content: ContentFetcher;
  }
}

/** How this build reached the user's disk; decides which update path the UI offers. */
export type InstallKind = 'npx' | 'global' | 'managed' | 'dev' | 'unknown';

export interface ServerOptions {
  core: Core;
  engines: EngineRegistry;
  studioDist?: string; // path to built SPA; optional in tests
  fetchImpl?: typeof fetch;
  templatesDir?: string; // override for tests
  access?: AccessOptions; // host allowlist + LAN token; loopback-only by default
  /** Posture serve.ts works out from its own entry path; tests leave it unset. */
  runtime?: { installKind: InstallKind; supervised: boolean; launcherProtocol?: number };
  /** The staging function, injected in tests so no npm runs. */
  stageImpl?: typeof stageVersion;
  /** process.exit, injected in tests so the restart route can be observed. */
  exitImpl?: (code: number) => void;
  /** Reads a brand's own references into structured records. Injected in tests. */
  analyzer?: Analyzer;
  /** Installs and signs in the local Codex CLI for the setup wizard. Injected in tests. */
  codexSetup?: CodexSetup;
}

/** Settings keys exposed via the API. Secrets are write-only: reads return booleans. */
const SECRET_KEYS = ['openrouter_api_key', 'replicate_api_token', 'fal_key'];

export function buildServer(opts: ServerOptions): FastifyInstance {
  const { core, engines } = opts;
  const meta = readMeta();
  const app = Fastify({ logger: false });
  // First hook, before any route: Fastify only applies a hook to routes
  // registered after it was added.
  registerAccessGuard(app, opts.access);
  // In-flight cost reservations per engine: caps must count generations that
  // are still running, not just recorded cost_events, or N parallel requests
  // all pass the cap check against the same stale spend.
  const reserved = new Map<string, number>();
  // In-flight generations by node id, mirroring catalogImport.ts's own running
  // map: a node only ever leaves 'running' via the promise this map tracks, so
  // cancelling it is looking the controller up and aborting it.
  const runningGenerations = new Map<string, AbortController>();
  const { scenes } = loadScenes(opts.templatesDir);
  // resolves a scene by its id or by any id it used to answer to
  const resolveScene = sceneResolver(scenes);
  /**
   * The same resolver, with the brand's own scenes ahead of the catalog.
   *
   * Same precedence a brand's `characters[]` already has over the presenter
   * catalog: what you built for yourself wins. Every compileBrief call site
   * uses this, so a brief carrying a custom scene compiles through exactly the
   * same path a curated one does.
   */
  const sceneFor = (brandJson: any) => (id: string) => brandSceneById(brandJson, id) ?? resolveScene(id);
  app.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { statusCode?: number; message?: string; code?: string };
    const status = err instanceof SpendCapError ? 402 : (e.statusCode ?? 500);
    // fs errors embed absolute paths ("ENOENT: … open '/Users/…'"); the path
    // belongs in the terminal, not in a response a browser can read.
    const leaksPath = typeof e.code === 'string' && /^(ENOENT|EACCES|EPERM|EISDIR|ENOTDIR)$/.test(e.code);
    reply.status(status).send({ error: leaksPath ? 'unexpected error' : (e.message ?? 'unexpected error') });
  });

  // ---- brands
  app.get('/api/brands', async () => core.store.listBrands());
  app.post('/api/brands', async (req, reply) => {
    const json = (req.body as any)?.brand;
    const v = validateBrand(json);
    if (!v.valid) return reply.status(400).send({ error: 'invalid .brand', details: v.errors });
    return core.store.createBrand(json);
  });
  app.post('/api/brands/from-url', async (req, reply) => {
    const url = String((req.body as any)?.url ?? '');
    if (!/^https?:\/\//.test(url)) return reply.status(400).send({ error: 'url must be http(s)' });
    const { brand, warnings } = await buildFromUrl(url, {
      fetchImpl: opts.fetchImpl,
      // The store names every blob `<hash>.png` and /api/images/:hash always
      // serves image/png, so an un-normalized .ico or .svg here is a file lying
      // about its own format — broken in the marks grid, and mislabelled to any
      // engine it is later attached to.
      saveAsset: async (buf) => `asset:${core.images.save(await toMarkPng(buf))}`,
      createdWith: `${meta.name}/${meta.version}`,
    });
    const row = core.store.createBrand(brand as any);
    return { ...row, warnings };
  });
  app.put('/api/brands/:id', async (req, reply) => {
    const json = (req.body as any)?.brand;
    const v = validateBrand(json);
    if (!v.valid) return reply.status(400).send({ error: 'invalid .brand', details: v.errors });
    const row = core.store.updateBrand((req.params as any).id, json);
    return row ?? reply.status(404).send({ error: 'brand not found' });
  });
  app.delete('/api/brands/:id', async (req) => {
    core.store.deleteBrand((req.params as any).id);
    return { ok: true };
  });

  // ---- products (manual uploads to a brand's product library)
  // Characters/presenters no longer get a manual-add route: a presenter is
  // either in the curated catalog (see below) or, for older brands, already
  // sitting in `characters[]` from a cast made before that catalog existed.
  const ASSETS = {
    products: { key: 'products', prefix: 'p', fallback: 'Product' },
  } as const;
  /**
   * Two ways in, one row out.
   *
   * The multipart path is the original: one file, one product, and the client
   * has to guess which product it just made by diffing the library. The JSON
   * path takes hashes already put through POST /api/images — which normalizes
   * with the identical `sharp(buf).png()` — so a product with four angles is
   * one brand write instead of five, and the response says which id it is.
   *
   * `productId` rides beside the brand row rather than inside `json`, so the
   * schema's `additionalProperties: false` is untouched and every existing
   * caller still reads the same shape it always did.
   */
  const addAsset = (kind: keyof typeof ASSETS) => async (req: any, reply: any) => {
    const spec = ASSETS[kind];
    const brand = core.store.getBrand(req.params.id);
    if (!brand) return reply.status(404).send({ error: 'brand not found' });

    const isJson = String(req.headers['content-type'] ?? '').includes('application/json');
    let name: string;
    let hashes: string[];
    let category: string | undefined;

    if (isJson) {
      const body = (req.body ?? {}) as any;
      hashes = Array.isArray(body.imageHashes) ? body.imageHashes.map((h: unknown) => String(h)) : [];
      if (hashes.length === 0) return reply.status(400).send({ error: 'at least one image is required' });
      for (const h of hashes) {
        if (!/^[a-f0-9]{32}$/.test(h) || !core.images.has(h))
          return reply.status(400).send({ error: `unknown image ${h}` });
      }
      name =
        String(body.name ?? '')
          .trim()
          .slice(0, 80) || spec.fallback;
      const raw = body.category == null ? '' : String(body.category).slice(0, 500);
      category = raw || undefined;
    } else {
      const part = await readImagePart(core, req, toPng);
      if ('error' in part) return reply.status(400).send({ error: part.error });
      hashes = [part.hash];
      name = String(part.fields?.name?.value ?? part.filename ?? spec.fallback).slice(0, 80);
    }

    const id = `${spec.prefix}-${randomUUID().slice(0, 8)}`;
    const json = { ...(brand.json as any) };
    json[spec.key] = [
      ...(json[spec.key] ?? []),
      {
        id,
        name,
        ...(category ? { category } : {}),
        shots: hashes.map((h) => ({ file: `asset:${h}`, locked: true })),
      },
    ];
    const v = validateBrand(json);
    if (!v.valid) return reply.status(400).send({ error: 'brand became invalid', details: v.errors });
    const saved = core.store.updateBrand(brand.id, json);
    return isJson ? { ...saved, productId: id } : saved;
  };
  const removeAsset = (kind: keyof typeof ASSETS) => async (req: any, reply: any) => {
    const spec = ASSETS[kind];
    const brand = core.store.getBrand(req.params.id);
    if (!brand) return reply.status(404).send({ error: 'brand not found' });
    const json = { ...(brand.json as any) };
    json[spec.key] = (json[spec.key] ?? []).filter((x: any) => x.id !== req.params.assetId);
    return core.store.updateBrand(brand.id, json);
  };
  app.post('/api/brands/:id/products', addAsset('products'));
  app.delete('/api/brands/:id/products/:assetId', removeAsset('products'));

  /**
   * Re-scrape the brand's own website into the kit it already has.
   *
   * Not the same thing as from-url, which creates: this one merges, and the
   * merge policy (see mergeScrape) is what keeps a refresh from quietly undoing
   * an afternoon of editing. Scraped colours come back as suggestions the page
   * offers, never as a write.
   */
  app.post('/api/brands/:id/refresh-from-url', async (req, reply) => {
    const brand = core.store.getBrand((req.params as any).id);
    if (!brand) return reply.status(404).send({ error: 'brand not found' });
    const url = String((req.body as any)?.url ?? (brand.json as any)?.meta?.website ?? '');
    if (!/^https?:\/\//.test(url)) return reply.status(400).send({ error: 'url must be http(s)' });
    const { brand: scraped, warnings } = await buildFromUrl(url, {
      fetchImpl: opts.fetchImpl,
      saveAsset: async (buf) => `asset:${core.images.save(await toMarkPng(buf))}`,
      createdWith: `${meta.name}/${meta.version}`,
    });
    const { brand: merged, suggestions } = mergeScrape(brand.json, scraped);
    const v = validateBrand(merged);
    if (!v.valid) return reply.status(400).send({ error: 'brand became invalid', details: v.errors });
    const row = core.store.updateBrand(brand.id, merged as any);
    return { ...row, warnings, suggestions };
  });

  registerLogoRoutes(app, { core });

  // Manual products only: category/variant/material/dimensions, set from the
  // product's own page. Name lives here too, so renaming doesn't need a
  // second endpoint.
  app.patch('/api/brands/:id/products/:productId', async (req, reply) => {
    const brand = core.store.getBrand((req.params as any).id);
    if (!brand) return reply.status(404).send({ error: 'brand not found' });
    const productId = String((req.params as any).productId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const json = { ...(brand.json as any) };
    const products: any[] = json.products ?? [];
    const idx = products.findIndex((p) => p.id === productId);
    if (idx === -1) return reply.status(404).send({ error: 'product not found' });
    const FIELDS = ['name', 'category', 'variant', 'material', 'dimensions'] as const;
    const patch: Record<string, unknown> = {};
    for (const f of FIELDS) if (f in body) patch[f] = body[f] == null ? undefined : String(body[f]).slice(0, 500);
    json.products = products.map((p, i) => (i === idx ? { ...p, ...patch } : p));
    const v = validateBrand(json);
    if (!v.valid) return reply.status(400).send({ error: 'brand became invalid', details: v.errors });
    return core.store.updateBrand(brand.id, json);
  });
  // Add one more reference angle to a product that already exists, rather
  // than creating a new one — what the Product page's add-angle tile uploads
  // into. Works for both kinds: a manual product's shots live in the brand
  // document, an imported one's in catalog_images under a `local:` URL that
  // marks it as ours so the next import carries it across.
  app.post('/api/brands/:id/products/:productId/shots', async (req: any, reply: any) => {
    const brand = core.store.getBrand((req.params as any).id);
    if (!brand) return reply.status(404).send({ error: 'brand not found' });
    const productId = String((req.params as any).productId);
    const catalogId = productId.startsWith('cat-') ? productId.slice(4) : null;
    const json = { ...(brand.json as any) };
    const products: any[] = json.products ?? [];
    const idx = catalogId ? -1 : products.findIndex((p) => p.id === productId);
    const catalogRow = catalogId ? core.catalog.getProduct(catalogId) : null;
    if (idx === -1 && (!catalogRow || catalogRow.brandId !== brand.id)) {
      return reply.status(404).send({ error: 'product not found' });
    }
    const part = await readImagePart(core, req, toPng);
    if ('error' in part) return reply.status(400).send({ error: part.error });
    const hash = part.hash;
    const angle = part.fields?.angle?.value ? String(part.fields.angle.value).slice(0, 60) : undefined;
    if (catalogId) {
      core.catalog.addLocalImage(catalogId, `asset:${hash}`, angle ?? null);
      return core.store.getBrand(brand.id);
    }
    const shot: any = { file: `asset:${hash}`, locked: true };
    if (angle) shot.angle = angle;
    json.products = products.map((p, i) => (i === idx ? { ...p, shots: [...(p.shots ?? []), shot] } : p));
    const v = validateBrand(json);
    if (!v.valid) return reply.status(400).send({ error: 'brand became invalid', details: v.errors });
    return core.store.updateBrand(brand.id, json);
  });

  /**
   * Rewrite a product's reference set: the body is the order the user wants,
   * and anything left out is removed.
   *
   * One route rather than three, because promote, reorder and remove are the
   * same write — a product's shots are an ordered list and the compiler reads
   * meaning straight off that order (`shots[0]` is the essential reference,
   * and only the first PRODUCT_REF_MAX reach an engine at all). Additions keep
   * going through POST above; this only ever narrows or reorders what is here,
   * so it cannot smuggle in an image the product never had.
   */
  app.put('/api/brands/:id/products/:productId/shots', async (req, reply) => {
    const brand = core.store.getBrand((req.params as any).id);
    if (!brand) return reply.status(404).send({ error: 'brand not found' });
    const productId = String((req.params as any).productId);
    const body = (req.body ?? {}) as { files?: unknown };
    const files = Array.isArray(body.files) ? body.files.map((f) => String(f)) : null;
    if (!files || files.length === 0)
      return reply.status(400).send({ error: 'a product needs at least one reference' });
    if (new Set(files).size !== files.length) return reply.status(400).send({ error: 'duplicate reference' });

    if (productId.startsWith('cat-')) {
      const pid = productId.slice(4);
      const row = core.catalog.getProduct(pid);
      if (!row || row.brandId !== brand.id) return reply.status(404).send({ error: 'product not found' });
      const have = new Set(core.catalog.listImages(pid).map((i) => i.assetRef));
      if (files.some((f) => !have.has(f))) return reply.status(400).send({ error: 'unknown reference' });
      core.catalog.setImageOrder(pid, files);
      return core.store.getBrand(brand.id);
    }

    const json = { ...(brand.json as any) };
    const products: any[] = json.products ?? [];
    const idx = products.findIndex((p) => p.id === productId);
    if (idx === -1) return reply.status(404).send({ error: 'product not found' });
    const shots: any[] = products[idx].shots ?? [];
    const byFile = new Map(shots.map((s) => [s.file, s]));
    /*
     * A file may name an image the product does not currently hold, as long as
     * this machine has the image.
     *
     * Removing a reference from a manual product drops the entry but never the
     * blob — the store is content-addressed and keeps it. Refusing anything not
     * already in `shots` therefore made removal one-way for exactly the products
     * where it is most likely to be a slip, because "put it back" is naming the
     * same asset again. The guard that matters is that the asset exists at all,
     * which is the same bar `POST /products` sets for `imageHashes`.
     */
    const known = (f: string) => {
      if (byFile.has(f)) return true;
      const h = /^asset:([a-f0-9]{32})$/.exec(f)?.[1];
      return Boolean(h && core.images.has(h));
    };
    if (files.some((f) => !known(f))) return reply.status(400).send({ error: 'unknown reference' });
    // Carry each shot across whole — angle and locked belong to the image, not
    // to its position, and re-deriving them here would quietly drop them. One
    // coming back has no entry to carry, so it is rebuilt the way a fresh
    // upload arrives.
    json.products = products.map((p, i) =>
      i === idx ? { ...p, shots: files.map((f) => byFile.get(f) ?? { file: f, locked: true }) } : p,
    );
    const v = validateBrand(json);
    if (!v.valid) return reply.status(400).send({ error: 'brand became invalid', details: v.errors });
    return core.store.updateBrand(brand.id, json);
  });

  registerCatalogImportRoutes(app, { core, fetchImpl: opts.fetchImpl });

  // ---- scenes (+ their preview imagery when generated)
  const templatesRoot = opts.templatesDir ?? defaultScenesDir();
  registerSceneRoutes(app, { templatesRoot, scenes });

  // ---- presenters (curated identity catalog). A presenter attaches straight
  // into a brief like a Scene does — see brandJsonWithResolvedPresenters below.
  const presentersDir = join(templatesRoot, 'presenters');
  const { presenters } = loadPresenters(presentersDir);
  registerPresenterRoutes(app, { templatesRoot, presenters });

  // ---- custom presenters and scenes (the ones a brand builds for itself)
  //
  // These live in the brand document, not in templates/, and everything past
  // this point treats them identically to the curated ones: compileBrief
  // already prefers `characters[]` over the presenter catalog, and the scene
  // resolver below prefers `scenes[]` over the scene catalog.
  registerAssetBuildRoutes(app, { core, engines, analyzer: opts.analyzer, scenes, presenters });

  // ---- demo products (curated, fictional-but-premium product catalog). A
  // demo product attaches straight into a brief like a Presenter does — see
  // brandJsonWithResolvedDemoProducts below. Never touches a real brand's
  // own products[].
  const { demoProducts } = loadDemoProducts(join(templatesRoot, 'demo-products'));
  const demoProductById = demoProductResolver(demoProducts);
  // Thumbnail is always the category's "primary" angle (three-quarter where
  // the category has one, else front) — a slightly dimensional hero shot,
  // never a creative-campaign image. See primaryAngleFor/demoProductRefPath.
  registerDemoProductRoutes(app, { templatesRoot, demoProducts, demoProductById });

  registerShowcaseRoutes(app, { templatesRoot });

  // ---- brief compiler: the composer previews exactly what will run
  app.get('/api/formats', async () => FORMATS);
  app.post('/api/brief/preview', async (req, reply) => {
    const { brief, engineId, brandId } = req.body as any;
    const brand = core.store.getBrand(String(brandId));
    if (!brand) return reply.status(404).send({ error: 'brand not found' });
    const engine = engines.get(String(engineId));
    if (!engine) return reply.status(400).send({ error: 'unknown engine' });
    if (!brief || !Array.isArray(brief.tokens))
      return reply.status(400).send({ error: 'brief.tokens must be an array' });
    const briefErrors = validateBrief(brief);
    if (briefErrors.length) return reply.status(400).send({ error: `invalid brief: ${briefErrors.join('; ')}` });
    const brandJson = await brandJsonWithResolvedPresenters(
      core,
      templatesRoot,
      presenters,
      await brandJsonWithResolvedDemoProducts(
        core,
        templatesRoot,
        demoProducts,
        brandJsonWithCatalogProducts(core, brand.id),
        brief.tokens,
      ),
      brief.tokens,
    );
    const sceneById = sceneFor(brandJson);
    const compiled = compileBrief(brief as Brief, {
      brand: brandJson,
      images: core.images,
      engineCaps: engine.capabilities(),
      template: brief.templateId ? sceneById(String(brief.templateId)) : undefined,
      templateById: sceneById,
    });
    // paths are server-side detail; the UI works in hashes
    const { referenceImages, ...rest } = compiled;
    return { ...rest, referenceCount: referenceImages.length };
  });

  registerProjectRoutes(app, { core });

  registerCodexSetupRoutes(app, { codexSetup: opts.codexSetup });

  // ---- engines / caps / costs
  app.get('/api/engines', async () => {
    const list = [];
    for (const e of engines.all()) {
      const caps = e.capabilities();
      const avail = await e.isAvailable();
      const spend = core.ledger.monthlySpend(caps.id);
      const cap = core.ledger.capFor(caps.id);
      // Credits are generations, not dollars: probe the engine's own estimate
      // for one standard image and convert the remaining budget into runs.
      let perGeneration = 0;
      try {
        perGeneration = await e.costEstimate({
          prompt: '',
          brand: { brand: {}, assetPaths: {} },
          width: 1024,
          height: 1024,
          count: 1,
        } as any);
      } catch {
        perGeneration = 0;
      }
      // "free" here means unpriceable by us, not costless to them. See the same
      // flag on /api/asset-builds/capabilities.
      const free = perGeneration <= 0;
      const generationsLeft = free || cap === null ? null : Math.max(0, Math.floor((cap - spend) / perGeneration));
      const generationsTotal = free || cap === null ? null : Math.max(0, Math.floor(cap / perGeneration));
      list.push({
        ...caps,
        available: avail.ok,
        reason: avail.reason ?? null,
        // Which setup step would fix this, when the engine knows. The wizard
        // switches on this instead of matching on prose.
        code: avail.code ?? null,
        monthlySpend: spend,
        cap,
        free,
        perGeneration,
        generationsLeft,
        generationsTotal,
      });
    }
    return list;
  });
  app.put('/api/caps', async (req) => {
    const { engineId, capUsd } = req.body as any;
    core.ledger.setCap(String(engineId), capUsd === null ? null : Number(capUsd));
    return { ok: true };
  });
  app.get('/api/costs/summary', async () => ({ byEngine: core.ledger.totalSpendByEngine(), caps: core.ledger.caps() }));

  // ---- settings (secrets write-only)
  app.get('/api/settings', async () => {
    const all = core.store.allSettings();
    const out: Record<string, unknown> = {};
    for (const k of SECRET_KEYS) out[k] = Boolean(all[k] || process.env[k.toUpperCase()]);
    // The one non-secret: a real boolean, not an is-it-set flag.
    out.updateCheck = updates.enabled();
    return out;
  });
  app.put('/api/settings', async (req) => {
    const body = req.body as Record<string, unknown>;
    for (const k of SECRET_KEYS) if (typeof body[k] === 'string') core.store.setSetting(k, body[k] as string);
    if (typeof body.updateCheck === 'boolean') core.store.setSetting('update.enabled', String(body.updateCheck));
    return { ok: true };
  });

  // ---- nodes: async generation/edit
  async function normalizePngs(images: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const h of images) {
      const buf = core.images.read(h);
      out.push(buf.subarray(0, 8).equals(PNG_SIG) ? h : core.images.save(await sharp(buf).png().toBuffer()));
    }
    return out;
  }

  /**
   * A returned image whose shape does not match the requested shape is a
   * failed generation, not a successful one with a caveat: a 4:5 portrait
   * silently answered with a square has lost the composition the user asked
   * for. Some providers quantize to a fixed ratio menu and never say so
   * (replicate's `aspect_ratio` has no portrait option at all), so the only
   * reliable detector is measuring what actually came back.
   *
   * Shares ASPECT_TOLERANCE with the engines' own request-time refusal, so an
   * engine can never snap in a way this check would then reject.
   */
  async function assertAspect(images: string[], expect: { width: number; height: number }) {
    const want = expect.width / expect.height;
    for (const h of images) {
      const meta = await sharp(core.images.read(h)).metadata();
      if (!meta.width || !meta.height) continue;
      const got = meta.width / meta.height;
      if (Math.abs(got - want) / want > ASPECT_TOLERANCE)
        throw new Error(
          `engine returned ${meta.width}x${meta.height} for a ${expect.width}x${expect.height} request: ` +
            'this engine cannot produce the requested aspect ratio',
        );
    }
  }

  async function runNode(
    nodeId: string,
    engine: EngineAdapter,
    estimate: number,
    work: (signal: AbortSignal) => Promise<{ images: string[]; costUsd: number }>,
    expect?: { width: number; height: number },
  ) {
    const engineId = engine.capabilities().id;
    reserved.set(engineId, (reserved.get(engineId) ?? 0) + estimate);
    const ctrl = new AbortController();
    runningGenerations.set(nodeId, ctrl);
    try {
      const result = await work(ctrl.signal);
      result.images = await normalizePngs(result.images);
      if (expect) await assertAspect(result.images, expect);
      core.store.completeNode(nodeId, result);
      core.ledger.recordCost(engineId, nodeId, result.costUsd);
    } catch (err: any) {
      // the signal is the source of truth for "was this a cancel", not the
      // error shape, which differs across engines (fetch's AbortError, a
      // killed child process, a stopped poll loop)
      if (ctrl.signal.aborted) core.store.cancelNode(nodeId);
      else core.store.failNode(nodeId, String(err?.message ?? err));
    } finally {
      runningGenerations.delete(nodeId);
      const left = (reserved.get(engineId) ?? 0) - estimate;
      if (left > 1e-9) reserved.set(engineId, left);
      else reserved.delete(engineId);
    }
  }

  app.post('/api/nodes', async (req, reply) => {
    const {
      projectId,
      parentId = null,
      kind,
      prompt,
      engineId,
      count = 1,
      templateId,
      templateFields,
      productId,
      brief,
    } = req.body as any;
    let { width = 1024, height = 1024 } = req.body as any;
    const project = core.store.getProject(String(projectId));
    if (!project) return reply.status(404).send({ error: 'project not found' });
    const engine = engines.get(String(engineId));
    if (!engine) return reply.status(400).send({ error: `unknown engine ${engineId}` });
    const avail = await engine.isAvailable();
    if (!avail.ok) return reply.status(400).send({ error: avail.reason ?? 'engine unavailable' });
    if (kind !== 'generation' && kind !== 'edit')
      return reply.status(400).send({ error: 'kind must be generation|edit' });

    // A null parent would create a node the tree UI can never reach — anchor
    // parentless requests to the project root instead.
    const rootNode = core.store.treeFor(project.id).find((n) => n.kind === 'root');
    if (!rootNode) return reply.status(500).send({ error: 'project has no root node' });
    const resolvedParentId = parentId ? String(parentId) : rootNode.id;

    const ctx = brandContext(core, project.brandId);

    // Structured brief path: one compiler decides prompt, attachments and size.
    let compiled: ReturnType<typeof compileBrief> | null = null;
    /** Identity borrowed from the shot being refined, and what it attached. */
    let inheritedTokens: BriefToken[] = [];
    let inheritedAttachments: ReturnType<typeof compileBrief>['attachments'] = [];
    let editScope: EditScope = 'global';
    /** Things the route itself needs to say, alongside whatever the compiler warned about. */
    const extraWarnings: string[] = [];
    if (brief && Array.isArray(brief.tokens)) {
      const briefErrors = validateBrief(brief);
      if (briefErrors.length) return reply.status(400).send({ error: `invalid brief: ${briefErrors.join('; ')}` });
      const brandJson = await brandJsonWithResolvedPresenters(
        core,
        templatesRoot,
        presenters,
        await brandJsonWithResolvedDemoProducts(
          core,
          templatesRoot,
          demoProducts,
          brandJsonWithCatalogProducts(core, project.brandId),
          brief.tokens,
        ),
        brief.tokens,
      );
      const sceneById = sceneFor(brandJson);
      // A refinement borrows the identity of the shot it refines. Without this
      // the compiler sees a bare sentence, attaches nothing, and the product in
      // the picture has no reference to be held to.
      if (kind === 'edit') {
        const borrowed = inheritedIdentityTokens(resolvedParentId, (id) => core.store.getNode(id));
        if (borrowed.length) {
          const already = new Set(
            (brief.tokens as BriefToken[])
              .filter((t) => t.t === 'product' || t.t === 'character' || t.t === 'mark')
              .map((t) => JSON.stringify(t)),
          );
          inheritedTokens = borrowed.filter((t) => !already.has(JSON.stringify(t)));
        }
        editScope = scopeOfInstruction(
          (brief.tokens as BriefToken[])
            .filter((t): t is Extract<BriefToken, { t: 'text' }> => t.t === 'text')
            .map((t) => t.v)
            .join(' '),
        ).scope;
      }
      compiled = compileBrief(brief as Brief, {
        brand: brandJson,
        images: core.images,
        engineCaps: engine.capabilities(),
        template: brief.templateId ? sceneById(String(brief.templateId)) : undefined,
        templateById: sceneById,
        ...(kind === 'edit' ? { mode: 'edit' as const, editScope, inheritedIdentity: inheritedTokens.length > 0 } : {}),
      });
      if (!compiled.prompt.trim()) return reply.status(400).send({ error: 'the brief is empty' });

      // The identity references themselves. Compiled from a synthetic brief so
      // the compiler stays the single definition of what a token attaches, and
      // only its attachments are kept: merging the tokens into the sentence
      // would put "House Blend Maren" in front of the instruction and turn the
      // refinement back into a generation prompt.
      if (inheritedTokens.length) {
        const identity = compileBrief(
          { tokens: inheritedTokens },
          { brand: brandJson, images: core.images, engineCaps: engine.capabilities(), templateById: sceneById },
        );
        // The source image occupies a slot of its own on every adapter, and an
        // edit does not need corroborating angles: the frame in hand already
        // shows the object at the angle in play. Essential references only.
        inheritedAttachments = identity.attachments.filter((a) => a.essential);
      }
    }

    // Legacy callers send loose prompt/templateId/productId instead of a
    // brief. There used to be a second, hand-written implementation of scene
    // framing and reference collection here, and it disagreed with the
    // compiler in ways that mattered: it attached EVERY product shot where
    // compileBrief attaches a bounded, role-tagged set, and it re-assembled
    // the scene prompt by hand. Two code paths meant two behaviours drifting
    // apart. Now the legacy shape is translated into tokens and run through
    // the one compiler, so there is exactly one definition of what a brief
    // means anywhere in the product.
    let finalPrompt = String(prompt ?? '');
    let referenceImages: string[] | undefined;
    let referenceRoles: ReferenceRole[] | undefined;
    if (!compiled && (productId || templateId)) {
      if (templateId && !sceneFor(core.store.getBrand(project.brandId)?.json)(String(templateId)))
        return reply.status(400).send({ error: `unknown template ${templateId}` });
      if (productId && !resolveLibraryProduct(core, project.brandId, String(productId)))
        return reply.status(400).send({ error: 'product not found in brand' });

      const legacyTokens: BriefToken[] = [
        ...(productId ? [{ t: 'product' as const, id: String(productId) }] : []),
        ...(templateId ? [{ t: 'template' as const, id: String(templateId) }] : []),
        ...(prompt ? [{ t: 'text' as const, v: String(prompt) }] : []),
      ];
      const legacyBrief: Brief = { tokens: legacyTokens, templateFields: templateFields ?? {} };
      const brandJson = await brandJsonWithResolvedPresenters(
        core,
        templatesRoot,
        presenters,
        await brandJsonWithResolvedDemoProducts(
          core,
          templatesRoot,
          demoProducts,
          brandJsonWithCatalogProducts(core, project.brandId),
          legacyTokens,
        ),
        legacyTokens,
      );
      compiled = compileBrief(legacyBrief, {
        brand: brandJson,
        images: core.images,
        engineCaps: engine.capabilities(),
        templateById: sceneFor(brandJson),
      });
      if (productId && !compiled.attachments.some((a) => a.role === 'product'))
        return reply.status(400).send({ error: 'product has no usable shots' });
      if (!compiled.prompt.trim()) return reply.status(400).send({ error: 'the brief is empty' });
    }

    let estimate: number;
    let work: (signal: AbortSignal) => Promise<{ images: string[]; costUsd: number }>;
    // Only generations declare a target shape. An edit inherits the source
    // image's dimensions, so there is nothing to check it against.
    let expectShape: { width: number; height: number } | undefined;
    /** For an edit, which image of the parent run it was made from. */
    let editedFrom: string | null = null;

    if (compiled) {
      finalPrompt = compiled.prompt;
      referenceImages = compiled.referenceImages;
      referenceRoles = compiled.attachments.map((a) => a.role);
      width = compiled.width;
      height = compiled.height;
    }

    if (kind === 'generation') {
      const cap = engine.capabilities().maxReferenceImages;
      // An identity reference that cannot be transmitted is not a degraded
      // generation, it is a wrong one: the model invents a product or a face
      // and returns it with full confidence. Refuse instead. Style references
      // are different — losing one costs fidelity of mood, not of subject —
      // so only product/character losses are fatal here.
      const lostIdentity = engine.capabilities().placeholder
        ? []
        : (compiled?.dropped ?? []).filter((d) => d.essential);
      if (lostIdentity.length) {
        const names = joinNames(lostIdentity.map((d) => d.label));
        const kindWord = lostIdentity[0].role === 'product' ? 'product' : 'presenter';
        return reply.code(400).send({
          error: `${engine.capabilities().displayName} cannot carry enough reference images, so ${names} would be named in the prompt but never shown. The result would not be your ${kindWord}. Choose an engine that supports reference images, or remove ${names} from the brief.`,
        });
      }
      const genReq: GenerateRequest = {
        prompt: finalPrompt,
        brand: ctx,
        width: Number(width),
        height: Number(height),
        count: Math.min(Math.max(1, Number(count)), 8),
        ...(referenceImages && cap > 0 ? { referenceImages: referenceImages.slice(0, cap) } : {}),
        ...(referenceRoles && cap > 0 ? { referenceRoles: referenceRoles.slice(0, cap) } : {}),
      };
      estimate = await engine.costEstimate(genReq);
      work = (signal) => engine.generate(genReq, signal);
      expectShape = { width, height };
    } else {
      const parent = core.store.getNode(resolvedParentId);
      const srcHash = (req.body as any).sourceImage ?? parent?.images[0];
      // Which image this refinement was actually made from. A run holds several,
      // and without this the answer was thrown away the moment the request was
      // served: the provenance badge, Compare and Try again all fell back to the
      // first image, so three quarters of the refinements of a four-variant run
      // pointed at a picture they had never touched.
      editedFrom = srcHash ? String(srcHash) : null;
      if (!srcHash || !core.images.has(String(srcHash)))
        return reply.status(400).send({ error: 'edit needs a parent node with an image (sourceImage)' });
      if (!engine.capabilities().supportsEdit)
        return reply.status(400).send({ error: 'engine does not support edits' });
      // The source image occupies a slot on every adapter, so what is left for
      // identity is one fewer than the engine's budget.
      const cap = Math.max(0, engine.capabilities().maxReferenceImages - 1);
      const own = (referenceImages ?? []).map((path, i) => ({ path, role: referenceRoles?.[i] }));
      const borrowedRefs = inheritedAttachments
        .map((a) => ({ path: core.images.pathFor(a.hash), role: a.role }))
        .filter((r) => !own.some((o) => o.path === r.path));
      const editRefs = [...own, ...borrowedRefs].slice(0, cap);
      // An engine that carries nothing is not a reason to refuse: unlike a
      // generation, the subject is already in the source frame. Say so instead.
      if (cap === 0 && borrowedRefs.length)
        extraWarnings.push(
          `${engine.capabilities().displayName} cannot carry reference images, so the identity rides on the source frame alone.`,
        );

      const editReq: EditRequest = {
        instruction: finalPrompt,
        sourceImage: core.images.pathFor(String(srcHash)),
        brand: ctx,
        ...(editRefs.length ? { referenceImages: editRefs.map((r) => r.path) } : {}),
        ...(editRefs.length ? { referenceRoles: editRefs.map((r) => r.role ?? 'reference') } : {}),
      };
      // The old comment here said an edit inherits the source's dimensions so
      // there was nothing to check against. The source IS the thing to check
      // against, and without the check a refinement returned 1402x1122 from an
      // 816x1024 frame and was stored, shown, and inherited by every later step.
      const srcMeta = await sharp(core.images.read(String(srcHash))).metadata();
      if (srcMeta.width && srcMeta.height) expectShape = { width: srcMeta.width, height: srcMeta.height };
      estimate = await engine.costEstimate(editReq);
      work = (signal) => engine.edit(editReq, signal);
    }

    // throws 402 via handler; include estimates of everything still in flight
    core.ledger.assertUnderCap(engine.capabilities().id, estimate + (reserved.get(engine.capabilities().id) ?? 0));
    const node = core.store.addNode({
      projectId: project.id,
      parentId: resolvedParentId,
      kind,
      prompt: finalPrompt,
      engineId: String(engineId),
    });
    // the resolved source rides along in the brief, which is already a JSON
    // blob on the node, so the record needs no new column to be accurate
    if (brief) core.store.setBrief(node.id, editedFrom ? { ...(brief as object), sourceImage: editedFrom } : brief);
    // Fire and forget: the 202 is the answer and the node's own status carries
    // the outcome. runNode records failures itself, so a rejection here means
    // even that failed — log it, but never let it reach the process unhandled.
    void runNode(node.id, engine, estimate, work, expectShape).catch((err) =>
      app.log.error({ err }, 'node run failed'),
    );
    // Surface the compiler's warnings on the accepted node. These name real
    // fidelity risks — a scene built around a product with none attached, an
    // asset that vanished, a reference the engine could not carry — and were
    // previously computed and then dropped, visible only in the preview call.
    // A caller that skipped preview had no way to learn its brief was degraded.
    const allWarnings = [...(compiled?.warnings ?? []), ...extraWarnings];
    return reply.status(202).send(allWarnings.length ? { ...node, warnings: allWarnings } : node);
  });

  app.post('/api/nodes/:id/cancel', async (req, reply) => {
    const id = (req.params as any).id;
    const n = core.store.getNode(id);
    if (!n) return reply.status(404).send({ error: 'node not found' });
    const ctrl = runningGenerations.get(id);
    if (!ctrl) return reply.status(400).send({ error: 'not running' });
    ctrl.abort();
    return { ok: true };
  });

  app.get('/api/nodes/:id', async (req, reply) => {
    const n = core.store.getNode((req.params as any).id);
    return n ?? reply.status(404).send({ error: 'node not found' });
  });
  app.put('/api/nodes/:id/overlays', async (req, reply) => {
    const n = core.store.getNode((req.params as any).id);
    if (!n) return reply.status(404).send({ error: 'node not found' });
    const overlays = (req.body as any)?.overlays;
    if (typeof overlays !== 'object' || overlays === null || Array.isArray(overlays)) {
      return reply.status(400).send({ error: 'overlays must be an object keyed by image index' });
    }
    for (const v of Object.values(overlays)) {
      if (!Array.isArray(v)) return reply.status(400).send({ error: 'each overlay entry must be a layer array' });
    }
    if (JSON.stringify(overlays).length > 200_000) return reply.status(400).send({ error: 'overlays too large' });
    core.store.setOverlays(n.id, overlays);
    return core.store.getNode(n.id);
  });
  app.post('/api/nodes/:id/keep', async (req, reply) => {
    const n = core.store.getNode((req.params as any).id);
    if (!n) return reply.status(404).send({ error: 'node not found' });
    core.store.setKept(n.id, Boolean((req.body as any)?.kept ?? true));
    return core.store.getNode(n.id);
  });
  app.post('/api/nodes/:id/archive', async (req, reply) => {
    const n = core.store.getNode((req.params as any).id);
    if (!n) return reply.status(404).send({ error: 'node not found' });
    core.store.setArchived(n.id, Boolean((req.body as any)?.archived ?? true));
    return core.store.getNode(n.id);
  });
  // permanent — the client already restricts this to the Archived lens, but
  // the archived-only rule is enforced here too, not just in the UI
  app.delete('/api/nodes/:id', async (req, reply) => {
    const n = core.store.getNode((req.params as any).id);
    if (!n) return reply.status(404).send({ error: 'node not found' });
    if (!n.archived) return reply.status(400).send({ error: 'archive this shot before deleting it' });
    core.store.deleteNode(n.id);
    return { ok: true };
  });
  app.post('/api/nodes/delete-batch', async (req, reply) => {
    const ids = (req.body as any)?.nodeIds;
    if (!Array.isArray(ids) || ids.length === 0) return reply.status(400).send({ error: 'nodeIds required' });
    let deleted = 0;
    for (const id of ids) {
      const n = core.store.getNode(id);
      if (n?.archived) {
        core.store.deleteNode(id);
        deleted++;
      }
    }
    return { ok: true, deleted };
  });

  registerImageRoutes(app, { core });

  // ---- this machine: where the work lives, and how to get it all out
  // ---- version + lifecycle
  const runtime = opts.runtime ?? { installKind: 'unknown' as const, supervised: false };
  const updates = createUpdateChecker({ name: meta.name, store: core.store, fetchImpl: opts.fetchImpl });
  app.decorate('updates', updates);
  app.decorate('content', createContentFetcher({ store: core.store, fetchImpl: opts.fetchImpl }));
  registerUpdateRoutes(app, {
    core,
    meta,
    updates,
    runtime,
    stageImpl: opts.stageImpl,
    exitImpl: opts.exitImpl,
    busyCount: () => runningGenerations.size + runningImportCount() + runningAssetBuildCount(),
  });

  // Settle in-flight work before the process goes away (Ctrl-C, update
  // restart). Abort is the same path the cancel button takes, so every node
  // lands in 'cancelled' with its reservation released — never in the crash
  // sweep's 'interrupted' bucket.
  let drained: Promise<void> | null = null;
  app.decorate('drain', (): Promise<void> => {
    drained ??= (async () => {
      for (const ctrl of runningGenerations.values()) ctrl.abort();
      const deadline = Date.now() + 5000;
      while (runningGenerations.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await app.close();
      core.close();
    })();
    return drained;
  });

  registerSystemRoutes(app, { core });

  // ---- studio SPA
  if (opts.studioDist && existsSync(opts.studioDist)) {
    // wildcard route resolves files per request, so a rebuilt dist (new asset
    // hashes) serves without restarting the server. index.html is read per
    // request for the same reason.
    const dist = opts.studioDist;
    app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) return reply.status(404).send({ error: 'not found' });
      // index.html names content-hashed asset files, so a browser that caches
      // it is pinned to whichever bundle it first saw — a rebuild then never
      // reaches that tab, silently. Without an explicit header browsers apply
      // heuristic caching to a 200 with no cache-control, which is exactly that
      // failure. The hashed assets under /assets stay immutable; only this
      // pointer has to revalidate.
      reply
        .header('content-type', 'text/html')
        .header('cache-control', 'no-cache, must-revalidate')
        .send(readFileSync(`${dist}/index.html`, 'utf8'));
    });
  }

  return app;
}
