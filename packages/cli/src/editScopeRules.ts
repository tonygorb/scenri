/**
 * What kind of change is this refinement asking for?
 *
 * A refine that says "add one subtle prop" and a refine that says "make it
 * nighttime" are not the same request, but the pipeline treated them
 * identically: both went to the engine as a bare instruction beside a picture,
 * and both came back as a fresh interpretation of the whole frame. The first
 * one should not. Everything the instruction does not name should survive it.
 *
 * This decides which of the two the prompt is written for, and whether the
 * server should later attempt to keep the untouched pixels. It reads the user's
 * own words only, never the compiled prompt, which by then carries directives
 * that would match every cue in here.
 *
 * It is a rule you can read rather than a model call, for the same reason
 * `shotSpecifiesCamera` is: the golden suites assert compiled prompts byte for
 * byte, so a non-deterministic classifier would make the compiler untestable,
 * and on the only configured engine a classification call would spend a real
 * generation on a boolean.
 *
 * The cost of being wrong is asymmetric. Calling a global change local could
 * discard a change the user actually asked for, while calling a local change
 * global merely leaves today's behaviour in place. So every path that is not a
 * confident local returns global, and the server keeps its own evidence gate on
 * top: to actually preserve anything, the returned image has to measure as a
 * small, contained change as well.
 */

export type EditScope = 'local' | 'global';

export interface ScopeVerdict {
  scope: EditScope;
  /** Which cue decided it, so a surprising call can be explained rather than guessed at. */
  matched: string[];
}

/**
 * Whole-frame vocabulary. Any of these means the user is talking about the
 * picture, not about a thing inside it. Checked first, so "brighter" wins even
 * when a sentence also contains "the bottle".
 */
const GLOBAL_CUES: [string, RegExp][] = [
  ['light', /\b(light|lighting|lit|relight|exposure|white ?balance|backlit|shadows everywhere)\b/i],
  [
    'grade',
    /\b(grade|grading|colou?r ?grade|tone|tint|saturation|contrast|filmic|film stock|grain|black and white|monochrome|sepia)\b/i,
  ],
  ['time', /\b(night|nighttime|daytime|dusk|dawn|sunset|sunrise|golden hour|midday|morning|evening)\b/i],
  ['weather', /\b(rain|rainy|snow|snowy|fog|foggy|misty|storm|overcast|sunny)\b/i],
  ['scene', /\b(scene|background|backdrop|environment|location|setting|studio|indoors|outdoors)\b/i],
  [
    'camera',
    /\b(angle|zoom|closer|wider|crop|reframe|recompose|framing|perspective|lens|\d{2,3} ?mm|shot from|low angle|high angle|overhead|top ?down|eye ?level)\b/i,
  ],
  ['mood', /\b(mood|vibe|feel|editorial|cinematic|dramatic|moody|minimal|luxurious|playful|clinical)\b/i],
  [
    'comparative',
    /\b(warmer|cooler|brighter|darker|softer|harder|punchier|richer|flatter|sharper|moodier|more|less)\b/i,
  ],
  [
    'restage',
    /\b(regenerate|redo|re-?do|start over|another take|different (take|composition|version)|try again|new (version|take))\b/i,
  ],
  ['whole', /\b(overall|whole (image|frame|shot|thing)|entire|everything|all of it|throughout)\b/i],
  ['wardrobe', /\b(outfit|wardrobe|clothes|clothing|dress(ed)?|styling)\b/i],
  ['pose', /\b(pose|posture|expression|smile|smiling|looking)\b/i],
];

/**
 * A targeted verb aimed at a definite thing. The determiner matters: "remove
 * the cup" names an object that exists in the frame, while "remove clutter" is
 * a note about the picture as a whole.
 */
const LOCAL_VERB =
  /\b(add|remove|delete|erase|take out|get rid of|replace|swap|clean up|fix|repair|straighten|hide|cover)\b/i;
const DEFINITE_OBJECT = /\b(the|that|this|his|her|their|its|a|an|one)\b/i;

/** Naming where in the frame is a strong local signal on its own. */
const REGION_CUE =
  /\b(in the (top|bottom|upper|lower|left|right)|on the (left|right|label|cap|lid|sleeve|table|floor|wall|shelf)|behind|next to|beside|in front of|to the (left|right)|corner|foreground|background object)\b/i;

/** Two imperatives joined is two requests, and at least one of them is usually broad. */
const COORDINATION = /\b(and|then|also|plus)\b|[;]/i;

/** Past this, a request is a paragraph of art direction rather than one change. */
const MAX_LOCAL_WORDS = 16;

/**
 * Classify a refinement instruction.
 *
 * Pass the user's own sentence. Anything that is not a confident local edit
 * comes back global, including empty input.
 */
export function scopeOfInstruction(text: string): ScopeVerdict {
  const s = String(text ?? '').trim();
  if (!s) return { scope: 'global', matched: ['empty'] };

  const globals = GLOBAL_CUES.filter(([, re]) => re.test(s)).map(([name]) => name);
  if (globals.length) return { scope: 'global', matched: globals };

  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > MAX_LOCAL_WORDS) return { scope: 'global', matched: ['long'] };

  // Two requests in one sentence: even when both look local, the second is
  // unverifiable against a single changed region, so do not promise to keep
  // anything.
  const clauses = s.split(COORDINATION).filter((c) => c.trim().length > 0);
  if (clauses.length > 1 && clauses.filter((c) => LOCAL_VERB.test(c)).length > 1) {
    return { scope: 'global', matched: ['multiple'] };
  }

  const matched: string[] = [];
  if (REGION_CUE.test(s)) matched.push('region');
  if (LOCAL_VERB.test(s) && DEFINITE_OBJECT.test(s)) matched.push('verb+object');
  if (!matched.length) return { scope: 'global', matched: ['no local cue'] };

  return { scope: 'local', matched };
}
