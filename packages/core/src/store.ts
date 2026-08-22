import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import { RESERVED_SLUGS, firstFree, slugifyWithId } from './slug.js';

export interface BrandRow {
  id: string;
  slug: string;
  json: unknown;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectRow {
  id: string;
  brandId: string;
  name: string;
  /** Its place in the address bar, unique within the brand. */
  slug: string;
  createdAt: string;
}
export type NodeKind = 'root' | 'generation' | 'edit';
export type NodeStatus = 'running' | 'done' | 'error' | 'cancelled';
export interface TreeNode {
  id: string;
  projectId: string;
  parentId: string | null;
  kind: NodeKind;
  prompt: string;
  engineId: string;
  status: NodeStatus;
  images: string[];
  costUsd: number;
  kept: boolean;
  error: string | null;
  createdAt: string;
  /** Text-overlay layers keyed by image index (editor data, opaque to core). */
  overlays: Record<string, unknown[]>;
  /** Structured brief this shot came from; null for legacy nodes. */
  brief: unknown | null;
  /** Put away, not gone: an archived node is excluded from the default feed
   * but always restorable, never deleted. */
  archived: boolean;
}

/** A node carrying the sets it has been put in, for lists that span the brand. */
export interface ActivityNode extends TreeNode {
  /** Empty when the shot is in no set, which is an ordinary state, not a gap. */
  setNames: string[];
}

/**
 * An opt-in grouping of shots. Not a place work happens — that is the brand's
 * one workspace — only a name you hang finished shots on, and a shot may hang
 * on several.
 */
export interface SetRow {
  id: string;
  brandId: string;
  name: string;
  /** Its place in the address bar, unique within the brand. */
  slug: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The slug is the brand's URL, so two brands cannot share one: the second
 * "Acme" becomes acme-2. Renaming a brand back onto a taken slug suffixes
 * rather than steals, so no existing link ever changes owner. `id` is always
 * the brand's own id — the row being created or updated — used both to seed
 * a Latin-free name's fallback and to exclude itself from the collision
 * check; for a brand new row neither matters yet, so passing it unconditionally
 * is harmless.
 *
 * A brand sits at the web root, so the names that root already owns are taken
 * in the same sense another brand's slug is: a brand called "Assets" becomes
 * assets-2 rather than a page that never loads.
 */
export function uniqueSlug(db: DB, name: string, id: string): string {
  const stmt = db.prepare('SELECT 1 FROM brands WHERE slug=? AND id IS NOT ?');
  return firstFree(slugifyWithId(name, id), (c) => RESERVED_SLUGS.has(c) || !!stmt.get(c, id));
}

/** Same, per brand: two brands may each have a project called Untitled. */
export function uniqueProjectSlug(db: DB, brandId: string, name: string, id: string): string {
  const stmt = db.prepare('SELECT 1 FROM projects WHERE brand_id=? AND slug=?');
  return firstFree(slugifyWithId(name, id, 'project'), (c) => !!stmt.get(brandId, c));
}

/** And again for sets, which share the brand's address space with nothing else. */
export function uniqueSetSlug(db: DB, brandId: string, name: string, id: string): string {
  const stmt = db.prepare('SELECT 1 FROM sets WHERE brand_id=? AND slug=? AND id IS NOT ?');
  return firstFree(slugifyWithId(name, id, 'set'), (c) => !!stmt.get(brandId, c, id));
}

/**
 * What `group_concat` glues set names with. A comma would be ambiguous the
 * moment somebody names a set "Spring, Summer"; the unit separator cannot
 * appear in a name typed by a human.
 */
const SET_NAME_SEP = String.fromCharCode(31);

function rowToSet(r: any): SetRow {
  return {
    id: r.id,
    brandId: r.brand_id,
    name: r.name,
    slug: r.slug,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToNode(r: any): TreeNode {
  return {
    id: r.id,
    projectId: r.project_id,
    parentId: r.parent_id,
    kind: r.kind,
    prompt: r.prompt,
    engineId: r.engine_id,
    status: r.status,
    images: JSON.parse(r.images),
    costUsd: r.cost_usd,
    kept: !!r.kept,
    error: r.error,
    createdAt: r.created_at,
    overlays: JSON.parse(r.overlays ?? '{}'),
    brief: r.brief ? JSON.parse(r.brief) : null,
    archived: !!r.archived,
  };
}

export function createStore(db: DB) {
  return {
    // brands
    createBrand(json: { meta: { name: string } } & Record<string, unknown>): BrandRow {
      const id = randomUUID();
      db.prepare('INSERT INTO brands (id, slug, json) VALUES (?,?,?)').run(
        id,
        uniqueSlug(db, json.meta.name, id),
        JSON.stringify(json),
      );
      return this.getBrand(id)!;
    },
    getBrand(id: string): BrandRow | null {
      const r = db.prepare('SELECT * FROM brands WHERE id=?').get(id) as any;
      return r
        ? { id: r.id, slug: r.slug, json: JSON.parse(r.json), createdAt: r.created_at, updatedAt: r.updated_at }
        : null;
    },
    listBrands(): BrandRow[] {
      return (db.prepare('SELECT * FROM brands ORDER BY created_at').all() as any[]).map((r) => ({
        id: r.id,
        slug: r.slug,
        json: JSON.parse(r.json),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    },
    updateBrand(id: string, json: { meta: { name: string } } & Record<string, unknown>): BrandRow | null {
      db.prepare("UPDATE brands SET json=?, slug=?, updated_at=datetime('now') WHERE id=?").run(
        JSON.stringify(json),
        uniqueSlug(db, json.meta.name, id),
        id,
      );
      return this.getBrand(id);
    },
    deleteBrand(id: string): void {
      db.prepare('DELETE FROM brands WHERE id=?').run(id);
    },

    // projects
    createProject(brandId: string, name: string): { project: ProjectRow; root: TreeNode } {
      const id = randomUUID();
      db.prepare('INSERT INTO projects (id, brand_id, name, slug) VALUES (?,?,?,?)').run(
        id,
        brandId,
        name,
        uniqueProjectSlug(db, brandId, name, id),
      );
      const rootId = randomUUID();
      db.prepare("INSERT INTO nodes (id, project_id, parent_id, kind, status) VALUES (?,?,NULL,'root','done')").run(
        rootId,
        id,
      );
      return { project: this.getProject(id)!, root: this.getNode(rootId)! };
    },
    deleteProject(id: string): void {
      db.prepare('DELETE FROM projects WHERE id=?').run(id);
    },
    getProject(id: string): ProjectRow | null {
      const r = db.prepare('SELECT * FROM projects WHERE id=?').get(id) as any;
      return r ? { id: r.id, brandId: r.brand_id, name: r.name, slug: r.slug, createdAt: r.created_at } : null;
    },
    listProjects(brandId: string): ProjectRow[] {
      return (db.prepare('SELECT * FROM projects WHERE brand_id=? ORDER BY created_at').all(brandId) as any[]).map(
        (r) => ({
          id: r.id,
          brandId: r.brand_id,
          name: r.name,
          slug: r.slug,
          createdAt: r.created_at,
        }),
      );
    },
    /**
     * The brand's one project, made on demand.
     *
     * Every node still hangs from a project root, but that is plumbing now, not
     * a place: nothing in the UI names it and nothing but this creates one. The
     * five buttons that used to invent a project each call this instead, so a
     * brand ends up with exactly one no matter which door you came through.
     */
    workspaceFor(brandId: string): ProjectRow {
      return this.listProjects(brandId)[0] ?? this.createProject(brandId, 'Workspace').project;
    },

    // sets
    createSet(brandId: string, name: string): SetRow {
      const id = randomUUID();
      db.prepare('INSERT INTO sets (id, brand_id, name, slug) VALUES (?,?,?,?)').run(
        id,
        brandId,
        name,
        uniqueSetSlug(db, brandId, name, id),
      );
      return this.getSet(id)!;
    },
    getSet(id: string): SetRow | null {
      const r = db.prepare('SELECT * FROM sets WHERE id=?').get(id) as any;
      return r ? rowToSet(r) : null;
    },
    /**
     * Most recently touched first, everywhere. The old project lists each chose
     * their own order — one ascending by creation, one descending, one capped
     * before it sorted — so the same six names came back in three different
     * sequences depending on which control you opened.
     */
    listSets(brandId: string): SetRow[] {
      return (
        db
          .prepare('SELECT * FROM sets WHERE brand_id=? ORDER BY updated_at DESC, created_at DESC')
          .all(brandId) as any[]
      ).map(rowToSet);
    },
    renameSet(id: string, name: string): SetRow | null {
      const current = this.getSet(id);
      if (!current) return null;
      db.prepare("UPDATE sets SET name=?, slug=?, updated_at=datetime('now') WHERE id=?").run(
        name,
        uniqueSetSlug(db, current.brandId, name, id),
        id,
      );
      return this.getSet(id);
    },
    /** The set goes; the shots do not. Membership is a label, never ownership. */
    deleteSet(id: string): void {
      db.prepare('DELETE FROM sets WHERE id=?').run(id);
    },
    addToSet(setId: string, nodeIds: string[]): void {
      const add = db.prepare('INSERT OR IGNORE INTO set_nodes (set_id, node_id) VALUES (?,?)');
      db.transaction(() => {
        for (const nodeId of nodeIds) add.run(setId, nodeId);
        db.prepare("UPDATE sets SET updated_at=datetime('now') WHERE id=?").run(setId);
      })();
    },
    removeFromSet(setId: string, nodeId: string): void {
      db.transaction(() => {
        db.prepare('DELETE FROM set_nodes WHERE set_id=? AND node_id=?').run(setId, nodeId);
        db.prepare("UPDATE sets SET updated_at=datetime('now') WHERE id=?").run(setId);
      })();
    },
    /**
     * Every membership in the brand, keyed by set. One query rather than one
     * per set, because the workspace screen filters on the client: the feed is
     * already loaded, and a set is only a subset of it.
     */
    membershipFor(brandId: string): Record<string, string[]> {
      const rows = db
        .prepare(
          `SELECT sn.set_id, sn.node_id
             FROM set_nodes sn JOIN sets s ON s.id = sn.set_id
            WHERE s.brand_id = ?
            ORDER BY sn.added_at`,
        )
        .all(brandId) as { set_id: string; node_id: string }[];
      const out: Record<string, string[]> = {};
      for (const r of rows) {
        if (!out[r.set_id]) out[r.set_id] = [];
        out[r.set_id].push(r.node_id);
      }
      return out;
    },

    // nodes / version tree
    addNode(input: {
      projectId: string;
      parentId: string | null;
      kind: Exclude<NodeKind, 'root'>;
      prompt: string;
      engineId: string;
    }): TreeNode {
      if (input.parentId) {
        const parent = this.getNode(input.parentId);
        if (!parent || parent.projectId !== input.projectId) throw new Error('parent node not found in project');
      }
      const id = randomUUID();
      db.prepare('INSERT INTO nodes (id, project_id, parent_id, kind, prompt, engine_id) VALUES (?,?,?,?,?,?)').run(
        id,
        input.projectId,
        input.parentId,
        input.kind,
        input.prompt,
        input.engineId,
      );
      return this.getNode(id)!;
    },
    completeNode(id: string, result: { images: string[]; costUsd: number }): void {
      db.prepare("UPDATE nodes SET status='done', images=?, cost_usd=? WHERE id=?").run(
        JSON.stringify(result.images),
        result.costUsd,
        id,
      );
    },
    failNode(id: string, error: string): void {
      db.prepare("UPDATE nodes SET status='error', error=? WHERE id=?").run(error, id);
    },
    cancelNode(id: string): void {
      db.prepare("UPDATE nodes SET status='cancelled' WHERE id=?").run(id);
    },
    getNode(id: string): TreeNode | null {
      const r = db.prepare('SELECT * FROM nodes WHERE id=?').get(id) as any;
      return r ? rowToNode(r) : null;
    },
    treeFor(projectId: string): TreeNode[] {
      return (db.prepare('SELECT * FROM nodes WHERE project_id=? ORDER BY created_at').all(projectId) as any[]).map(
        rowToNode,
      );
    },
    /**
     * Every piece of work a brand has in flight, plus whatever finished lately,
     * in one query. The bar outlives the project screen, so the thing that used
     * to be answerable only by polling one tree at a time has to be answerable
     * without knowing which project you are looking at.
     *
     * The cutoff is computed in SQL rather than passed in: created_at is
     * SQLite's own datetime('now') text, and comparing that against a caller's
     * ISO string is a silent, timezone-shaped mis-filter.
     */
    recentActivity(brandId: string, limit = 60): ActivityNode[] {
      const rows = db
        .prepare(
          `SELECT n.*, (
                    SELECT group_concat(s.name, char(31))
                      FROM set_nodes sn JOIN sets s ON s.id = sn.set_id
                     WHERE sn.node_id = n.id
                  ) AS set_names
             FROM nodes n JOIN projects p ON p.id = n.project_id
            WHERE p.brand_id = ?
              AND n.kind != 'root'
              AND (n.status = 'running' OR n.created_at >= datetime('now', '-2 days'))
            ORDER BY n.created_at DESC
            LIMIT ?`,
        )
        .all(brandId, limit) as any[];
      // char(31) is the unit separator: a set may legally be called "A, B"
      return rows.map((r) => ({
        ...rowToNode(r),
        setNames: r.set_names ? String(r.set_names).split(SET_NAME_SEP) : [],
      }));
    },
    setKept(id: string, kept: boolean): void {
      db.prepare('UPDATE nodes SET kept=? WHERE id=?').run(kept ? 1 : 0, id);
    },
    /**
     * Archiving also clears the keeper mark.
     *
     * The two flags were independent, and the Keepers lens reads the live list,
     * so archiving a keeper removed it from Keepers and from the Keepers count
     * without saying anything: the star stayed lit on a shot that was no longer
     * in the shortlist it claimed to be in. Keepers is a live shortlist and
     * archive means put away, so one clears the other and the two can never
     * disagree. Restoring does not re-star: the judgement was made once and
     * putting the shot back is not the same as making it again.
     */
    setArchived(id: string, archived: boolean): void {
      if (archived) db.prepare('UPDATE nodes SET archived=1, kept=0 WHERE id=?').run(id);
      else db.prepare('UPDATE nodes SET archived=0 WHERE id=?').run(id);
    },
    /** Permanent. Orphans any children rather than blocking or cascading —
     * same technique collapseProjects already uses for a surplus root. */
    deleteNode(id: string): void {
      db.prepare('UPDATE nodes SET parent_id=NULL WHERE parent_id=?').run(id);
      db.prepare('DELETE FROM nodes WHERE id=?').run(id);
    },
    setBrief(id: string, brief: unknown): void {
      db.prepare('UPDATE nodes SET brief=? WHERE id=?').run(JSON.stringify(brief), id);
    },
    setOverlays(id: string, overlays: Record<string, unknown[]>): void {
      db.prepare('UPDATE nodes SET overlays=? WHERE id=?').run(JSON.stringify(overlays), id);
    },

    // settings
    getSetting(key: string): string | null {
      const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
      return r ? r.value : null;
    },
    setSetting(key: string, value: string): void {
      db.prepare(
        'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run(key, value);
    },
    allSettings(): Record<string, string> {
      const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
  };
}

export type Store = ReturnType<typeof createStore>;
