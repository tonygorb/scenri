/**
 * What a refinement should still know about the shot it is refining.
 *
 * The composer clears the sentence after every send, so a refine brief is a
 * format token and a line of text. The compiler builds attachments out of
 * product, character, ref and mark tokens, so a refine compiled to nothing:
 * no product reference, no presenter reference, and therefore none of the
 * fidelity language that is keyed on them. The product in the picture had
 * nothing to anchor to except pixels the model was free to redraw, which is
 * why measured product fidelity fell from 7.5 on a first generation to 4.7
 * after a single refine.
 *
 * The fix is to look up the shot being refined and borrow its identity. A
 * refine of a refine has a token-less parent, so the walk continues up the
 * chain until it finds the generation the thread started from.
 */
import type { BriefToken } from './brief.js';

/** How far up a thread of refinements to look before giving up. */
const MAX_HOPS = 8;

export interface NodeLike {
  id: string;
  parentId: string | null;
  kind: string;
  brief: unknown | null;
}

const tokensOf = (node: NodeLike | null | undefined): BriefToken[] => {
  const t = (node?.brief as { tokens?: unknown } | null)?.tokens;
  return Array.isArray(t) ? (t as BriefToken[]) : [];
};

/**
 * The product, presenter and brand mark tokens of the nearest ancestor that
 * has any.
 *
 * Returns an empty list rather than throwing when the thread has none, which
 * is the ordinary case for a shot made from a bare sentence.
 */
export function inheritedIdentityTokens(
  parentId: string | null,
  getNode: (id: string) => NodeLike | null | undefined,
): BriefToken[] {
  let id = parentId;
  for (let hop = 0; hop < MAX_HOPS && id; hop++) {
    const node = getNode(id);
    if (!node || node.kind === 'root') return [];
    const identity = tokensOf(node).filter((t) => t.t === 'product' || t.t === 'character' || t.t === 'mark');
    if (identity.length) return identity;
    id = node.parentId;
  }
  return [];
}
