import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { FocusScope } from '@radix-ui/react-focus-scope';
import {
  Archive,
  ArrowCounterClockwise,
  ArrowsClockwise,
  ArrowsLeftRight,
  CaretLeft,
  CaretRight,
  CopySimple,
  DotsThree,
  DownloadSimple,
  Star,
  TrashSimple,
  WarningCircle,
  X,
  XCircle,
} from '@phosphor-icons/react';
import { AlertDialog, Button, DropdownMenu, Flex } from '@radix-ui/themes';
import { api, imgUrl, nodeLabel, type Brand, type EngineInfo, type TreeNode } from '../api.js';
import { CompareDialog } from './CompareDialog.js';
import { ExportDialog } from './ExportDialog.js';
import { StageFrame } from './Stage.js';
import { Inspector } from './Inspector.js';
import { Composer } from './Composer.js';
import { Coin } from './Coin.js';
import { useToasts } from '../toasts.js';
import { failureToast } from '../failure.js';
import { briefChangeLine, sourceImageOf } from '../briefDiff.js';
import type { TokenNames } from '../feedRules.js';
import { Ingredients } from './detail/Ingredients.js';
import { useLineage } from './detail/useLineage.js';

/**
 * Full-screen takeover for one shot: lineage filmstrip left, stage with the
 * text editor center, merged inspector plus edit composer right. The version
 * tree stays legible here even though the canvas below is a flat masonry.
 */
