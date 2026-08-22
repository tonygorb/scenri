import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, SpendCapError, type Core } from '../src/index.js';

let home: string;
let core: Core;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sc-core-'));
  core = createCore(home);
});
afterEach(() => {
  core.close();
  rmSync(home, { recursive: true, force: true });
});

const brandJson = { specVersion: '0.1', meta: { name: 'Acme Coffee' } };

describe('brands + projects', () => {
  it('creates brand with slug, round-trips json, updates and lists', () => {
    const b = core.store.createBrand(brandJson as any);
    expect(b.slug).toBe('acme-coffee');
    expect((b.json as any).meta.name).toBe('Acme Coffee');
    const updated = core.store.updateBrand(b.id, { ...brandJson, meta: { name: 'Acme Tea' } } as any)!;
    expect(updated.slug).toBe('acme-tea');
    expect(core.store.listBrands()).toHaveLength(1);
  });

  it('keeps slugs unique: the slug is the brand URL, so it cannot be shared or stolen', () => {
    const first = core.store.createBrand(brandJson as any);
    const second = core.store.createBrand(brandJson as any);
    expect(first.slug).toBe('acme-coffee');
    expect(second.slug).toBe('acme-coffee-2');

    // renaming onto a taken name suffixes rather than taking the other's URL
    const renamed = core.store.updateBrand(second.id, {
      ...brandJson,
      meta: { name: 'Acme Coffee' },
    } as any)!;
    expect(renamed.slug).toBe('acme-coffee-2');
    expect(core.store.getBrand(first.id)!.slug).toBe('acme-coffee');

    // and a brand keeps its own slug when saved with an unchanged name
    expect(core.store.updateBrand(first.id, brandJson as any)!.slug).toBe('acme-coffee');
  });

  it('keeps slugs ASCII regardless of what script the name is written in', () => {
    const named = (name: string) => core.store.createBrand({ specVersion: '0.1', meta: { name } } as any);
    // latin accents fold, because café and cafe are one word to anyone typing
    // a URL — the name itself, brand.json.meta.name, is untouched; this is
    // only ever the address bar
    expect(named('Café Ölwerk').slug).toBe('cafe-olwerk');
    // a mixed-script name keeps only its Latin half — this is nalla's own
    // real shape, "נלה - Nalla", which is exactly the case this reverses
    expect(named('נלה - Nalla').slug).toBe('nalla');
    expect(named('Acme קפה').slug).toBe('acme');
    // a name with no Latin content at all still has to be addressable, and
    // two such brands must not become indistinguishable brand-2/brand-3 —
    // a slice of the brand's own id keeps them apart while staying ASCII
    const hebrew = named('מותג קפה');
    expect(hebrew.slug).toBe(`brand-${hebrew.id.slice(0, 8)}`);
    const arabic = named('قهوة أكمي');
    expect(arabic.slug).toBe(`brand-${arabic.id.slice(0, 8)}`);
    expect(hebrew.slug).not.toBe(arabic.slug);
    // and a name with no letters at all still has to be addressable
    const noLetters = named('☕️ !!! ☕️');
    expect(noLetters.slug).toBe(`brand-${noLetters.id.slice(0, 8)}`);
  });

  it('will not let a brand take one of the names the web root already owns', () => {
    const named = (name: string) => core.store.createBrand({ specVersion: '0.1', meta: { name } } as any);
    // a brand lives at /<slug>, so these four would each be shadowed by
    // something that was already answering there
    expect(named('API').slug).toBe('api-2');
    expect(named('Assets').slug).toBe('assets-2');
    expect(named('Setup').slug).toBe('setup-2');
    expect(named('B').slug).toBe('b-2');
    // and a rename onto one is refused the same way a rename onto another
    // brand's slug is — assets-3, because the brand created above is already
    // sitting on assets-2
    const brand = named('Acme');
    expect(core.store.updateBrand(brand.id, { specVersion: '0.1', meta: { name: 'Assets' } } as any)!.slug).toBe(
      'assets-3',
    );
  });

  it('leaves set slugs alone: they sit below a brand, so the root cannot shadow them', () => {
    const b = core.store.createBrand(brandJson as any);
    // /<brand>/sets/api is nobody else's, so there is nothing to dodge
    expect(core.store.createSet(b.id, 'API').slug).toBe('api');
    expect(core.store.createSet(b.id, 'Assets').slug).toBe('assets');
  });

  it('creates project with done root node', () => {
    const b = core.store.createBrand(brandJson as any);
    const { project, root } = core.store.createProject(b.id, 'Summer campaign');
    expect(project.slug).toBe('summer-campaign');
    expect(root.kind).toBe('root');
    expect(root.status).toBe('done');
    expect(core.store.treeFor(project.id)).toHaveLength(1);
  });

  it('scopes project slugs to the brand: same name, different brands, no suffix', () => {
    const one = core.store.createBrand(brandJson as any);
    const two = core.store.createBrand({ specVersion: '0.1', meta: { name: 'Beta' } } as any);
    expect(core.store.createProject(one.id, 'Untitled').project.slug).toBe('untitled');
    expect(core.store.createProject(two.id, 'Untitled').project.slug).toBe('untitled');
    // but a second Untitled inside one brand has to be told apart
    expect(core.store.createProject(one.id, 'Untitled').project.slug).toBe('untitled-2');
    expect(core.store.listProjects(one.id).map((p) => p.slug)).toEqual(['untitled', 'untitled-2']);
  });
});

