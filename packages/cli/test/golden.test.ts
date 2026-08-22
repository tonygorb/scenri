/**
 * Golden generation cases — the permanent regression suite for the generation
 * contracts: which references outrank which, and what the compiled brief must say.
 *
 * These assert on the COMPILED BRIEF (prompt text, reference count, role
 * order, dimensions, warnings) rather than on generated pixels: the compiled
 * request is what actually determines whether the model is told the right
 * things, and asserting it is fast and deterministic.
 *
 * Run these whenever prompt compilation, reference handling, the engine
 * roster, or the Scene / Product / Presenter systems change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCore,
  EDIT_REFERENCE_ROLE_DIRECTIVE,
  REFERENCE_ROLE_DIRECTIVE,
  type Core,
  type EngineCapabilities,
} from '@scenri/core';
import { compileBrief, validateBrief, FORMATS, PRODUCT_REF_MAX, CHARACTER_REF_MAX, type Brief } from '../src/brief.js';
import { loadScenes, sceneResolver, defaultScenesDir } from '../src/scenes.js';

let home: string;
let core: Core;
let frontHash: string;
let sideHash: string;
let detailHash: string;
let faceAHash: string;
let faceBHash: string;
let faceCHash: string;
let inspoHash: string;

const caps = (maxReferenceImages: number, displayName = 'Codex CLI'): EngineCapabilities => ({
  id: 'x',
  displayName,
  localOnly: false,
  supportsEdit: true,
  supportsMask: false,
  maxReferenceImages,
});

/** A product with three real angles and a presenter with three real views. */
const brand = () => ({
  meta: { name: 'Acme' },
  products: [
    {
      id: 'p1',
      name: 'House Blend',
      material: 'matte aluminium',
      dimensions: '66mm across, 115mm tall',
      shots: [
        { file: `asset:${frontHash}`, angle: 'front', locked: true },
        { file: `asset:${sideHash}`, angle: 'side', locked: true },
        { file: `asset:${detailHash}`, angle: 'detail', locked: true },
      ],
    },
    {
      // The demo-product spelling. All 34 shipped demo products describe
      // themselves with plural `materials` plus `primaryColors`, so a compiler
      // that only reads the singular catalog-import `material` silently throws
      // away the material and colour identity of every product we ship.
      id: 'p2',
      name: 'Field Watch',
      materials: 'bead-blasted stainless steel case, woven olive canvas strap',
      primaryColors: 'gunmetal steel; cream dial; olive-drab strap',
      shots: [{ file: `asset:${frontHash}`, angle: 'front', locked: true }],
    },
  ],
  characters: [
    {
      id: 'c1',
      name: 'Marco',
      identityNotes: 'A faint scar through the left eyebrow.',
      negativeConstraints: ['never clean-shaven'],
      shots: [
        { file: `asset:${faceAHash}`, angle: 'front', locked: true },
        { file: `asset:${faceBHash}`, angle: 'left-profile', locked: true },
        { file: `asset:${faceCHash}`, angle: 'right-profile', locked: true },
      ],
    },
  ],
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sc-golden-'));
  core = createCore(home);
  frontHash = core.images.save(Buffer.from('front'));
  sideHash = core.images.save(Buffer.from('side'));
  detailHash = core.images.save(Buffer.from('detail'));
  faceAHash = core.images.save(Buffer.from('face-a'));
  faceBHash = core.images.save(Buffer.from('face-b'));
  faceCHash = core.images.save(Buffer.from('face-c'));
  inspoHash = core.images.save(Buffer.from('inspo'));
});
afterEach(() => {
  core.close();
  rmSync(home, { recursive: true, force: true });
});

const resolveScene = sceneResolver(loadScenes(defaultScenesDir()).scenes);
const compile = (tokens: Brief['tokens'], max = 6) =>
  compileBrief({ tokens }, { brand: brand(), images: core.images, engineCaps: caps(max), templateById: resolveScene });
const roles = (r: ReturnType<typeof compile>) => r.attachments.map((a) => a.role);

