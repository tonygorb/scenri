import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Popover, Select, Spinner } from '@radix-ui/themes';
import { ArrowUp, Info, Lightning, Plus, SlidersHorizontal, X } from '@phosphor-icons/react';
import {
  api,
  imgUrl,
  nodeLabel,
  uploadImage,
  type Brand,
  type BriefPreview,
  type EngineInfo,
  type TreeNode,
} from '../api.js';
import { effectiveCategory } from '../productCategories.js';
import {
  briefTokens,
  BriefInput,
  emptySentence,
  FORMATS,
  type BriefInputHandle,
  type BriefToken,
  type SentenceToken,
} from '../composer/BriefInput.js';
import { AttachPanel, type AttachTab } from '../composer/AttachPanel.js';
import { BrandInherited } from '../composer/BrandInherited.js';
import {
  openOnGroup,
  RESOLUTIONS,
  ShotSettings,
  ShotSettingsFields,
  ShotSettingsPills,
  type QualityId,
} from '../composer/ShotSettings.js';
import { useOpenSettings, useOpenSetup } from '../app/dialogs.js';
import { effectiveEngineId, engineTitle, FALLBACK_ENGINE_ID } from '../engines/active.js';
import { sizingOf } from '../engines/capabilities.js';
import { OpenAIMark } from './OpenAIMark.js';
import { useAppData } from '../app/AppShell.js';
import { useBrand } from '../app/BrandLayout.js';
import { PREF, useLocalPref, useRecipeSetting } from '../prefs.js';
import { useToasts } from '../toasts.js';
import { clearDraft, isNonTrivial, loadDraft, saveDraft } from '../draft.js';
import { useIngredientCatalog } from '../composer/useIngredientCatalog.js';
import { resolveSceneSwitch } from '../composer/applyScene.js';
import { failureToast } from '../failure.js';
import { attachedIdsKey, attachedIdsOf, type AttachedIds } from './railSections.js';

export interface ComposerHandle {
  /** Append a token to the brief (assets panel click path). */
  insertToken: (t: SentenceToken) => void;
  /** Attach a scene by id (assets panel click path). */
  applyScene: (id: string) => void;
  /** Open the attach panel on a tab, the way "New photoshoot" does. */
  openAttach: (tab: AttachTab) => void;
  focus: () => void;
  /** Run the brief as it stands. cmd+enter from anywhere reaches this. */
  submit: () => void;
}

/**
 * One field, one row. Everything attachable lives behind a single Attach
 * control, so the composer never becomes a control panel.
 */
export const Composer = forwardRef<
  ComposerHandle,
  {
    projectId: string | null;
    brand: Brand;
    engines: EngineInfo[];
    parent: TreeNode | null;
    shots: TreeNode[];
    initialBrief?: {
      tokens: BriefToken[];
      templateId?: string;
      templateFields?: Record<string, string>;
      /** A curated example's own settings; absent on an ordinary remix. */
      variants?: number;
      quality?: QualityId;
    } | null;
    /**
     * A showcase recipe is on its way in via `initialBrief`, but hasn't landed
     * on this render yet (it arrives a commit later, from Create's own
     * effect) — known synchronously from the raw URL param, so the
     * draft-restore branch below never fires for content that's about to be
     * overwritten anyway, which would otherwise flash a stale "picked up
     * where you left off" banner for a draft the user never actually sees.
     */
    suppressDraftRestore?: boolean;
    /** Scene chosen before this project existed: seed it into the brief. */
    startScene?: string;
    /** A presenter picked from its own page, seeded the same way as a scene. */
    startPresenter?: string;
    /** A product picked from its own page, seeded the same way as a scene. */
    startProduct?: string;
    /** Open the attach panel on this tab as soon as the composer mounts. */
    openAttachTab?: AttachTab;
    /**
     * The shot that was queued, so a caller filtered to a set can claim it.
     * The kind travels with it because only the caller can act on what it
     * means: a refine moves the chip onto the version it just made.
     */
    onQueued: (nodeId?: string, kind?: 'generation' | 'edit') => void;
    /**
     * A submit is in flight, with the prose of the brief that started it, so a
     * feed can stand something in for the shot before the server has answered.
     * Cleared here only on failure: on success the caller clears it once the
     * real shot has actually landed, or the tile would blink out and back in.
     */
    onSending?: (text: string | null) => void;
    /**
     * Which assets the brief holds, published whenever that set changes.
     *
     * The rail ticks what is attached, and it cannot read a contenteditable.
     * Keyed rather than fired on every `sentence` change on purpose: the
     * sentence is a new array per keystroke, and re-rendering the rail while
     * someone types would be a jumping panel.
     */
    onAttached?: (ids: AttachedIds) => void;
    /**
     * The shot this brief will branch from, chosen with Branch. Null means a
     * new shot, which is the resting state and the only other one there is.
     */
    target?: TreeNode | null;
    /** Given only where the target can be dropped, which is where it is shown. */
    onClearTarget?: () => void;
    /**
     * Which image of the target to refine. The server defaults to the first,
     * so refining while looking at variant three used to silently edit variant
     * one — the picture on screen was not the picture being worked on.
     */
    sourceImage?: string;
    /** A restored draft's branch target: apply it without stealing focus. */
    onRestoreBranchId?: (id: string) => void;
    /** Which set the draft was written from, carried for information only. */
    setSlug?: string | null;
    /**
     * Whether this composer owns the brand's saved draft. There is one draft
     * per brand and more than one composer on screen — the dock keeps one, and
     * an open shot mounts another — so the second one says no: opening a shot
     * used to overwrite a typed draft with its own empty sentence, and leave
     * behind a branch target nobody had asked for.
     */
    persistDraft?: boolean;
  }
