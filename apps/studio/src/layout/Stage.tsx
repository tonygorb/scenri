import { useEffect, useState, type CSSProperties } from 'react';
import { Box, Flex, Text } from '@radix-ui/themes';
import { imgUrl, type TreeNode } from '../api.js';
import { describeCancelled, describeFailure } from '../failure.js';
import { FailureNote } from './Failure.js';
// one clock for the whole app: the canvas and the bell must not disagree
import { elapsedSec, runningPhrase } from '../tasks.js';
// the feed's running tiles hold the same shape, from the same source
import { aspectOfFormat } from '../composer/formats.js';

function aspectOf(node: TreeNode): number {
  return aspectOfFormat(node.brief?.format);
}

export function StageFrame({
  node,
  imageIndex,
  onRetry,
  onCancel,
  engineName,
}: {
  node: TreeNode;
  imageIndex: number;
  onRetry?: () => void;
  onCancel?: () => void;
  /** What the engine that ran this is called, so a failure can name it. */
  engineName?: string;
}) {
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [contentRect, setContentRect] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null,
  );
  const [, force] = useState(0);

  useEffect(() => {
    if (node.status !== 'running') return;
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [node.status]);

  // object-fit: contain letterboxes inside the element; the editor must sit on
  // the actual image content box or DOM position and flatten output disagree.
  useEffect(() => {
    if (!imgEl) return;
    const compute = () => {
      const { naturalWidth: nw, naturalHeight: nh, clientWidth: cw, clientHeight: ch } = imgEl;
      if (!nw || !nh || !cw || !ch) return;
      const k = Math.min(cw / nw, ch / nh);
      const w = nw * k,
        h = nh * k;
      setContentRect({ left: (cw - w) / 2, top: (ch - h) / 2, width: w, height: h });
    };
    compute();
    imgEl.addEventListener('load', compute);
    const ro = new ResizeObserver(compute);
    ro.observe(imgEl);
    return () => {
      imgEl.removeEventListener('load', compute);
      ro.disconnect();
    };
  }, [imgEl]);

  if (node.kind === 'root') {
    return (
      <Box className="sc-frame" p="8">
        <Flex direction="column" align="center" gap="2" py="6">
          <Text className="sc-display" size="7" align="center">
            Blank canvas, full brand.
          </Text>
          <Text color="gray" size="2" align="center">
            Pick a Template below (engineered briefs, your product attached) or describe a visual.
          </Text>
        </Flex>
      </Box>
    );
  }
  /*
   * The waiting state stands on its own, outside the frame that centres a
   * finished picture. That frame is an inline-block: it shrink-wraps whatever
   * is inside it, so a placeholder sized from the stage's cap had no definite
   * parent width to clamp itself against and overflowed the stage by a
   * quarter on a desktop and double on a phone.
   */
  if (node.status === 'running') {
    return (
      /*
       * The picture's own place, held.
       *
       * This was a bordered 4:3 box at a fixed 640px, whatever shape the
       * shot was actually going to be and however much room the stage had:
       * a small empty rectangle adrift in a large dark one, which then
       * jumped to a different size and shape the moment the picture landed.
       * It now takes the box the picture will take — the stage's own cap
       * for height, the shot's recorded shape for aspect — and fills it
       * with the same shimmer the feed uses while a tile is rendering, so
       * there is one language for "this is coming" in both places and
       * nothing moves when it arrives.
       *
       * The prompt is not repeated here. It is already the BRIEF beside
       * this, in full, and it was truncated to a single line here anyway.
       */
      <div className="sc-stage-wait" style={{ '--sc-wait-ar': aspectOf(node) } as CSSProperties}>
        <span className="sc-shimmer" />
        <div className="sc-stage-wait-say">
          <span className="sc-stage-wait-t">
            {runningPhrase(node.createdAt)}, {elapsedSec(node.createdAt)}s
          </span>
          {onCancel && (
            <button
              type="button"
              className="sc-btn sc-btn-ghost"
              data-urgent={elapsedSec(node.createdAt) >= 60 || undefined}
              onClick={onCancel}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  }

  /*
   * Nothing landed, so nothing is framed.
   *
   * This was a 420px card of Radix `Flex` adrift in a full-screen dark
   * rectangle, printing the engine's raw JSON as its body text and repeating
   * the brief — already stated in full in the rail beside it — clipped at 160
   * characters. The pass after that gave it the footprint the picture would
   * have had, which drew an 800px dashed box around the same emptiness.
   *
   * A failure is an empty state with a reason. The stage already centres what
   * it is given, so the note is simply given to it: no frame, no placeholder
   * shape, no chrome standing in for a photograph that does not exist.
   */
  if (node.status === 'cancelled' || node.status === 'error') {
    const cancelled = node.status === 'cancelled';
    const failure = cancelled ? describeCancelled() : describeFailure(node.error, engineName);
    return <FailureNote failure={failure} density="stage" onRetry={onRetry} />;
  }

  return (
    <Flex justify="center">
      <Box className="sc-frame" style={{ display: 'inline-block', maxWidth: '100%' }}>
        {node.status === 'done' && node.images[imageIndex] && (
          <Box position="relative" style={{ lineHeight: 0 }}>
            <img
              ref={setImgEl}
              src={imgUrl(node.images[imageIndex])}
              alt={node.prompt}
              // the cap itself lives in CSS, where it can know whether a row of
              // takes sits under the shot: a percentage cannot, because nothing
              // between here and the stage has a definite height to measure
              style={{ display: 'block', maxWidth: '100%' }}
            />
            {contentRect && (
              <div
                style={{
                  position: 'absolute',
                  left: contentRect.left,
                  top: contentRect.top,
                  width: contentRect.width,
                  height: contentRect.height,
                  lineHeight: 'normal',
                }}
              ></div>
            )}
          </Box>
        )}
      </Box>
    </Flex>
  );
}
