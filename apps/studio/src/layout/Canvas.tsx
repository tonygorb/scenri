import { useState, type CSSProperties, type ReactNode } from 'react';
import { AlertDialog, Button, ContextMenu, Flex } from '@radix-ui/themes';
import {
  Archive,
  ArrowCounterClockwise,
  Check,
  ClockCounterClockwise,
  FolderSimple,
  PencilLine,
  Stack,
  Star,
} from '@phosphor-icons/react';
import { hasNoShots, imgUrl, nodeLabel, type ShotSet, type TreeNode } from '../api.js';
import { sourceImageOf } from '../briefDiff.js';
import { describeCancelled, describeFailure } from '../failure.js';
import { FailureNote } from './Failure.js';
import { elapsedSec } from '../tasks.js';
import { masonryLayout, PHONE, useElementWidth, useViewportWidth } from './masonry.js';
import { RunningTag } from './canvas/RunningTag.js';
import { FeedImage } from './canvas/FeedImage.js';
import { aspectOfFormat } from '../composer/formats.js';

/**
 * The feed: every shot the current lens admits, as a masonry tile.
 * Running tiles shimmer with elapsed seconds (status, never a fake percent),
 * failed tiles stay quiet and dashed, edits carry a provenance badge.
 */
export function Canvas({
  nodes,
  selectedId,
  onOpen,
  onRetry,
  onCancel,
  onToggleKeep,
  onArchive,
  onDeletePermanently,
  setsFor,
  picked,
  onPick,
  empty,
  sending,
  onBranch,
  branchingFrom,
  branchingFromImage,
  expanded,
  onToggleExpand,
  versionsOf,
  onVersions,
  engineName,
  tile,
}: {
  nodes: TreeNode[];
  selectedId: string | null;
  /** The variant index is how a stacked run opens on the one you clicked. */
  onOpen: (id: string, imageIndex?: number) => void;
  onRetry: (node: TreeNode) => void;
  onCancel?: (node: TreeNode) => void;
  /** The star badge looked like a toggle and wasn't one — `k` and the overlay
   * were the only real controls. This is the tile-level path to match. */
  onToggleKeep?: (node: TreeNode) => void;
  /** Put a shot away — or, on an already-archived one, bring it back. Absent
   * where a tile can't be put away at all (there is none today, but the
   * fallback in the running/cancelled tiles keeps this optional rather than
   * a silent crash if that ever changes). */
  onArchive?: (node: TreeNode) => void;
  /** Permanent. Only ever offered (in the context menu) on an already-archived tile. */
  onDeletePermanently?: (node: TreeNode) => void;
  /** The sets a shot is in, for the tile's own label. */
  setsFor?: (id: string) => ShotSet[];
  picked?: Set<string>;
  onPick?: (id: string) => void;
  /**
   * What stands in for the feed when nothing is admitted. The caller owns this
   * because only it knows whether the brand is empty or a lens is hiding the
   * work, and those two say very different things.
   */
  empty?: ReactNode;
  /**
   * A brief that has been sent and has not come back as a shot yet. It leads
   * the feed so the press of the button is answered immediately, rather than
   * after a round trip that can take a second on a cold engine.
   */
  sending?: string | null;
  /** Point the brief at this shot. Absent where branching makes no sense. */
  onBranch?: (id: string, imageIndex?: number) => void;
  /** The shot the brief is currently pointed at, so its tile can say so. */
  branchingFrom?: string | null;
  /** Which image of it, so an opened-out take can say it is the armed one. */
  branchingFromImage?: string | null;
  /** Runs opened out into their variants. */
  expanded?: Set<string>;
  onToggleExpand?: (id: string) => void;
  /** How many shots came from this one, for the versions pip. */
  versionsOf?: (id: string) => number;
  /** Look at just this shot and what came from it. */
  onVersions?: (id: string) => void;
  /**
   * An engine id to the name it is called by. Only a failed tile reads it, to
   * say "OpenRouter did not accept your API key" rather than the same sentence
   * about "the engine" — but the feed is the one place that knows the ids and
   * not the names, so it is passed rather than looked up here.
   */
  engineName?: (id: string) => string | undefined;
  /** Target column width in px, from Create’s grid-size slider. */
  tile: number;
}) {
  const shots = nodes.filter((n) => n.kind !== 'root');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const picking = !!onPick;
  // one confirm dialog for the whole grid, not one per tile — the context
  // menu item just says which node it's for
  const [deleteTarget, setDeleteTarget] = useState<TreeNode | null>(null);
  // a callback ref rather than useRef: the feed is not in the tree at all while
  // the brand is empty, so an effect keyed on a ref object would never see it
  // arrive and would measure nothing for the rest of the session
  const [feedEl, setFeedEl] = useState<HTMLDivElement | null>(null);
  const { tile: colWidth, cols: fitting } = masonryLayout(useElementWidth(feedEl), tile, useViewportWidth() < PHONE);

  const tiles: ReactNode[] = [
    ...(sending
      ? [
          <div key="sending" className="sc-cell" data-running="true" data-sending="true">
            <span className="sc-shimmer" />
            <span className="sc-cell-tag">sending</span>
            <span className="sc-cell-said" dir="auto">
              {sending}
            </span>
          </div>,
        ]
      : []),
    ...shots.flatMap((n) => {
      const parent = n.parentId ? byId.get(n.parentId) : null;
      const parentShot = parent && parent.kind !== 'root' ? parent : null;
      if (n.status === 'running') {
        return [
          // Cancel used to be a <button> inside .sc-cell-open — invalid HTML
          // (React warned on it), and the same nested-interactive mistake this
          // pass already fixed for SceneCard and the kept-star badge. A sibling
          // now, matching that pattern.
          <div
            key={n.id}
            className="sc-cell"
            data-running="true"
            data-fb-node={n.id}
            // the shape the brief asked for, so the picture lands in the space
            // already held for it instead of resizing its column
            style={{ '--sc-cell-ar': aspectOfFormat(n.brief?.format) } as CSSProperties}
          >
            <button
              type="button"
              className="sc-cell-open"
              aria-label={`Open ${nodeLabel(n)}, still rendering`}
              onClick={() => onOpen(n.id)}
            >
              <span className="sc-shimmer" />
              <RunningTag since={n.createdAt} />
            </button>
            {onCancel && (
              <button
                type="button"
                className="sc-cell-retry"
                data-urgent={elapsedSec(n.createdAt) >= 60 || undefined}
                onClick={() => onCancel(n)}
              >
                Cancel
              </button>
            )}
          </div>,
        ];
      }
      /*
       * Cancelled and failed are one tile with two readings. They used to be
       * two near-identical blocks that had already drifted — the failed one
       * clipped its message at 200px with `nowrap`, so the reason a shot failed
       * was unreadable on the very tile reporting it, and both offered two grey
       * pills of identical weight where one is a rescue and the other a
       * dismissal.
       */
      if (n.status === 'cancelled' || n.status === 'error' || n.images.length === 0) {
        const cancelled = n.status === 'cancelled';
        const failure = cancelled ? describeCancelled() : describeFailure(n.error, engineName?.(n.engineId));
        return [
          <div
            key={n.id}
            className="sc-cell"
            data-fb-node={n.id}
            data-cancelled={cancelled || undefined}
            data-failed={!cancelled || undefined}
            data-selected={n.id === selectedId}
          >
            <button
              type="button"
              className="sc-cell-open"
              onClick={() => onOpen(n.id)}
              aria-label={`Open ${nodeLabel(n)}`}
            />
            <span className="sc-cell-failed">
              <FailureNote
                failure={failure}
                density="tile"
                onRetry={() => onRetry(n)}
                dismiss={
                  onArchive
                    ? {
                        // Says what it will do. Both of these called the same
                        // handler under the same word, and that handler
                        // restores an already-archived shot — so on an archived
                        // failure the button labelled Dismiss put it back,
                        // which is the opposite of dismissing it.
                        label: n.archived ? 'Restore' : 'Dismiss',
                        onClick: () => onArchive(n),
                      }
                    : undefined
                }
              />
            </span>
          </div>,
        ];
      }
      const inSets = setsFor?.(n.id) ?? [];
      const chosen = picked?.has(n.id) ?? false;
      const versions = versionsOf?.(n.id) ?? 0;

      /**
       * Refine, select and the versions pip all act on the run rather than on
       * an image, so they are rendered once per run and stay reachable whether
       * it is stacked or opened out. Four copies of one checkbox would not be
       * four choices, and hiding them while a run is open made expanding it a
       * dead end you had to undo before you could do anything.
       */
      const refineRun = onBranch && (
        <button
          type="button"
          className="sc-cell-branch"
          data-on={n.id === branchingFrom || undefined}
          onClick={() => onBranch(n.id)}
          aria-label={`Refine ${nodeLabel(n)}`}
          title="Continue from this shot"
        >
          <PencilLine size={12} />
          <span className="sc-cell-branch-lb">Refine</span>
        </button>
      );
      /**
       * What this shot IS, in one row in one corner.
       *
       * These three used to be three grammars in two corners: provenance was a
       * full-radius sans pill at the top left, the variant count a small-radius
       * mono chip at the bottom left, and the version count the same chip
       * stacked 26px above it. Provenance also carried a rule nudging it right
       * to dodge the selection box — which on a touch device is always on, so
       * it permanently floated off its corner rather than sitting in it. They
       * are facts about the same picture, so they read as one row: bottom left,
       * one chip, wrapping when a tile is narrow.
       */
      const facts = (
        // keyed only to settle the iterable check: this is built inside the
        // callback that returns the tile array, but it is not a member of it
        <div className="sc-cell-facts" key={`${n.id}-facts`}>
          {parentShot?.images[0] && (
            <span className="sc-fact sc-prov">
              {/* the frame it was actually made from: a run holds several, and
                  this used to show the first one on every tile */}
              <img src={imgUrl(sourceImageOf(n, parentShot) ?? parentShot.images[0])} alt="" />
              refined from
            </span>
          )}
          {n.images.length > 1 && (
            <button
              type="button"
              className="sc-fact sc-cell-stack"
              onClick={() => onToggleExpand?.(n.id)}
              aria-expanded="false"
              aria-label={`Show all ${n.images.length} variants`}
            >
              <Stack size={12} />
              {n.images.length} variants
            </button>
          )}
          {versions > 0 && onVersions && (
            <button
              type="button"
              className="sc-fact sc-cell-versions"
              onClick={() => onVersions(n.id)}
              aria-label={`Show the ${versions} version${versions === 1 ? '' : 's'} of this shot`}
            >
              <ClockCounterClockwise size={11} />
              {versions} version{versions === 1 ? '' : 's'}
            </button>
          )}
          {/* Where this shot is filed. It used to be a second absolutely
              positioned band across the whole bottom edge, painted after this
              row and therefore on top of it, which is why the set names ran
              through the version count and under the Refine button. It is a
              fact about the picture, so it belongs with the other facts.

              A count rather than the names: set names are arbitrarily long, and
              on a phone tile one of them pushed the variant count into an
              ellipsis, which is the row cutting off a fact to make room for
              another. The names are on the title. A tile is not a place to read
              a list. */}
          {inSets.length > 0 && (
            <span className="sc-fact" title={inSets.map((s) => s.name).join(', ')}>
              <FolderSimple size={11} />
              {inSets.length} set{inSets.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      );

      /**
       * One brief that returned four images used to look like one image with
       * a caption, and the other three were reachable only by opening the
       * shot and stepping with [ and ]. Opened out, each is a tile of its
       * own; the run's own actions stay on the first, because they act on
       * the run and four copies of one checkbox is not four choices.
       */
      const runControlsWithoutRefine = picking && (
        <button
          type="button"
          className="sc-cell-pick"
          data-on={chosen || undefined}
          aria-pressed={chosen}
          aria-label={chosen ? 'Deselect shot' : 'Select shot'}
          onClick={() => onPick?.(n.id)}
        >
          {chosen && <Check size={12} weight="bold" />}
        </button>
      );

      /**
       * What to do with this picture, as one group in one corner.
       *
       * Archive used to sit in the top right and step aside to 34px whenever the
       * keeper star was there too, which only worked because of the order the
       * two happened to be written in. They are different kinds of thing: the
       * star is a judgement about the work and stays visible, archive is
       * management and belongs with the other management action.
       */
      const cellActions = (
        // keyed only to settle the iterable check, exactly as `facts` is: this
        // is built inside the callback that returns the tile array, but it is
        // not a member of it
        <div className="sc-cell-acts" key={`${n.id}-acts`}>
          {onArchive && (
            <button
              type="button"
              className="sc-cell-archive"
              onClick={() => onArchive(n)}
              aria-label={n.archived ? 'Restore' : 'Archive'}
              title={n.archived ? 'Restore' : 'Archive'}
            >
              {n.archived ? <ArrowCounterClockwise size={12} /> : <Archive size={12} />}
            </button>
          )}
          {refineRun}
        </div>
      );

      /**
       * The keeper mark, which is now a mark you can make.
       *
       * It rendered only when the shot was already kept, with aria-pressed
       * hardcoded true, so from the tile face a keeper could only ever be
       * removed. Meanwhile the empty state told people to star a shot, which was
       * the one thing this control could not do.
       */
      const keepStar = onToggleKeep && (
        <button
          type="button"
          className="sc-cell-star"
          data-on={n.kept || undefined}
          onClick={() => onToggleKeep(n)}
          aria-pressed={n.kept}
          aria-label={n.kept ? 'Remove from keepers' : 'Keep'}
          title={n.kept ? 'Remove from keepers' : 'Keep'}
        >
          <Star size={14} weight={n.kept ? 'fill' : 'regular'} />
        </button>
      );

      if (expanded?.has(n.id) && n.images.length > 1) {
        return n.images.map((hash, i) => (
          <div
            // the hash, not the index: images are content addressed, so this
            // is both stable and meaningful. The run is append-only and never
            // reordered, so the index would have worked too; this simply does
            // not rely on that staying true.
            key={`${n.id}:${hash}`}
            className="sc-cell"
            data-fb-node={n.id}
            data-fb-variant={i}
            data-variant=""
            data-first={i === 0 || undefined}
            data-selected={i === 0 && n.id === selectedId}
          >
            <button
              type="button"
              className="sc-cell-open"
              aria-label={`Open ${nodeLabel(n)}, take ${i + 1} of ${n.images.length}`}
              onClick={() => onOpen(n.id, i)}
            >
              <FeedImage src={imgUrl(hash)} aspect={aspectOfFormat(n.brief?.format)} />
            </button>
            {/* An opened-out take gets the same bottom line as any other tile:
                what it is on the left, what to do with it on the right. It used
                to place these itself, and once the counts moved into that row
                the Collapse button kept its old class without the positioning
                that came with it — and landed on top of Refine. */}
            <div className="sc-cell-bar">
              <div className="sc-cell-facts">
                <span className="sc-fact">
                  {i + 1} of {n.images.length}
                </span>
                {i === 0 && (
                  <button
                    type="button"
                    className="sc-fact sc-cell-stack"
                    onClick={() => onToggleExpand?.(n.id)}
                    aria-expanded="true"
                    aria-label={`Collapse ${n.images.length} variants`}
                  >
                    <Stack size={12} />
                    Collapse
                  </button>
                )}
              </div>
              {/* Refining is the one action that is about THIS picture rather
                  than the run — keeping, picking and archiving all act on the
                  whole shot, so they stay on the first tile with the run's own
                  controls. Without this the takes you opened out to compare
                  were inert: you could look at variant three and then only ever
                  refine variant one. */}
              <div className="sc-cell-acts">
                {i === 0 && onArchive && (
                  <button
                    type="button"
                    className="sc-cell-archive"
                    onClick={() => onArchive(n)}
                    aria-label={n.archived ? 'Restore' : 'Archive'}
                    title={n.archived ? 'Restore' : 'Archive'}
                  >
                    {n.archived ? <ArrowCounterClockwise size={12} /> : <Archive size={12} />}
                  </button>
                )}
                {onBranch && (
                  <button
                    type="button"
                    className="sc-cell-branch"
                    data-on={branchingFrom === n.id && branchingFromImage === hash ? '' : undefined}
                    onClick={() => onBranch(n.id, i)}
                    aria-label={`Refine ${i + 1} of ${n.images.length}`}
                    title="Continue from this take"
                  >
                    <PencilLine size={12} />
                    <span className="sc-cell-branch-lb">Refine</span>
                  </button>
                )}
              </div>
            </div>
            {i === 0 && (
              <>
                {/* the run's own controls, without its Refine: every take now
                    carries one that names the picture it is about. The keeper
                    mark comes too, because opening a run out used to lose it. */}
                {runControlsWithoutRefine}
                {keepStar}
              </>
            )}
          </div>
        ));
      }

      return [
        <ContextMenu.Root key={n.id}>
          <ContextMenu.Trigger>
            <div
              className="sc-cell"
              data-fb-node={n.id}
              data-selected={n.id === selectedId}
              data-picked={chosen || undefined}
            >
              <button
                type="button"
                className="sc-cell-open"
                aria-label={`Open ${nodeLabel(n)}`}
                onClick={() => onOpen(n.id)}
              >
                <FeedImage src={imgUrl(n.images[0])} aspect={aspectOfFormat(n.brief?.format)} />
              </button>
              <div className="sc-cell-bar">
                {facts}
                {cellActions}
              </div>
              {runControlsWithoutRefine}
              {keepStar}
            </div>
          </ContextMenu.Trigger>
          <ContextMenu.Content>
            <ContextMenu.Item onSelect={() => onOpen(n.id)}>Open</ContextMenu.Item>
            {onBranch && <ContextMenu.Item onSelect={() => onBranch(n.id)}>Refine from this</ContextMenu.Item>}
            {onPick && (
              <ContextMenu.Item onSelect={() => onPick(n.id)}>
                {chosen ? 'Deselect' : 'Select for set'}
              </ContextMenu.Item>
            )}
            {versions > 0 && onVersions && (
              <ContextMenu.Item onSelect={() => onVersions(n.id)}>
                {versions} version{versions === 1 ? '' : 's'}
              </ContextMenu.Item>
            )}
            {n.images.length > 1 && onToggleExpand && (
              <ContextMenu.Item onSelect={() => onToggleExpand(n.id)}>Show all variants</ContextMenu.Item>
            )}
            {onToggleKeep && (
              <ContextMenu.Item onSelect={() => onToggleKeep(n)}>
                {n.kept ? 'Remove from keepers' : 'Keep'}
              </ContextMenu.Item>
            )}
            {onArchive && (
              <>
                <ContextMenu.Separator />
                <ContextMenu.Item onSelect={() => onArchive(n)}>{n.archived ? 'Restore' : 'Archive'}</ContextMenu.Item>
              </>
            )}
            {onDeletePermanently && n.archived && (
              <>
                <ContextMenu.Separator />
                <ContextMenu.Item color="red" onSelect={() => setDeleteTarget(n)}>
                  Delete permanently
                </ContextMenu.Item>
              </>
            )}
          </ContextMenu.Content>
        </ContextMenu.Root>,
      ];
    }),
  ];

  // a first shot on a brand new brand has to have somewhere to appear, so the
  // stand-in outranks the empty state rather than waiting behind it. `shots`
  // rather than `nodes`: dismissing every visible failed/cancelled shot must
  // still land on the empty state, not a blank column with nothing in it.
  if (hasNoShots(shots) && !sending) return <>{empty ?? <p className="sc-feed-empty">Nothing here yet.</p>}</>;

  /**
   * Never more columns than there are tiles to put in them, or the row ends in
   * empty columns — the same dead space multicol left, reached the other way.
   */
  const cols = Math.max(1, Math.min(fitting, tiles.length));

  return (
    <>
      <div
        className="sc-feed"
        ref={setFeedEl}
        data-picking={picking && (picked?.size ?? 0) > 0 ? '' : undefined}
        style={{ '--sc-tile': `${colWidth}px` } as CSSProperties}
      >
        {Array.from({ length: cols }, (_, c) => (
          /*
           * Dealt round-robin, but counted from the OLDEST tile rather than the
           * newest.
           *
           * The feed is sorted newest first, so every generation prepends. Deal
           * on the plain index and that prepend renumbers everything: measured
           * on a 12-shot feed, one new shot moved all 12 of the others, which
           * is the whole page rearranging itself at the exact moment you are
           * looking at what just arrived. Counting from the far end leaves an
           * existing tile's ordinal — and so its column — untouched when
           * something is added at the near end, so only the column the new shot
           * joins shifts down.
           *
           * The cost is that the top row no longer reads strictly left to
           * right; the newest tile lands in whichever column its ordinal picks.
           * A masonry is scanned by column anyway, and a feed that holds still
           * is worth more than a row that reads in order.
           */
          // biome-ignore lint/suspicious/noArrayIndexKey: the index is the identity here. These are positions, not records: column 2 of 4 is column 2 of 4, and the count is in the key so a resize remounts them rather than reshuffling tiles between surviving columns.
          <div className="sc-feed-col" key={`col-${cols}-${c}`}>
            {tiles.filter((_, i) => (tiles.length - 1 - i) % cols === c)}
          </div>
        ))}
      </div>
      <AlertDialog.Root open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
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
              <Button
                color="red"
                onClick={() => {
                  if (deleteTarget) onDeletePermanently?.(deleteTarget);
                  setDeleteTarget(null);
                }}
              >
                Delete permanently
              </Button>
            </AlertDialog.Action>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}