describe('version tree', () => {
  it('branches: two children off root, one grandchild; complete/fail/keep', () => {
    const b = core.store.createBrand(brandJson as any);
    const { project, root } = core.store.createProject(b.id, 'p');
    const a = core.store.addNode({
      projectId: project.id,
      parentId: root.id,
      kind: 'generation',
      prompt: 'hero shot',
      engineId: 'demo',
    });
    const c = core.store.addNode({
      projectId: project.id,
      parentId: root.id,
      kind: 'generation',
      prompt: 'alt shot',
      engineId: 'demo',
    });
    core.store.completeNode(a.id, { images: ['a'.repeat(32)], costUsd: 0.05 });
    core.store.failNode(c.id, 'boom');
    const g = core.store.addNode({
      projectId: project.id,
      parentId: a.id,
      kind: 'edit',
      prompt: 'warmer light',
      engineId: 'demo',
    });
    core.store.setKept(g.id, true);

    const tree = core.store.treeFor(project.id);
    expect(tree).toHaveLength(4);
    expect(core.store.getNode(a.id)!.status).toBe('done');
    expect(core.store.getNode(c.id)!.error).toBe('boom');
    expect(core.store.getNode(g.id)!.parentId).toBe(a.id);
    expect(core.store.getNode(g.id)!.kept).toBe(true);
    expect(core.store.getNode(g.id)!.archived).toBe(false);
  });

  it('archives and restores a node without deleting it, independent of kept', () => {
    const b = core.store.createBrand(brandJson as any);
    const { project, root } = core.store.createProject(b.id, 'p');
    const n = core.store.addNode({
      projectId: project.id,
      parentId: root.id,
      kind: 'generation',
      prompt: 'x',
      engineId: 'demo',
    });
    core.store.completeNode(n.id, { images: ['a'.repeat(32)], costUsd: 0 });
    core.store.setKept(n.id, true);

    core.store.setArchived(n.id, true);
    let after = core.store.getNode(n.id)!;
    expect(after.archived).toBe(true);
    // archiving is a put-away, not a delete: the row and its status survive
    expect(after.status).toBe('done');
    expect(core.store.treeFor(project.id).map((row) => row.id)).toContain(n.id);
    // but it does clear the keeper mark. Keepers is a live shortlist and the
    // lens reads the live list, so an archived keeper used to leave Keepers and
    // its count while still wearing a lit star: two flags saying opposite
    // things about the same shot.
    expect(after.kept).toBe(false);

    // Restoring puts the shot back without re-starring it. The judgement was
    // made once; putting it back on the shelf is not making it again.
    core.store.setArchived(n.id, false);
    after = core.store.getNode(n.id)!;
    expect(after.archived).toBe(false);
    expect(after.kept).toBe(false);
  });

  it('deleteNode permanently removes a leaf node', () => {
    const b = core.store.createBrand(brandJson as any);
    const { project, root } = core.store.createProject(b.id, 'p');
    const n = core.store.addNode({
      projectId: project.id,
      parentId: root.id,
      kind: 'generation',
      prompt: 'x',
      engineId: 'demo',
    });
    core.store.setArchived(n.id, true);

    core.store.deleteNode(n.id);

    expect(core.store.getNode(n.id)).toBeNull();
    expect(core.store.treeFor(project.id).map((row) => row.id)).not.toContain(n.id);
  });

  it('deleteNode orphans children instead of blocking or cascading', () => {
    const b = core.store.createBrand(brandJson as any);
    const { project, root } = core.store.createProject(b.id, 'p');
    const parent = core.store.addNode({
      projectId: project.id,
      parentId: root.id,
      kind: 'generation',
      prompt: 'parent shot',
      engineId: 'demo',
    });
    core.store.completeNode(parent.id, { images: ['a'.repeat(32)], costUsd: 0 });
    const child = core.store.addNode({
      projectId: project.id,
      parentId: parent.id,
      kind: 'edit',
      prompt: 'edit of parent',
      engineId: 'demo',
    });
    core.store.setArchived(parent.id, true);

    core.store.deleteNode(parent.id);

    expect(core.store.getNode(parent.id)).toBeNull();
    const survivingChild = core.store.getNode(child.id);
    expect(survivingChild).not.toBeNull();
    expect(survivingChild!.parentId).toBeNull();
  });

  it('rejects parent from another project', () => {
    const b = core.store.createBrand(brandJson as any);
    const p1 = core.store.createProject(b.id, 'p1');
    const p2 = core.store.createProject(b.id, 'p2');
    expect(() =>
      core.store.addNode({
        projectId: p2.project.id,
        parentId: p1.root.id,
        kind: 'generation',
        prompt: 'x',
        engineId: 'demo',
      }),
    ).toThrow(/parent node/);
  });
});