/** A product-led scene and a person-led scene that really exist in the catalog. */
const PRODUCT_SCENE = 'studio-polished-pedestal';
const PERSON_SCENE = 'contour-key-portrait';

describe('golden: identity is never lost or confused', () => {
  it('1. product only — attaches its angles, states scale and material', () => {
    const r = compile([{ t: 'product', id: 'p1' }]);
    expect(roles(r)).toEqual(['product', 'product', 'product']);
    expect(r.attachments.filter((a) => a.essential)).toHaveLength(1);
    expect(r.prompt).toContain('House Blend');
    expect(r.prompt).toContain('matte aluminium');
    expect(r.prompt).toContain('true scale');
    expect(r.dropped).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('1b. a demo product states its materials and colors, not just a catalog one', () => {
    const r = compile([{ t: 'product', id: 'p2' }]);
    expect(r.prompt).toContain('bead-blasted stainless steel case');
    expect(r.prompt).toContain('cream dial');
  });

  it('2. product + scene — scene art-directs, and is told not to supply its own product', () => {
    const r = compile([
      { t: 'product', id: 'p1' },
      { t: 'template', id: PRODUCT_SCENE },
    ]);
    expect(r.prompt).toContain('House Blend');
    expect(r.prompt).toContain('quarry');
    expect(r.prompt).toMatch(/Disregard any product[^.]*described in the scene direction/i);
    expect(roles(r)).toEqual(['product', 'product', 'product']);
  });

  it('3. product + presenter + scene — both identities attach, product first', () => {
    const r = compile([
      { t: 'product', id: 'p1' },
      { t: 'character', id: 'c1' },
      { t: 'template', id: PERSON_SCENE },
    ]);
    // Both ESSENTIAL references lead, one per identity, before any
    // corroborating angle. That ordering is what makes a cap-2 engine keep
    // one product shot and one face — rather than two product angles and an
    // invented stranger.
    expect(roles(r).slice(0, 2)).toEqual(['product', 'character']);
    expect(r.attachments.slice(0, 2).every((a) => a.essential)).toBe(true);
    expect(roles(r).filter((x) => x === 'product')).toHaveLength(PRODUCT_REF_MAX);
    expect(roles(r).filter((x) => x === 'character')).toHaveLength(CHARACTER_REF_MAX);
    expect(r.prompt).toContain('Marco');
    expect(r.prompt).toContain('A faint scar through the left eyebrow.');
    expect(r.prompt).toContain('never clean-shaven');
    expect(r.prompt).toMatch(/Disregard any wardrobe[^.]*named in the scene direction/i);
  });

  it('4. chip order never decides who survives the cap — identity beats position', () => {
    // Presenter typed BEFORE the product, on an engine that reads only two.
    const r = compile(
      [
        { t: 'character', id: 'c1' },
        { t: 'product', id: 'p1' },
      ],
      2,
    );
    // The product's essential reference must still be present.
    expect(roles(r)).toContain('product');
    expect(r.attachments[0]).toMatchObject({ role: 'product', essential: true });
    // Nothing essential may be among the casualties.
    expect(r.dropped.filter((d) => d.essential)).toEqual([]);
  });

  it('5. a one-image engine keeps the product and reports the loss honestly', () => {
    const r = compile(
      [
        { t: 'product', id: 'p1' },
        { t: 'character', id: 'c1' },
      ],
      1,
    );
    expect(roles(r)).toEqual(['product']);
    // Losing the presenter entirely is an essential loss — the route refuses
    // on this, rather than generating a stranger with full confidence.
    expect(r.dropped.some((d) => d.essential && d.role === 'character')).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/Marco/);
  });

  it('6. product + scene + custom reference — the inspiration image cannot outrank identity', () => {
    const r = compile(
      [
        { t: 'ref', imageHash: inspoHash },
        { t: 'product', id: 'p1' },
        { t: 'template', id: PRODUCT_SCENE },
      ],
      3,
    );
    expect(roles(r).every((x) => x === 'product')).toBe(true);
    expect(r.dropped.map((d) => d.role)).toEqual(['reference']);
    expect(r.dropped.filter((d) => d.essential)).toEqual([]);
  });

  it('7. scene only — valid, warns that its subject is absent, still compiles', () => {
    const r = compile([{ t: 'template', id: PRODUCT_SCENE }]);
    expect(r.prompt.trim()).not.toBe('');
    expect(r.attachments).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/built around a product/i);
  });

  it('8. presenter only — valid, no product required anywhere', () => {
    const r = compile([{ t: 'character', id: 'c1' }]);
    expect(roles(r)).toEqual(['character', 'character']);
    expect(r.productId).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it('9. a requested angle leads, and is never dropped in favour of other angles', () => {
    const r = compile([{ t: 'product', id: 'p1', angle: 'detail' }], 1);
    expect(r.referenceImages).toEqual([core.images.pathFor(detailHash)]);
    expect(r.attachments[0]).toMatchObject({ role: 'product', essential: true });
  });

  it('10. a scene never supplies the product, and the format token has the last word', () => {
    const r = compile([
      { t: 'format', id: 'square', w: 1024, h: 1024 },
      { t: 'product', id: 'p1' },
      { t: 'template', id: PRODUCT_SCENE },
      { t: 'format', id: 'portrait', w: 1024, h: 1280 },
    ]);
    expect([r.width, r.height]).toEqual([1024, 1280]);
    expect(r.prompt).toMatch(/the only product in this image is the one shown in the attached product photo/i);
  });
});

/**
 * The boundary rejects what the compiler would have had to guess at. These
 * lock the split: malformed structure is an error, a recognisable-but-broken
 * reference is a warning.
 */
describe('golden: a brief we cannot read is refused, not guessed at', () => {
  it('accepts every supported token kind', () => {
    expect(
      validateBrief({
        tokens: [
          { t: 'text', v: 'on a wet street' },
          { t: 'product', id: 'p1', angle: 'front' },
          { t: 'character', id: 'c1' },
          { t: 'template', id: 'scene-1' },
          { t: 'color', hex: '#12AB9F' },
          { t: 'ref', imageHash: 'abc' },
          { t: 'format', w: 1024, h: 1280 },
        ],
      }),
    ).toEqual([]);
  });

  it('rejects an unknown token kind instead of dropping it silently', () => {
    const errors = validateBrief({ tokens: [{ t: 'sticker', id: 'x' }] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('sticker');
  });

  it('rejects malformed payloads for known kinds', () => {
    expect(validateBrief({ tokens: [{ t: 'product' }] })).toHaveLength(1);
    expect(validateBrief({ tokens: [{ t: 'color', hex: 'red' }] })).toHaveLength(1);
    expect(validateBrief({ tokens: [{ t: 'format', w: 0, h: 1280 }] })).toHaveLength(1);
    expect(validateBrief({ tokens: 'nope' })).toEqual(['brief.tokens must be an array']);
  });

  it('an unknown kind that reaches the compiler warns rather than vanishing', () => {
    const r = compileBrief(
      { tokens: [{ t: 'sticker' } as never] } as Brief,
      {
        brand: { products: [], characters: [] },
        images: new Map() as never,
        engineCaps: { maxReferenceImages: 6 } as never,
      } as never,
    );
    expect(r.warnings.join(' ')).toContain('sticker');
  });
});

/**
 * Aspect ratio is part of the contract, and the label the user picks by has to
 * mean the shape they get. The composer prints its own label from the FORMAT,
 * not from the quality-scaled pixels — 4:5 arrives as 1232x1536 on high, which
 * reduces to "77:96" and reads as a different shape entirely.
 */
describe('golden: every aspect ratio selection compiles to its declared shape', () => {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const label = (w: number, h: number) => {
    const d = gcd(w, h) || 1;
    return `${w / d}:${h / d}`;
  };

  it('ships exactly the four formats the UI offers', () => {
    expect(FORMATS.map((f) => f.id)).toEqual(['square', 'story', 'landscape', 'portrait']);
  });

  it.each([
    ['square', '1:1'],
    ['story', '9:16'],
    ['landscape', '16:9'],
    ['portrait', '4:5'],
  ])('%s reduces to %s', (id, expected) => {
    const f = FORMATS.find((x) => x.id === id)!;
    expect(label(f.w, f.h)).toBe(expected);
  });

  it.each(FORMATS.map((f) => [f.id, f.w, f.h] as const))('a %s format token compiles to %ix%i', (id, w, h) => {
    const r = compile([
      { t: 'product', id: 'p1' },
      { t: 'format', id, w, h },
    ]);
    expect([r.width, r.height]).toEqual([w, h]);
  });
});

/**
 * The responsibility contract: which layer owns which dimension.
 *
 * Product and Presenter own identity and can never be overridden. The shot owns
 * camera; a Scene may only express a tendency, and only when the shot is silent.
 * A reference image influences exactly the dimension its role names.
 */
describe('golden: responsibility contract', () => {
  it('a one-reference product is told its unseen faces are unknown, and to favour the known view', () => {
    const r = compile([{ t: 'product', id: 'p2' }]);
    expect(r.attachments).toHaveLength(1);
    expect(r.prompt).toContain('the only view of this product that exists');
    expect(r.prompt).toMatch(/do not invent hardware, text, seams, closures, ornament or branding/i);
    expect(r.prompt).toMatch(/composition that shows the product from the view the reference gives/i);
    // the multi-angle wording would be a lie with one image
    expect(r.prompt).not.toContain('from different angles');
  });

  it('a multi-reference product gets the multi-angle directive instead', () => {
    const r = compile([{ t: 'product', id: 'p1' }]);
    expect(r.prompt).toContain('all show the exact same product from different angles');
    expect(r.prompt).not.toContain('the only view of this product that exists');
    // three stored views is not full coverage, so it still guards the unseen face
    expect(r.prompt).toMatch(/Any face not visible in them is unknown/i);
  });

  /**
   * A count is not evidence of coverage.
   *
   * This used to assert the opposite: four stored views earned the product a
   * line saying they "cover the object from every side, so no face of it has to
   * be guessed at". Nothing checked that they were views at all. An imported
   * product routinely carries one image per colourway rather than one per
   * angle, so the products that tripped the branch were often the ones whose
   * images were not angles — and the claim grew more confident the more colours
   * the store sold. The branch is gone; a big set is told exactly what a small
   * one is told.
   */
  it('a big set earns no claim about coverage it cannot support', () => {
    const b = brand();
    b.products[0].shots.push({ file: `asset:${inspoHash}`, angle: 'back', locked: true });
    const r = compileBrief(
      { tokens: [{ t: 'product', id: 'p1' }] },
      { brand: b, images: core.images, engineCaps: caps(6), templateById: resolveScene },
    );
    expect(r.prompt).not.toMatch(/cover the object from every side/i);
    expect(r.prompt).toMatch(/Any face not visible in them is unknown/i);
  });

  it('identity survives every engine clamp — the product reference is the last thing dropped', () => {
    const tokens: Brief['tokens'] = [
      { t: 'product', id: 'p1' },
      { t: 'character', id: 'c1' },
    ];
    for (const cap of [6, 4, 2, 1]) {
      const r = compile(tokens, cap);
      expect(r.attachments.length).toBeLessThanOrEqual(cap);
      expect(r.attachments[0]?.role).toBe('product');
      expect(r.attachments[0]?.essential).toBe(true);
    }
  });

  it('a scene camera tendency applies only when the shot says nothing about camera', () => {
    const scene = { ...resolveScene(PRODUCT_SCENE)!, camera: '90mm at eye level, medium depth' };
    const withTendency = compileBrief(
      {
        tokens: [
          { t: 'product', id: 'p1' },
          { t: 'template', id: PRODUCT_SCENE },
          { t: 'text', v: ' on a cold morning' },
        ],
      },
      { brand: brand(), images: core.images, engineCaps: caps(6), templateById: () => scene },
    );
    expect(withTendency.prompt).toContain('Camera for this shot: 90mm at eye level, medium depth');
  });

  it('the shot wins: a stated camera drops the scene tendency entirely, so the two never compete', () => {
    const scene = { ...resolveScene(PRODUCT_SCENE)!, camera: '90mm at eye level, medium depth' };
    const shotDecides = compileBrief(
      {
        tokens: [
          { t: 'product', id: 'p1' },
          { t: 'template', id: PRODUCT_SCENE },
          { t: 'text', v: ' 24mm from floor level, extremely shallow depth of field' },
        ],
      },
      { brand: brand(), images: core.images, engineCaps: caps(6), templateById: () => scene },
    );
    expect(shotDecides.prompt).not.toContain('Camera for this shot:');
    expect(shotDecides.prompt).not.toContain('90mm');
    expect(shotDecides.prompt).toContain('24mm from floor level');
  });

  it('a scene without a camera tendency behaves exactly as before', () => {
    const r = compile([
      { t: 'product', id: 'p1' },
      { t: 'template', id: PRODUCT_SCENE },
    ]);
    expect(r.prompt).not.toContain('Camera for this shot:');
  });
});

/**
 * Presenter references are identity, not wardrobe.
 *
 * Every presenter's reference set is shot full-length in the same neutral
 * off-white capture uniform. A tester found that uniform leaking into final
 * commercial images: the only directive the compiler emitted was "hold their
 * face, hair and build, and do not restyle them", which a model reads as
 * preserve-the-photo-wholesale — clothing included. These lock the corrected
 * contract: the lock names what identity is, the release clause names what the
 * reference must NOT control, and the wearable pair sentence says whose
 * clothes the presenter is actually in when a product is attached.
 */
describe('golden: presenter references are identity, not wardrobe', () => {
  it('a presenter attach locks identity and releases the capture wardrobe', () => {
    const r = compile([{ t: 'character', id: 'c1' }]);
    expect(r.prompt).toContain('same person every time');
    expect(r.prompt).toMatch(/face, facial structure, skin, hair and build/);
    expect(r.prompt).toMatch(/capture conditions, not styling direction/i);
    // the preserve-wholesale wording is what leaked the uniform; it must not return
    expect(r.prompt).not.toMatch(/do not restyle them/);
    // Releasing the uniform was not enough on its own: a 12 frame battery put
    // the capture layer back in four. The directive has to name that failure
    // and say what to wear when the direction says nothing.
    expect(r.prompt).toMatch(/never return them to the plain base layers they were photographed in/i);
    expect(r.prompt).toMatch(/dress them for the place and the occasion/i);
  });

  it('the release clause rides with a person, never with a product alone', () => {
    const r = compile([{ t: 'product', id: 'p1' }]);
    expect(r.prompt).not.toMatch(/capture conditions/i);
    expect(r.prompt).not.toMatch(/styling direction/i);
  });

  it('product + presenter states the wearable relationship exactly once, and only then', () => {
    const both = compile([
      { t: 'product', id: 'p1' },
      { t: 'character', id: 'c1' },
    ]);
    expect(both.prompt.match(/something a person wears/g)).toHaveLength(1);
    expect(compile([{ t: 'product', id: 'p1' }]).prompt).not.toMatch(/something a person wears/);
    expect(compile([{ t: 'character', id: 'c1' }]).prompt).not.toMatch(/something a person wears/);
  });

  it('the shared role directives carry the same contract to every adapter', () => {
    expect(REFERENCE_ROLE_DIRECTIVE.character).toMatch(/face, facial structure, skin, hair and build/);
    expect(REFERENCE_ROLE_DIRECTIVE.character).toMatch(/capture context, not styling to reproduce/);
    expect(REFERENCE_ROLE_DIRECTIVE.character).not.toMatch(/do not restyle/);
  });

  it("an edit keeps the source image's outfit: the identity reference cannot re-dress it", () => {
    expect(EDIT_REFERENCE_ROLE_DIRECTIVE.character).toMatch(/take no clothing, pose or background/);
    expect(EDIT_REFERENCE_ROLE_DIRECTIVE.character).toMatch(/keep the source image's existing outfit/);
  });
});
