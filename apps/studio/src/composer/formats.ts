/**
 * Kept as the composer's own list: size renders as nothing in the sentence.
 *
 * Ordered so the shapes progress — square, then narrower, then wide — rather
 * than alternating, because the picker draws each one at its real proportion
 * and a list that jumps tall-wide-tall reads as four unrelated options. Square
 * stays first: it is the fallback when a stored format id no longer resolves.
 *
 * `packages/cli/src/brief.ts` holds the compiler's own copy of these four.
 * Order is meaningless there (it looks them up by id), but the dimensions are
 * not, and `e2e/composer.spec.ts` asserts the two lists still agree.
 */
export const FORMATS = [
  { id: 'square', label: 'Square', hint: '1:1', w: 1024, h: 1024 },
  { id: 'portrait', label: 'Portrait', hint: '4:5', w: 1024, h: 1280 },
  { id: 'story', label: 'Story', hint: '9:16', w: 1080, h: 1920 },
  { id: 'landscape', label: 'Landscape', hint: '16:9', w: 1600, h: 900 },
];

/**
 * The shape a shot is going to be, from the format its brief recorded.
 *
 * A placeholder that guesses cannot hold the space the picture will need, and
 * the feed reflows the moment the image lands. Square is the app's own default
 * and the right guess for a brief written before formats were stored.
 */
export function aspectOfFormat(formatId: string | undefined): number {
  const f = FORMATS.find((x) => x.id === formatId);
  return f ? f.w / f.h : 1;
}