describe('restart sweep', () => {
  it('marks running nodes as error on reopen', () => {
    const b = core.store.createBrand(brandJson as any);
    const { project, root } = core.store.createProject(b.id, 'p');
    const n = core.store.addNode({
      projectId: project.id,
      parentId: root.id,
      kind: 'generation',
      prompt: 'x',
      engineId: 'demo',
    });
    expect(core.store.getNode(n.id)!.status).toBe('running');
    core.close();
    core = createCore(home); // reopen same dir
    const after = core.store.getNode(n.id)!;
    expect(after.status).toBe('error');
    expect(after.error).toMatch(/interrupted/);
  });
});

describe('image store', () => {
  it('dedupes identical buffers and validates hashes', () => {
    const buf = Buffer.from('fake-png-bytes');
    const h1 = core.images.save(buf);
    const h2 = core.images.save(buf);
    expect(h1).toBe(h2);
    expect(core.images.has(h1)).toBe(true);
    expect(core.images.read(h1).equals(buf)).toBe(true);
    expect(() => core.images.pathFor('../etc/passwd')).toThrow(/invalid/);
  });
});

describe('ledger + caps', () => {
  it('accumulates monthly spend per engine and enforces caps', () => {
    core.ledger.recordCost('openrouter', null, 0.4);
    core.ledger.recordCost('openrouter', null, 0.35);
    core.ledger.recordCost('fal', null, 0.02);
    expect(core.ledger.monthlySpend('openrouter')).toBeCloseTo(0.75);

    core.ledger.setCap('openrouter', 1.0);
    expect(() => core.ledger.assertUnderCap('openrouter', 0.2)).not.toThrow();
    expect(() => core.ledger.assertUnderCap('openrouter', 0.3)).toThrow(SpendCapError);

    core.ledger.setCap('openrouter', null);
    expect(() => core.ledger.assertUnderCap('openrouter', 99)).not.toThrow();
    expect(core.ledger.totalSpendByEngine()).toMatchObject({ fal: 0.02 });
  });

  it('zero-cost engines never blocked, never recorded', () => {
    core.ledger.setCap('codex-cli', 0);
    expect(() => core.ledger.assertUnderCap('codex-cli', 0)).not.toThrow();
    core.ledger.recordCost('codex-cli', null, 0);
    expect(core.ledger.monthlySpend('codex-cli')).toBe(0);
  });
});