>(function Composer(
  {
    projectId,
    brand,
    engines,
    parent,
    shots,
    initialBrief,
    suppressDraftRestore,
    startScene,
    startPresenter,
    startProduct,
    openAttachTab,
    onQueued,
    onSending,
    onAttached,
    target,
    onClearTarget,
    sourceImage,
    onRestoreBranchId,
    setSlug,
    persistDraft = true,
  },
  handleRef,
) {
  const { products: libraryProducts } = useBrand();
  const { demoProducts, loaded } = useAppData();
  /**
   * The brand's own scenes and presenters, ahead of the curated catalogs.
   *
   * Every consumer below takes these two lists: the attach panel, the sigil
   * menus, the chips, the scene-switch policy, and the per-chip warnings.
   * Missing any one of them would be worse than cosmetic — BriefInput drops a
   * token it cannot resolve, so a restored draft carrying a custom scene would
   * come back silently without it. The merge itself lives in
   * `useIngredientCatalog` now, which is also what the rail reads, so the two
   * cannot answer differently about what this brand owns.
   */
  const composerCatalog = useIngredientCatalog();
  const templates = composerCatalog.scenes;
  const presenters = composerCatalog.presenters;
  const openSettings = useOpenSettings();
  const openSetup = useOpenSetup();
  const { push } = useToasts();
  const usable = engines.filter((e) => e.available);
  const [engineId, setEngineId] = useLocalPref(PREF.engine, FALLBACK_ENGINE_ID);
  useEffect(() => {
    const next = effectiveEngineId(usable, engineId);
    if (next !== engineId) setEngineId(next);
  }, [usable, engineId, setEngineId]);

  // Nothing to generate with is stated where it applies: directly above the
  // brief, in a card built from the same material as the prompt card, so the
  // two read as a pair rather than as an alert dropped on the page.
  const setupNeeded =
    usable.length === 0 && engines.some((e) => e.code === 'not-installed' || e.code === 'not-authenticated');
  const noEngine = usable.length === 0;
  const engineNote = noEngine
    ? setupNeeded
      ? {
          // The mark of the thing the person actually brings: a ChatGPT account.
          // Codex CLI is our plumbing, and its name means nothing to someone who
          // has never opened a terminal. See OpenAIMark for the licensing.
          icon: <OpenAIMark />,
          title: 'Image generation is not set up yet',
          detail: 'About a minute, using the ChatGPT account you already have.',
          action: 'Set up' as const,
          onAct: () => openSetup(),
          info: true,
        }
      : {
          icon: <Lightning size={15} />,
          title: 'No image provider connected',
          detail: 'Add a provider key and this brief is ready to run.',
          action: 'Open settings' as const,
          onAct: () => openSettings('engines'),
          info: false,
        }
    : null;

  const [sentence, setSentence] = useState<SentenceToken[]>(emptySentence());
  const [seedTokens, setSeedTokens] = useState<SentenceToken[] | undefined>(undefined);
  const [formatId, setFormatId, borrowFormat] = useRecipeSetting(PREF.format, 'square');
  const [tplFields, setTplFields] = useState<Record<string, string>>({});
  const [count, setCount, borrowCount] = useRecipeSetting(PREF.count, 2);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<BriefPreview | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachTab, setAttachTab] = useState<AttachTab>('All');
  const [quality, setQuality, borrowQuality] = useRecipeSetting<QualityId>(PREF.quality, 'standard');
  const [uploading, setUploading] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const briefRef = useRef<BriefInputHandle>(null);
  const attachRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // per-brand draft persistence: an unsent brief must survive a navigation, a
  // brand switch, or a closed tab, none of which reliably unmount this component
  const contentRef = useRef({ tokens: sentence, tplFields, branchId: target?.id ?? null });
  contentRef.current = { tokens: sentence, tplFields, branchId: target?.id ?? null };
  const draftBrandIdRef = useRef<string | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Which `?scene=` value has already been applied, so a re-render with the
   * same value doesn't reapply it, but a genuinely new one still does. */
  const lastAppliedStartScene = useRef<string | undefined>(undefined);
  /** Same idea as above, for `?presenter=` and `?product=` — these just append
   * rather than swap, since a brief can carry more than one of either. */
  const lastAppliedStartPresenter = useRef<string | undefined>(undefined);
  const lastAppliedStartProduct = useRef<string | undefined>(undefined);

  const flushDraft = useCallback(
    (brandId: string) => {
      if (draftTimer.current) {
        clearTimeout(draftTimer.current);
        draftTimer.current = null;
      }
      // A composer that does not own the draft must not clear it either: an
      // open shot's empty sentence is not evidence that the dock's brief was
      // abandoned.
      if (!persistDraft) return;
      const c = contentRef.current;
      // Restoring is deliberately silent. It used to announce itself in a row
      // above the brief, on every return to Create, which is a notice about
      // something already on screen in the user's own words. Everything that
      // notice offered is reachable without it: emptying the brief clears the
      // stored draft on this very line, a restored branch target arrives as the
      // Refining chip with its own X, and a scene's fields belong to the scene
      // chip you can remove.
      if (isNonTrivial(c.tokens, c.tplFields, c.branchId)) saveDraft(brandId, { ...c, setSlug });
      else clearDraft(brandId);
    },
    [setSlug, persistDraft],
  );

  // "New photoshoot" opens the attach panel; this is orthogonal to whatever
  // draft may or may not restore, so it's independent of the hydrate effect
  useEffect(() => {
    if (openAttachTab) {
      setAttachTab(openAttachTab);
      setAttachOpen(true);
    }
  }, [openAttachTab]);

  useEffect(() => {
    if (!initialBrief) return;
    // a stored brief carries its size too: lift it back out of the sentence
    const carriedFormat = (initialBrief.tokens ?? []).find((t) => t.t === 'format') as
      | Extract<BriefToken, { t: 'format' }>
      | undefined;
    // A curated example was shot at a chosen shape, variant count and
    // resolution. Left to the visitor's own prefs, a 4-variant catalog example
    // could open as a single draft frame and stop matching the tile it came
    // from. Borrowed for this brief rather than written: looking at an example
    // is not a decision about what every later shot should be. The shape used
    // to be the exception here, so opening one 16:9 example permanently
    // rewrote the default aspect of every shot after it.
    if (carriedFormat) borrowFormat(carriedFormat.id);
    if (initialBrief.variants) borrowCount(initialBrief.variants);
    if (initialBrief.quality) borrowQuality(initialBrief.quality);
    setSeedTokens(briefTokens(initialBrief));
    setTplFields(initialBrief.templateFields ?? {});
  }, [initialBrief]);

  /**
   * A brand switch does not remount this component (only the set route keys
   * on it), so this effect is what notices: it flushes whatever the outgoing
   * brand was holding, then hydrates the incoming brand's own saved draft —
   * unless a Remix is already claiming this mount, which is a genuine
   * full-brief replacement and should win over a silently restored one.
   *
   * A `?scene=` seed is deliberately NOT in that same "wins over restore"
   * bucket: it is folded into whatever this pass resolves as the base state
   * (restored or empty) and merged through the same `resolveSceneSwitch`
   * policy every other scene-attach entry point uses, so "Use in a shot" from
   * the Scenes page reads as attaching a scene to your draft, not replacing it.
   */
  useEffect(() => {
    const prior = draftBrandIdRef.current;
    if (prior && prior !== brand.id) flushDraft(prior);

    // a composer that does not own the draft does not restore one either
    const hasExplicitSeed = !!initialBrief || !!suppressDraftRestore || !persistDraft;
    let tokens: SentenceToken[] | null = null;
    let tplFieldsToApply: Record<string, string> | null = null;
    let branchIdToApply: string | null = null;

    if (!hasExplicitSeed) {
      const draft = loadDraft(brand.id);
      if (draft && isNonTrivial(draft.tokens, draft.tplFields, draft.branchId)) {
        tokens = draft.tokens;
        tplFieldsToApply = draft.tplFields;
        branchIdToApply = draft.branchId;
      }
    }

    if (startScene && startScene !== lastAppliedStartScene.current) {
      lastAppliedStartScene.current = startScene;
      const base = tokens ?? emptySentence();
      const existingTok = base.find((t) => t.t === 'template') as Extract<SentenceToken, { t: 'template' }> | undefined;
      const existingSceneId = existingTok?.id ?? null;
      const priorBranchId = branchIdToApply;
      const sceneName = templates.find((t) => t.id === startScene)?.name ?? 'this scene';
      const branchNode = priorBranchId ? shots.find((s) => s.id === priorBranchId) : null;
      const result = resolveSceneSwitch(
        existingSceneId,
        startScene,
        sceneName,
        priorBranchId,
        branchNode ? nodeLabel(branchNode) : null,
      );
      if (result.changed) {
        tokens = [{ t: 'template', id: startScene }, ...base.filter((t) => t.t !== 'template')];
        if (result.toast?.branchWasCleared) branchIdToApply = null;
        if (result.toast) {
          const toast = result.toast;
          push({
            kind: 'success',
            title: toast.title,
            action: {
              label: 'Undo',
              onClick: () => {
                if (toast.prevSceneId) briefRef.current?.insert({ t: 'template', id: toast.prevSceneId });
                else briefRef.current?.removeTemplate();
                if (toast.branchWasCleared && priorBranchId) onRestoreBranchId?.(priorBranchId);
              },
            },
          });
        }
      }
    }

    // Presenter and product seeds just append — unlike a scene there is no
    // single slot to swap, so no resolveSceneSwitch-style policy is needed.
    // Each still checks the base it is appending onto for its own id first:
    // a fresh mount resets `lastApplied*` to undefined, so arriving back at
    // the same `?presenter=`/`?product=` URL (a remount via back/forward, or
    // clicking "Use" again) must not re-add something the restored draft
    // already carries.
    if (startPresenter && startPresenter !== lastAppliedStartPresenter.current) {
      lastAppliedStartPresenter.current = startPresenter;
      const base = tokens ?? emptySentence();
      const already = base.some((t) => t.t === 'character' && t.id === startPresenter);
      if (!already) tokens = [...base, { t: 'character', id: startPresenter }];
    }
    if (startProduct && startProduct !== lastAppliedStartProduct.current) {
      lastAppliedStartProduct.current = startProduct;
      const base = tokens ?? emptySentence();
      const already = base.some((t) => t.t === 'product' && t.id === startProduct);
      if (!already) tokens = [...base, { t: 'product', id: startProduct }];
    }

    if (tokens) {
      setSeedTokens(tokens);
      setTplFields(tplFieldsToApply ?? {});
      if (branchIdToApply) onRestoreBranchId?.(branchIdToApply);
    }
    draftBrandIdRef.current = brand.id;
    // deliberately keyed on brand.id + the three seed props: this must run
    // once per brand, and again whenever any of them takes on a new value
  }, [brand.id, startScene, startPresenter, startProduct]);

  useEffect(() => {
    if (!seedTokens) return;
    briefRef.current?.setTokens(seedTokens);
    setSeedTokens(undefined);
  }, [seedTokens]);

  /**
   * Size is the composer's, not the sentence's. It renders as nothing, so
   * keeping it in the token list meant every aspect or quality change repainted
   * the line and took the caret with it.
   */
  const format = useMemo(() => {
    const f = FORMATS.find((x) => x.id === formatId) ?? FORMATS[0];
    const edge = RESOLUTIONS.find((x) => x.id === quality)?.edge ?? 1024;
    const scale = edge / Math.max(f.w, f.h);
    const round8 = (n: number) => Math.max(256, Math.round((n * scale) / 8) * 8);
    return { t: 'format' as const, id: f.id, w: round8(f.w), h: round8(f.h) };
  }, [formatId, quality]);

  const tokens = useMemo<BriefToken[]>(() => [format, ...sentence], [format, sentence]);
  /**
   * The settings ride along with the sentence, because a recipe that cannot
   * reproduce its own shot is not a recipe: a retry of a four-variant run used
   * to come back with one frame, and reusing a setup dropped to whatever the
   * visitor's own prefs happened to say. The compiler reads `tokens` and
   * ignores the rest, so these are stored rather than compiled.
   */
  const brief = useMemo(
    () => ({ tokens, templateFields: tplFields, variants: count, quality, format: formatId }),
    [tokens, tplFields, count, quality, formatId],
  );
  const hasContent = sentence.some((t) => (t.t === 'text' ? !!t.v.trim() : true));
  /** The template now lives in the sentence, so read it back from the tokens. */
  const template = useMemo(() => {
    const tok = sentence.find((t) => t.t === 'template') as Extract<SentenceToken, { t: 'template' }> | undefined;
    return tok ? (templates.find((x) => x.id === tok.id) ?? null) : null;
  }, [sentence, templates]);
  const templateTokenId = useMemo(() => {
    const tok = sentence.find((t) => t.t === 'template') as Extract<SentenceToken, { t: 'template' }> | undefined;
    return tok?.id ?? null;
  }, [sentence]);

  /**
   * The one shared policy behind every live scene-attach entry point (the
   * Assets rail, the AttachPanel's Scenes tab, and `/` at the caret) — decides
   * through `resolveSceneSwitch`, applies through the same `insert`/
   * `removeTemplate` mechanics `place()` already uses for everything else.
   */
  const applyScene = useCallback(
    (sceneId: string) => {
      const existingSceneId = template?.id ?? null;
      const branchId = target?.id ?? null;
      const sceneName = templates.find((t) => t.id === sceneId)?.name ?? 'this scene';
      const result = resolveSceneSwitch(
        existingSceneId,
        sceneId,
        sceneName,
        branchId,
        target ? nodeLabel(target) : null,
      );
      if (!result.changed) return;
      briefRef.current?.insert({ t: 'template', id: sceneId });
      if (result.toast) {
        const toast = result.toast;
        push({
          kind: 'success',
          title: toast.title,
          action: {
            label: 'Undo',
            onClick: () => {
              if (toast.prevSceneId) briefRef.current?.insert({ t: 'template', id: toast.prevSceneId });
              else briefRef.current?.removeTemplate();
              if (toast.branchWasCleared && branchId) onRestoreBranchId?.(branchId);
            },
          },
        });
      }
    },
    [template, target, templates, push, onRestoreBranchId],
  );

  useImperativeHandle(handleRef, () => ({
    insertToken: (t) => briefRef.current?.insert(t),
    applyScene: (id) => applyScene(id),
    openAttach: (tab) => openAttach(tab),
    focus: () => briefRef.current?.focus(),
    submit: () => {
      void go();
    },
  }));

  // Derived here rather than in the rail because this is the only place the
  // live sentence exists. The key is what the effect watches, so typing text
  // around the chips publishes nothing.
  const attached = useMemo(() => attachedIdsOf(sentence), [sentence]);
  const attachedKey = attachedIdsKey(attached);
  const attachedRef = useRef(attached);
  attachedRef.current = attached;
  useEffect(() => {
    onAttached?.(attachedRef.current);
  }, [attachedKey, onAttached]);

  // a `?scene=` id (or a restored draft) that no longer resolves must not sit as
  // a silent, still-submittable chip — mirrors Create.tsx's stale-branch-target
  // toast for the same class of problem
  useEffect(() => {
    if (!loaded || !templateTokenId || template) return;
    briefRef.current?.removeTemplate();
    push({ kind: 'error', title: 'That scene is no longer available.', detail: 'Starting from scratch.' });
  }, [loaded, templateTokenId, template, push]);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!hasContent) {
      setPreview(null);
      return;
    }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      void api
        .previewBrief(brief, engineId, brand.id)
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 280);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [brief, engineId, brand.id, hasContent]);

  // the draft is owed to whichever brand it belongs to, not necessarily the
  // one currently in `brand.id` — see the hydrate effect above
  useEffect(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => flushDraft(draftBrandIdRef.current ?? brand.id), 500);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [sentence, tplFields, target?.id, brand.id, flushDraft]);

  useEffect(() => {
    // brand.id intentionally omitted from deps: an unmount must flush whatever
    // brand the content actually belongs to, not whatever brand.id is by then
    return () => flushDraft(draftBrandIdRef.current ?? brand.id);
  }, [flushDraft]);

  useEffect(() => {
    const onLeave = () => flushDraft(draftBrandIdRef.current ?? brand.id);
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [flushDraft, brand.id]);

  const engine = engines.find((e) => e.id === engineId);
  /** The engine's name as a person says it, for the lines that name it. */
  const engineLabel = engine ? engineTitle(engine.displayName) : 'This engine';

  /**
   * What this brief will do, and why.
   *
   * Mode used to be inferred from whichever shot the screen had quietly
   * selected, so the send button changed meaning on its own and the only way to
   * find out which one you were about to get was to press it. Now a branch is
   * something you ask for: `target` is set by Branch and by nothing else.
   *
   * Two things overrule a target, and both say so on screen rather than
   * silently doing the other thing:
   *  - an engine that cannot edit has nothing to branch with
   *  - a scene is a fresh setup, so it starts a new shot by definition
   */
  /**
   * The version this brief is pointed at is still rendering. It counts as a
   * target — the chip stays, so the thread of what you are working on is not
   * dropped — but it cannot be refined until there is a picture to refine.
   */
  const targetPending = !!target && target.kind !== 'root' && target.status === 'running';
  const branchable =
    (target && target.kind !== 'root' && target.status === 'done' && target.images.length > 0) || targetPending;
  const engineCanEdit = !!engine?.supportsEdit;
  /**
   * A scene is checked here and not only in the effect below, because the
   * effect can only speak where the target can be dropped. Inside an open shot
   * the target is the shot itself and there is no chip to let go, so attaching
   * a scene there used to quietly run as an edit of the picture on screen —
   * the one thing a scene is defined not to be.
   */
  /**
   * Asking for a different shape is asking for a different photograph.
   *
   * An edit request carries no width or height at all: the engine is handed the
   * picture and an instruction and returns one the same shape. So the aspect
   * control could either vanish here — which left people asking how to get the
   * same setup at 16:9, with the answer being a differently-named button two
   * blocks away — or stay, and mean what it says by running as a new shot from
   * this setup. It stays. This is the same rule a scene already follows, for
   * the same reason: some changes cannot be made to a picture, only to a brief.
   */
  const reshaping = !!target && !!target.brief?.format && target.brief.format !== formatId;
  const mode: 'generation' | 'edit' = branchable && engineCanEdit && !template && !reshaping ? 'edit' : 'generation';
  const targetNote = !branchable
    ? null
    : template
      ? 'A scene starts a new shot.'
      : reshaping
        ? 'A new shape starts a new shot from this setup.'
        : !engineCanEdit
          ? `${engine?.displayName ?? 'This engine'} cannot edit. This makes a new shot.`
          : targetPending
            ? 'Still rendering. This can be refined the moment it lands.'
            : null;

  /**
   * What is currently set, so the one control can still say it out loud.
   *
   * Display labels, never the stored ids: this used to announce "Aspect
   * portrait, quality high". And on a refinement it named the one setting that
   * surface does not contain, because a refine carries no size.
   */
  const settingsSummary = useMemo(() => {
    const f = FORMATS.find((x) => x.id === formatId) ?? FORMATS[0];
    const shape = `Aspect ${f.label} ${f.hint}`;
    if (mode === 'edit') return shape;
    const r = RESOLUTIONS.find((x) => x.id === quality);
    const sizing = sizingOf(engineId);
    // Spoken aloud, "resolution High 1536 px" is a claim. On an engine that is
    // only asked for a size it is a request, and the summary says which.
    const size =
      sizing === 'ratio' || !r
        ? null
        : sizing === 'advisory'
          ? `${r.label}, asking for ${r.edge} px`
          : `${r.label} ${r.edge} px`;
    return [shape, `${count} variants`, size && `resolution ${size}`].filter(Boolean).join(', ');
  }, [mode, formatId, count, quality, engineId]);

  /**
   * A scene is a fresh setup, so it cannot also be an edit of an existing shot.
   * Rather than explain that in a sentence nobody asked for, the branch simply
   * lets go: the scene chip appears and the branch chip disappears, which is the
   * same fact told in the place you are already looking.
   */
  useEffect(() => {
    if (template && branchable && onClearTarget) onClearTarget();
  }, [template, branchable, onClearTarget]);
  // A scene that wants a product still runs without one: it says "the product"
  // instead. Nine of ten ask for one, so refusing here meant a brand with no
  // products could never generate at all. Warn, allow.
  //
  // The phrase is the compiler's, from packages/cli/src/brief.ts: change the
  // wording there and this stops matching, with nothing to say it has.
  const blocking = preview?.warnings.filter((w) => w.includes('built around a product')) ?? [];
  // the workspace arrives a beat after the screen does, and typing is faster
  // than a round trip: without this the first brief of a cold load could be sent
  // into nothing and come back as an error the user did nothing to cause.
  //
  // A version still rendering also holds the button: sending now would quietly
  // make a new shot instead of continuing the one on the chip, which is the
  // exact silent substitution this composer exists not to do.
  const canGo = !busy && hasContent && !!projectId && !targetPending && !noEngine;
  /** Why the button will not go, in the words of the thing that is blocking. */
  const blockedReason = noEngine
    ? 'Image generation is not set up yet'
    : busy
      ? 'Working on the last one'
      : !projectId
        ? 'Still opening this brand'
        : targetPending
          ? 'Wait for this version to finish, or press X to start a new shot'
          : !hasContent
            ? 'Write a brief first'
            : null;

  /**
   * Choosing from one of these menus hands the caret straight back, rather than
   * waiting for the menu to finish closing: Radix restores focus to the trigger
   * on close, and a keystroke that arrives in between would be lost.
   */
  const setFormat = (id: string) => {
    setFormatId(id);
    briefRef.current?.focus();
  };
  const setQualityId = (q: QualityId) => {
    setQuality(q);
    briefRef.current?.focus();
  };
  const setVariants = (n: number) => {
    setCount(n);
    briefRef.current?.focus();
  };
  /**
   * A Radix menu returns focus to its trigger on close, so picking an aspect or
   * a quality left the brief without a caret and the next keystroke went
   * nowhere. Focus moved away for real here, so handing it back is a genuine
   * transition and the editing caret is re-established with it.
   */
  const backToBrief = (e: Event) => {
    e.preventDefault();
    briefRef.current?.focus();
  };

  const openAttach = (tab: AttachTab) => {
    setAttachTab(tab);
    setAttachOpen(true);
  };
  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    // the file <input> already filters to accept="image/*"; a drop has no such
    // OS-level filter, so this is the one place both paths get one
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (!images.length) {
      push({ kind: 'error', title: 'Only images can be attached here' });
      return;
    }
    setUploading(true);
    setErr(null);
    try {
      for (const f of images.slice(0, 4)) {
        const hash = await uploadImage(f);
        // the same caret-aware insert every other pick uses: appending through
        // state repainted the line while focus was on the file dialog, which
        // dropped the caret and left the brief untypeable
        briefRef.current?.insert({ t: 'ref', imageHash: hash });
      }
    } catch (e: any) {
      setErr(String(e.message ?? e));
      push(failureToast(e, 'Could not attach that image'));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // warnings live ON the affected chip, not as sentences in the card
  const templateFlag = !template
    ? null
    : blocking.length > 0
      ? 'This scene builds around a product. Attach one.'
      : // The person half of the same compiler warning had no chip to sit on,
        // so a scene needing a presenter said nothing at all until the picture
        // came back with a stranger in it.
        (preview?.warnings.some((w) => w.includes('built around a person')) ?? false)
        ? 'This scene builds around a person. Attach a presenter.'
        : null;
  const flagToken = (t: BriefToken): string | null => {
    if (t.t === 'template') return templateFlag;
    if (!preview) return null;
    if (t.t === 'ref' && !preview.attachments.some((a) => a.hash === t.imageHash)) {
      return `${engine?.displayName ?? 'This engine'} cannot read this reference, so it is left out.`;
    }
    if (t.t === 'product') {
      // Demo products live in their own list, so a chip naming one resolved to
      // nothing here and silently skipped the check — exactly the products the
      // homepage examples are built from.
      const products = libraryProducts.length ? libraryProducts : (brand.json?.products ?? []);
      const p = products.find((x: any) => x.id === t.id) ?? demoProducts.find((x) => x.id === t.id);
      // Match on id, never on label: a display name is free to differ from the
      // descriptive phrase the compiler labels the attachment with, and two
      // products may legitimately share a name.
      if (p && !preview.attachments.some((a) => a.role === 'product' && a.id === p.id)) {
        return `${engine?.displayName ?? 'This engine'} cannot read the product image, so ${p.name} rides as text only.`;
      }
    }
    // A presenter is an identity too. Without this, a face the engine could not
    // carry was dropped with no mark on the chip that asked for it — the same
    // silence the product case above already fixed.
    if (t.t === 'character') {
      const c = presenters.find((x) => x.id === t.id);
      if (c && !preview.attachments.some((a) => a.role === 'character' && a.id === c.id)) {
        return `${engine?.displayName ?? 'This engine'} cannot read the person reference, so ${c.name} rides as text only.`;
      }
    }
    return null;
  };

  const go = async () => {
    if (!canGo) return;
    setBusy(true);
    setErr(null);
    // the prose only: chips are pictures, and this is a one-line caption for a
    // tile that exists for a second or two
    const said = sentence
      .flatMap((t) => (t.t === 'text' ? [t.v] : []))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    onSending?.(said || 'Your shot');
    try {
      // the brand's workspace always exists by the time a brief can be run; a
      // missing one is a load that has not landed, not a container to invent
      if (!projectId) throw new Error('the workspace is still loading');
      const created = await api.addNode({
        projectId,
        // an edit hangs off the shot it edits; anything else hangs off the
        // root, so a brief that only *looked* like a branch is not filed as a
        // version of a shot it never used
        parentId: mode === 'edit' && target ? target.id : (parent?.id ?? null),
        kind: mode,
        engineId,
        count,
        brief,
        // refine works from the picture you are looking at, not from whichever
        // one the run happens to have first
        ...(mode === 'edit' && sourceImage ? { sourceImage } : {}),
      });
      /*
       * A scene used to be able to declare text zones, and this turned them
       * into editable layers on every variant as the shot was queued. No scene
       * in the catalog has ever declared one — 0 of 72 — so this ran for
       * nobody while sitting in the middle of the one path every brief takes.
       * `Scene.textZones` still exists in the schema; if a scene ever carries
       * zones again, this belongs here.
       */
      // The compiler's own account of what it had to do without. These name
      // real fidelity risks and the server has always sent them back on the
      // accepted shot; nothing read them, so a brief could quietly go out
      // degraded and the first sign of it was the picture.
      const warned = created.warnings?.[0];
      if (warned) push({ kind: 'success', title: 'Sent, with one thing to know', detail: warned });

      briefRef.current?.setTokens(emptySentence());
      setTplFields({});
      // the borrowed settings belonged to the brief that just left the screen
      borrowFormat(null);
      borrowCount(null);
      borrowQuality(null);
      if (persistDraft) clearDraft(brand.id);
      onQueued(created.id, mode);
    } catch (e: any) {
      const message = String(e.message ?? e);
      // A failed send is an event, and this app already has one place for
      // events: the same toast the success path above uses. It had its own
      // card above the composer, which meant a transient failure permanently
      // owned layout and stacked on top of whatever else the input had to say.
      // Errors are never trimmed and outlive successes (see ToastProvider), so
      // nothing is lost by not building a second surface for them.
      setErr(message);
      push({ kind: 'error', title: 'That did not send', detail: message });
      // the brief is deliberately not cleared above until the shot exists, so
      // everything typed is still on screen to send again
      onSending?.(null);
    } finally {
      setBusy(false);
    }
  };

  const activeProductId = sentence.find((t) => t.t === 'product')?.id;
  /**
   * The category behind every "Suited to X" lift.
   *
   * Resolved across all three places a product token can point — the live
   * library, brand.json, and the Scenri library — and through
   * `effectiveCategory`, which falls back to the guess a catalog import's
   * productType supports. Reading `p.category` raw off `libraryProducts` alone
   * meant a demo product resolved to nothing, so the homepage's own examples
   * were exactly the briefs that got no recommendations at all.
   */
  const activeProduct = activeProductId
    ? (libraryProducts.find((p) => p.id === activeProductId) ??
      ((brand.json?.products ?? []) as any[]).find((p: any) => p.id === activeProductId) ??
      demoProducts.find((p) => p.id === activeProductId) ??
      null)
    : null;
  const activeProductCategory = activeProduct ? effectiveCategory(activeProduct as any) : null;

  return (
    <div className="sc-composer">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => void pickFiles(e.target.files)}
      />

      {attachOpen && (
        <AttachPanel
          brand={brand}
          activeProductCategory={activeProductCategory}
          shots={shots}
          initialTab={attachTab}
          onUpload={() => fileRef.current?.click()}
          onToken={(t) => briefRef.current?.insert(t)}
          onTemplate={(id) => applyScene(id)}
          onClose={() => setAttachOpen(false)}
        />
      )}
      {/* A refusal is written for a person to act on — which engine cannot carry
          the product, which cap was hit — and it used to reach the screen only
          as the send button's tooltip, where nobody looks after a click that
          appeared to do nothing. It sits closest to the card because it is
          about the brief still sitting in it. */}
      {/* Everything this composer has to say about itself, in one tray docked
          above the card and inset from its edges, so it reads as subordinate to
          the input rather than as a second surface of equal weight.
          One tray, not one card per notice: two notices used to stack into three
          boxes, which is what read as unfinished. */}
      {engineNote && (
        <div className="sc-notes">
          {engineNote && (
            <div className="sc-banner" data-tone="action">
              <span className="sc-banner-ic">{engineNote.icon}</span>
              <span className="sc-banner-txt">
                <b>{engineNote.title}</b>
                <small>
                  {engineNote.detail}
                  {engineNote.info && (
                    <Popover.Root>
                      <Popover.Trigger>
                        <button
                          type="button"
                          className="sc-note-info"
                          aria-label="What a ChatGPT account has to do with this"
                        >
                          <Info size={13} />
                        </button>
                      </Popover.Trigger>
                      <Popover.Content className="sc-note-pop" align="start" sideOffset={8} width="300px">
                        <p>
                          Codex CLI signs in with your ChatGPT account and makes the images there. Every plan includes
                          some Codex usage, so how many images you get depends on the plan you are on.
                        </p>
                        <p>No ChatGPT account, or run out for now? Use your own key from an image provider instead.</p>
                        <p className="sc-note-pop-fine">
                          Scenri never sees your password or token. The sign-in happens in your browser and stays with
                          Codex.
                        </p>
                        <button type="button" className="sc-btn sc-btn-ghost" onClick={() => openSettings('engines')}>
                          Use a provider key instead
                        </button>
                      </Popover.Content>
                    </Popover.Root>
                  )}
                </small>
              </span>
              <button type="button" className="sc-banner-act" data-primary="" onClick={engineNote.onAct}>
                {engineNote.action}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="sc-promptcard">
        {/* What this brief is about to do, stated before it does it. Only the
            hub can drop a target, so only the hub shows the chip: inside the
            overlay the shot being refined is the whole screen. */}
        {branchable && onClearTarget && (
          <div className="sc-target" data-note={targetNote ? '' : undefined}>
            <span className="sc-target-lb">
              Refining
              {/* a version that has just been asked for has no picture yet, and
                  the same shimmer the feed uses says so without a second word */}
              {target.images[0] ? (
                <img src={imgUrl(target.images[0])} alt="" />
              ) : (
                <span className="sc-target-thumb sc-shimmer" />
              )}
              <b dir="auto">{nodeLabel(target)}</b>
            </span>
            {targetNote && <small className="sc-target-note">{targetNote}</small>}
            <button type="button" className="sc-target-x" onClick={onClearTarget} aria-label="Make a new shot instead">
              <X size={12} />
            </button>
          </div>
        )}
        {/* Where there is no chip to carry it, the note still has to be said:
            inside an open shot this is the only sign that what is about to
            happen is a new shot rather than a change to the one on screen. */}
        {branchable && !onClearTarget && targetNote && (
          <small className="sc-target-note sc-target-note-alone">{targetNote}</small>
        )}
        <BriefInput
          ref={briefRef}
          onChange={setSentence}
          brand={brand}
          shots={shots}
          templates={templates}
          presenters={presenters}
          demoProducts={demoProducts}
          onTemplatePick={applyScene}
          flag={flagToken}
          onAttachRequest={(tab) => openAttach(tab)}
          activeProductCategory={activeProductCategory}
          placeholder={
            template
              ? 'Add art direction, or run it as written'
              : mode === 'edit'
                ? // Not "or describe a new one". Everything typed here is sent as
                  // a change to the picture on the chip: an unrelated brief would
                  // be painted over that photo rather than shot fresh. Starting
                  // something new is what the chip's own X is for, which is why
                  // it is labelled "Make a new shot instead".
                  'Say what to change about this shot'
                : 'What should we shoot? (use $ / @ #)'
          }
          placeholderSm={template || mode === 'edit' ? undefined : 'What should we shoot? ($ / @ #)'}
          onSubmit={() => void go()}
          onDropFiles={(files) => void pickFiles(files)}
        />

        <BrandInherited brandId={brand.id} revision={brand.updatedAt} />

        <div className="sc-prompt-row">
          <div className="sc-prompt-left">
            {/* One click, not two.

                This used to open a menu naming five kinds, and picking one
                opened a panel that already had those same five as tabs. The
                menu was a question the panel then asked again, so it is gone
                and the panel opens on All. The kinds are still one click away,
                as its tabs, and `$` `/` `@` `#` still open the same list inline at
                the caret for anyone who would rather not leave the keyboard. */}
            <button
              type="button"
              ref={attachRef}
              className="sc-icon-btn sc-attach-toggle"
              aria-expanded={attachOpen}
              aria-label="Attach"
              title="Attach a product, a scene, a colour or an image"
              onClick={() => (attachOpen ? setAttachOpen(false) : openAttach('All'))}
            >
              {uploading ? <Spinner size="1" /> : <Plus size={16} />}
            </button>

            {/* A picker with one option is a question with one answer, so with
                a single usable engine there is no picker at all — the engine's
                name lives in Settings, and the menu returns on its own once a
                second engine connects. */}
            {usable.length > 1 && (
              <Select.Root value={engineId} onValueChange={setEngineId}>
                <Select.Trigger variant="ghost" className="sc-mini-sel">
                  <Lightning size={14} />
                  <span className="sc-mini-sel-t">{engine ? engineTitle(engine.displayName) : 'Demo'}</span>
                </Select.Trigger>
                <Select.Content>
                  {usable.map((e) => (
                    <Select.Item key={e.id} value={e.id}>
                      {engineTitle(e.displayName)}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            )}
          </div>

          <div className="sc-prompt-right">
            {/*
              Three shells, one set of settings.

              Where the row is wide and pointer-driven — the desktop hub — the
              three settings are pills and say what they are set to. Where it is
              not — a phone, a tablet, or this same composer in the overlay's
              sidebar, which is 288px no matter how big the screen is — they
              collapse behind one control, because three pills beside the button
              that makes a picture is most of a narrow row spent on
              configuration. All three shells render and CSS picks one, so there
              is never a second trigger for the same thing on screen and never a
              second copy of the state.
            */}
            <ShotSettingsPills
              mode={mode}
              engineId={engineId}
              engineName={engineLabel}
              formatId={formatId}
              onFormat={setFormat}
              count={count}
              onCount={setVariants}
              quality={quality}
              onQuality={setQualityId}
              onCloseAutoFocus={backToBrief}
            />

            <Popover.Root open={moreOpen} onOpenChange={setMoreOpen}>
              <Popover.Trigger>
                <button type="button" className="sc-var sc-more" aria-label={`Shot settings. ${settingsSummary}`}>
                  <SlidersHorizontal size={14} />
                  More
                </button>
              </Popover.Trigger>
              <Popover.Content
                className="sc-morepop"
                align="end"
                sideOffset={8}
                width="300px"
                onOpenAutoFocus={openOnGroup}
                onCloseAutoFocus={backToBrief}
              >
                <ShotSettingsFields
                  mode={mode}
                  engineId={engineId}
                  engineName={engineLabel}
                  formatId={formatId}
                  onFormat={setFormat}
                  count={count}
                  onCount={setVariants}
                  quality={quality}
                  onQuality={setQualityId}
                />
              </Popover.Content>
            </Popover.Root>

            {/* the touch shell for the same fields: a sheet under the thumb */}
            <ShotSettings
              mode={mode}
              engineId={engineId}
              engineName={engineLabel}
              formatId={formatId}
              onFormat={setFormat}
              count={count}
              onCount={setVariants}
              quality={quality}
              onQuality={setQualityId}
            />

            <button
              type="button"
              className="sc-send"
              // aria-disabled: a native disabled button drops out of the tab
              // order, taking its title — often the one thing explaining why
              // — with it. go() already no-ops on !canGo, so this is purely
              // the accessible-name/keyboard-focus fix, not a new guard.
              aria-disabled={!canGo || undefined}
              onClick={() => void go()}
              aria-label={mode === 'edit' ? 'Refine' : 'Generate'}
              // A blocked button that will not say what blocks it is the least
              // helpful control on the screen. The comment above chose
              // aria-disabled precisely so this title could explain itself.
              title={err ?? templateFlag ?? blockedReason ?? `${mode === 'edit' ? 'Refine' : 'Generate'} (enter)`}
            >
              {/* One fixed slot for whichever of the two is showing. The
                  spinner is 12px and the arrow 17px, so swapping them resized
                  the button at the exact moment you had just pressed it. */}
              <span className="sc-send-ico">{busy ? <Spinner size="1" /> : <ArrowUp size={17} weight="bold" />}</span>
              {/* The one control whose meaning changes with the brief, and it
                  used to say so only in a tooltip: whether this makes a new
                  shot or continues an existing one is worth reading before
                  pressing, not after. Hidden by CSS where the row is tight. */}
              <span className="sc-send-lb">{mode === 'edit' ? 'Refine' : 'Generate'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