export function DetailOverlay({
  node,
  nodes,
  brand,
  engines,
  projectId,
  imageIndex,
  onImageIndex,
  onClose,
  onSelect,
  onRetry,
  onCancel,
  onChanged,
  onRemix,
  onArchive,
  onUnarchive,
  onDelete,
  onRefined,
  tokenNames,
}: {
  node: TreeNode;
  nodes: TreeNode[];
  brand: Brand;
  engines: EngineInfo[];
  projectId: string;
  imageIndex: number;
  onImageIndex: (i: number) => void;
  onClose: () => void;
  onSelect: (id: string) => void;
  onRetry: (n: TreeNode) => void;
  onCancel: (n: TreeNode) => void;
  onChanged: () => Promise<void> | void;
  onRemix: (n: TreeNode) => void;
  onArchive: (n: TreeNode) => void;
  onUnarchive: (n: TreeNode) => void;
  onDelete: (n: TreeNode) => void;
  /** A shot was made from in here, so the workspace can follow the same thread. */
  onRefined?: (nodeId: string, kind?: 'generation' | 'edit') => void;
  /** Ids to display names, for the line saying which ingredient moved. */
  tokenNames: TokenNames;
}) {
  const { ancestors, children, siblings, sibIndex, root, parentShot } = useLineage(nodes, node);
  /** What the engine that ran this is called, so a failure can name it in a sentence. */
  const engine = useMemo(() => engines.find((e) => e.id === node.engineId), [engines, node.engineId]);
  const { push } = useToasts();
  /** The image this refinement was made from, not merely the run's first. */
  const sourceHash = useMemo(() => sourceImageOf(node, parentShot), [node, parentShot]);
  const changeLine = useMemo(
    () => (parentShot ? briefChangeLine(parentShot.brief, node.brief, tokenNames) : null),
    [parentShot, node.brief, tokenNames],
  );
  const [exportOpen, setExportOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const hash = node.images[imageIndex] ?? node.images[0];
  const baseName =
    node.prompt
      .slice(0, 40)
      .replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9-]/g, '') || 'shot';

  const copyImage = async () => {
    try {
      const blob = await (await fetch(imgUrl(hash))).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      push({ kind: 'success', title: 'Copied to clipboard' });
    } catch (e: any) {
      push(failureToast(e, 'Copy failed'));
    }
  };

  // scroll lock while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  /**
   * Everything you can do to the picture itself, as data.
   *
   * The header renders this twice — as a row of buttons where there is room,
   * and as one overflow menu where there is not — so a phone and a desktop
   * cannot end up offering different things, and adding an action never means
   * remembering to add it in two places. Order is priority order: what people
   * reach for most is first, and the destructive one is last.
   */
  type Action = { key: string; label: string; icon: ReactNode; onClick: () => void; tint?: string };

  /** The ones that act on a file, so they are only offered where there is one. */
  const fileActions: Action[] = [
    { key: 'export', label: 'Export', icon: <DownloadSimple size={14} />, onClick: () => setExportOpen(true) },
    {
      key: 'keep',
      label: node.kept ? 'Remove from keepers' : 'Keep',
      icon: <Star size={14} weight={node.kept ? 'fill' : 'regular'} />,
      onClick: () =>
        void api
          .keep(node.id, !node.kept)
          .then(onChanged)
          .catch((e) => push(failureToast(e, 'Could not update keeper status'))),
      tint: node.kept ? 'var(--sc-star)' : undefined,
    },
    { key: 'copy', label: 'Copy image', icon: <CopySimple size={14} />, onClick: () => void copyImage() },
    ...(sourceHash
      ? [
          {
            key: 'compare',
            label: 'Compare with source',
            icon: <ArrowsLeftRight size={14} />,
            onClick: () => setCompareOpen(true),
          },
        ]
      : []),
  ];

  /**
   * Putting a shot away is not a file action, and gating it on a finished
   * picture meant a failed shot opened onto a header with nothing in it but
   * Close — so the only way to get rid of one was to back out to the feed and
   * find it again. These are about the record, which exists either way.
   */
  const keepActions: Action[] = [
    {
      key: 'archive',
      label: node.archived ? 'Restore' : 'Archive',
      icon: node.archived ? <ArrowCounterClockwise size={14} /> : <Archive size={14} />,
      onClick: () => (node.archived ? onUnarchive(node) : onArchive(node)),
    },
    ...(node.archived
      ? [
          {
            key: 'delete',
            label: 'Delete permanently',
            icon: <TrashSimple size={14} />,
            onClick: () => setDeleteConfirmOpen(true),
            tint: 'var(--sc-red)',
          },
        ]
      : []),
  ];

  const hasImage = node.status === 'done' && node.images.length > 0;
  const actions: Action[] = hasImage ? [...fileActions, ...keepActions] : keepActions;

  const frame = (n: TreeNode, current = false) => (
    <button
      type="button"
      key={n.id}
      className="sc-fr"
      data-fb-node={n.id}
      data-current={current}
      data-failed={n.status === 'error' || (!n.images[0] && n.status !== 'running' && n.status !== 'cancelled')}
      data-cancelled={n.status === 'cancelled' && !n.images[0]}
      title={nodeLabel(n)}
      onClick={() => onSelect(n.id)}
    >
      {n.images[0] ? (
        <img src={imgUrl(n.images[0])} alt="" />
      ) : n.status === 'running' ? (
        <span className="sc-shimmer" />
      ) : n.status === 'cancelled' ? (
        <XCircle size={13} />
      ) : (
        <WarningCircle size={13} />
      )}
      {n.kept && (
        <span className="sc-fr-star">
          <Star size={11} weight="fill" />
        </span>
      )}
    </button>
  );

  return createPortal(
    // `loop` as well as `trapped`: without it Tab reached the last control and
    // then did nothing at all — eighteen further presses moved focus nowhere,
    // which reads as a frozen page rather than a contained one.
    <FocusScope trapped loop asChild>
      <div
        className="sc-ovl"
        data-fb="shot-overlay"
        data-fb-node={node.id}
        data-fb-variant={imageIndex}
        role="dialog"
        aria-modal="true"
        aria-label={nodeLabel(node)}
        // A trail of one is not a trail. The rail held a full-height column for
        // a single thumbnail of the shot you were already looking at, which is
        // the sort of furniture that makes a screen feel unplanned.
      >
        {/* ONE header owns the top of this screen.

            It used to be two: a `position: fixed` bar carrying close and the
            version arrows, and a separate tools row that was the stage's own
            first child. Neither knew the other existed, so on a phone they
            landed on the same line and overlapped — measured at 67px on a
            320px screen and 32px on a 390px one, with "Next version" sitting
            entirely underneath the cost chip and the fixed bar painting over
            it. No amount of spacing fixes two layouts competing for one line.
            A single flex row with a left group and a right group cannot
            collide, at any width, by construction. */}
        <header className="sc-ovl-bar">
          <div className="sc-ovl-bar-l">
            <button type="button" className="sc-icon-btn" onClick={onClose} aria-label="Close" title="Close (esc)">
              <X size={13} />
            </button>
            {/* These step siblings, which are whole runs off the same parent,
                so they are versions. Variants are the images inside one run
                and are stepped on the stage with [ and ]. They appear only
                when there is somewhere to step: two permanently dimmed arrows
                are two controls' worth of room spent saying "not available". */}
            {siblings.length > 1 && (
              <>
                <button
                  type="button"
                  className="sc-icon-btn"
                  disabled={sibIndex <= 0}
                  onClick={() => sibIndex > 0 && onSelect(siblings[sibIndex - 1].id)}
                  aria-label="Previous version"
                  title="Previous version"
                >
                  <CaretLeft size={13} />
                </button>
                <button
                  type="button"
                  className="sc-icon-btn"
                  disabled={sibIndex >= siblings.length - 1}
                  onClick={() => sibIndex < siblings.length - 1 && onSelect(siblings[sibIndex + 1].id)}
                  aria-label="Next version"
                  title="Next version"
                >
                  <CaretRight size={13} />
                </button>
              </>
            )}
          </div>

          {actions.length > 0 && (
            <div className="sc-ovl-bar-r">
              {/* One list, two shells: buttons where the row is wide enough to
                  hold them, one overflow where it is not. Written once, so the
                  two can never drift apart or offer different things. */}
              <div className="sc-ovl-acts">
                {actions.map((a) => (
                  <button
                    type="button"
                    key={a.key}
                    className="sc-icon-btn"
                    onClick={a.onClick}
                    aria-label={a.label}
                    title={a.label}
                    style={a.tint ? { color: a.tint } : undefined}
                  >
                    {a.icon}
                  </button>
                ))}
              </div>

              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  <button type="button" className="sc-icon-btn sc-ovl-overflow" aria-label="More actions">
                    <DotsThree size={18} weight="bold" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end" sideOffset={6}>
                  {actions.map((a) => (
                    <DropdownMenu.Item key={a.key} onSelect={a.onClick} color={a.tint ? 'red' : undefined}>
                      {a.icon}
                      {a.label}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </div>
          )}
        </header>

        {/* Delete is confirmed from a dialog this header only opens, so the
            same action can sit in a menu item and in a button without two
            copies of the confirmation. */}
        <AlertDialog.Root open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <AlertDialog.Content maxWidth="420px">
            <AlertDialog.Title>Delete this shot permanently?</AlertDialog.Title>
            <AlertDialog.Description size="2">This cannot be undone.</AlertDialog.Description>
            <Flex gap="3" mt="4" justify="end">
              <AlertDialog.Cancel>
                <Button variant="soft" color="gray">
                  Cancel
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action>
                <Button color="red" onClick={() => onDelete(node)}>
                  Delete permanently
                </Button>
              </AlertDialog.Action>
            </Flex>
          </AlertDialog.Content>
        </AlertDialog.Root>

        <div
          className="sc-ovl-stage"
          // the shot is capped so the row of takes below it always has room;
          // the cap has to know whether that row is there
          data-takes={node.status === 'done' && node.images.length > 1 ? '' : undefined}
        >
          <StageFrame
            node={node}
            imageIndex={imageIndex}
            onRetry={() => onRetry(node)}
            onCancel={() => onCancel(node)}
            engineName={engine?.displayName}
          />
          {node.status === 'done' && node.images.length > 1 && (
            <div className="sc-thumbs">
              {node.images.map((h, i) => (
                <button
                  type="button"
                  key={h}
                  className="sc-thumb-btn"
                  onClick={() => onImageIndex(i)}
                  aria-label={`Image ${i + 1}`}
                  aria-pressed={i === imageIndex}
                >
                  {/* the attributes stay as the pre-load intrinsic hint; the box
                      and the crop are the stylesheet's job, and were nobody's
                      until this rail stretched every portrait take it held */}
                  <img
                    src={imgUrl(h)}
                    alt=""
                    className="sc-thumb"
                    data-active={i === imageIndex}
                    width={52}
                    height={52}
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        <aside className="sc-ovl-meta">
          {/* One line for what this shot IS: its kind, what it shows, what made
              it and what it cost. The engine used to have a block of its own,
              which on a phone left the word "demo" sitting alone on a line at
              the same weight as the shot's description. The cost used to live
              on a chip in the bar above, which is a row of actions — and once
              that chip stepped aside on a phone, the price was not stated
              anywhere at all. Both are facts about the shot, so both belong in
              the shot's record, said once, at every width. */}
          <div className="sc-ovl-head">
            <b>{node.kind === 'edit' ? 'Refined shot' : 'Shot'}</b>
            <small>
              {node.images.length > 1 ? `${imageIndex + 1} of ${node.images.length} variants` : nodeLabel(node)}
            </small>
            <span className="sc-ovl-meta-sep" aria-hidden />
            <small className="sc-ovl-eng">{node.engineId}</small>
            {/* Only where something was actually made. A shot that came back
                with nothing was still announcing a gold coin and the word
                "Free", which reads as a feature of the failure. */}
            {hasImage && (
              <small
                className="sc-ovl-spend"
                title={node.costUsd > 0 ? 'Of your API budget' : 'No API cost for this shot'}
              >
                <Coin size={12} />
                {node.costUsd > 0 ? `$${node.costUsd.toFixed(2)}` : 'Free'}
              </small>
            )}
          </div>

          <Ingredients brief={node.brief} brand={brand} />

          {parentShot && (
            <div className="sc-ctx">
              <button
                type="button"
                className="sc-ctx-chip"
                onClick={() => onSelect(parentShot.id)}
                title={`Open ${nodeLabel(parentShot)}, the shot this came from`}
              >
                {sourceHash && <img src={imgUrl(sourceHash)} alt="" />}
                {/* One text item, not two. As a bare text node beside a <b>,
                    the words and the name were separate flex items that shrank
                    and wrapped independently — which is how a pill ended up
                    reading "refined / from" over two lines with the name
                    stacked beside it. One span wraps as one sentence, and
                    truncates as one, with the whole of it on the title. */}
                <span className="sc-ctx-chip-t">
                  refined from <b>{nodeLabel(parentShot)}</b>
                </span>
              </button>
              {/* Which ingredient moved, read from the two stored recipes.
                  Without it, two refinements of one setup are told apart by
                  their pictures alone, which after twenty minutes of work is
                  not enough to remember why they differ. */}
              {changeLine && <p className="sc-ctx-changed">{changeLine}</p>}
            </div>
          )}

          {(ancestors.length > 0 || children.length > 0) && (
            <div className="sc-ovl-trail">
              <span className="sc-eyebrow">Versions</span>
              <div className="sc-ovl-trail-row">
                {ancestors.map((a) => (
                  <span key={a.id} style={{ display: 'contents' }}>
                    {frame(a)}
                    <span className="sc-wire" />
                  </span>
                ))}
                {frame(node, true)}
                {children.length > 0 && (
                  <>
                    <span className="sc-wire" />
                    {children.slice(0, 4).map((c) => frame(c))}
                  </>
                )}
              </div>
            </div>
          )}

          {/* Three verbs, and they are the only three there are.
              Refining is not among them: the composer below IS refining, so a
              button that only scrolls you to it was a fourth way to say the
              same thing. "Add text" moved back to the Text tab, where the rest
              of the text tools live. */}
          {/* Reuse setup is offered on a failure too — changing the setup is
              exactly what a declined brief or an unmakeable shape needs, and it
              was the one route out that a failed shot had no way to reach.
              Try again is not: the stage panel already carries it, and it knows
              which failures re-running cannot fix. */}
          {(hasImage || node.brief) && (
            <div className="sc-sugg">
              {node.brief && (
                <button
                  type="button"
                  className="sc-s"
                  onClick={() => onRemix(node)}
                  title="Put this shot's setup back in the brief, to change and run again"
                >
                  <ArrowsClockwise size={12} /> Reuse setup
                </button>
              )}
              {hasImage && (
                <button
                  type="button"
                  className="sc-s"
                  onClick={() => onRetry(node)}
                  title="Run the same setup again for a different take"
                >
                  <ArrowCounterClockwise size={12} /> Try again
                </button>
              )}
              {/* Export lives once, with the other file actions over the shot.
                  It was offered here too, from the same handler — the same word
                  twice in one dialog. */}
            </div>
          )}

          <div className="sc-ovl-body">
            <Inspector
              node={node.kind !== 'root' ? node : null}
              nodes={nodes}
              imageIndex={imageIndex}
              onChanged={onChanged}
              brand={brand}
              onExport={() => setExportOpen(true)}
              onCompare={sourceHash ? () => setCompareOpen(true) : undefined}
              onArchive={() => onArchive(node)}
              onUnarchive={() => onUnarchive(node)}
              onDelete={() => onDelete(node)}
            />
          </div>

          <div className="sc-ovl-edit">
            {/* In here the target is the whole screen, so it is stated rather
              than chosen: `target` is this shot and there is no chip, because
              there is nothing else this composer could be talking about. The
              root is the fallback for the cases that cannot branch, so a look
              or a non-editing engine still makes a new shot rather than filing
              one under a shot it never used.

              It says so out loud now that the suggestion row no longer carries
              a button pointing down here — the heading is the only thing that
              names what typing in this field will do. */}
            {node.status === 'done' && node.images.length > 0 && (
              <div className="sc-eyebrow sc-ovl-edit-head">Refine this shot</div>
            )}
            <Composer
              projectId={projectId}
              brand={brand}
              engines={engines}
              parent={root}
              target={node}
              // the variant on the stage is the one a refine works from
              sourceImage={hash}
              shots={nodes}
              // The dock's composer is still mounted behind this one and there
              // is one saved draft per brand: without this, merely opening a
              // shot overwrote a half-typed brief with this composer's empty
              // sentence, and left its own target behind to be restored later
              // as a draft the person never wrote.
              persistDraft={false}
              // an edit/regen submitted from inside the overlay used to only
              // reload the tree in place, leaving you looking at the shot you
              // just replaced; wait for the new node to actually exist, then
              // reuse the same in-overlay navigation the lineage filmstrip
              // and Prev/Next already use to land on it
              onQueued={async (id, kind) => {
                await onChanged();
                if (id) onSelect(id);
                // One thread, wherever it was pulled. Refining in here used to
                // leave the workspace behind still pointed at nothing, so
                // stepping back out and carrying on turned the next
                // instruction into a brand new shot.
                if (id) onRefined?.(id, kind);
              }}
            />
          </div>
        </aside>
        <ExportDialog open={exportOpen} onOpenChange={setExportOpen} hash={hash} baseName={baseName} />
        {parentShot && sourceHash && (
          <CompareDialog
            open={compareOpen}
            onOpenChange={setCompareOpen}
            a={parentShot}
            b={node}
            // the frame this refinement actually started from, so the drift
            // figure measures the change it made rather than the distance to
            // some other variant of the same run
            imageA={sourceHash}
            imageB={hash}
          />
        )}
      </div>
    </FocusScope>,
    document.body,
  );
}
