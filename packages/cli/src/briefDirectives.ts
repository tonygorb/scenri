/**
 * The pure directive helpers of the brief compiler: fixed strings and
 * brand-document readers with no compile state. `compileBrief` itself stays in
 * `brief.ts`, where the order-sensitive assembly lives.
 */
/**
 * What the model is told about the product, keyed on how much of the object it
 * can actually see.
 *
 * The single-reference case is the common one, not the edge case: a merchant
 * importing from Shopify or WooCommerce usually has one clean packshot. Telling
 * that model only to "preserve label, shape and colors" leaves it free to invent
 * the faces it cannot see — a confidently wrong back panel on a bag, hardware on
 * a sole it never saw. So the one-reference tier does two things nothing else
 * does: it forbids invented geometry on unseen faces, and it biases the
 * composition toward the view we actually have.
 *
 * Keyed on `attached` alone — what actually reaches the engine.
 *
 * It used to also read how many images the product record held, and told the
 * model that four or more of them "cover the object from every side, so no
 * face of it has to be guessed at". Nothing checked that. An imported product
 * routinely carries one shot per colourway rather than one per angle, so the
 * products that tripped that branch were often the ones whose images were not
 * angles at all — and the claim got *more* confident the more colours a store
 * sold. A count is not evidence of coverage, so the coverage claim is gone and
 * the conservative line is the only one left.
 */
export function productFidelityDirective(attached: number): string {
  if (attached <= 1) {
    return (
      'The attached product image is the exact product: preserve its label, shape, colors and proportions faithfully, ' +
      'and do not redesign it. It is also the only view of this product that exists. Any face, side or detail not ' +
      'visible in it is unknown — keep those plain and consistent with the visible materials and color, and do not ' +
      'invent hardware, text, seams, closures, ornament or branding on them. Prefer a composition that shows the ' +
      'product from the view the reference gives.'
    );
  }
  return (
    'The attached product images all show the exact same product from different angles: preserve its label, shape ' +
    'and colors faithfully, do not redesign it, and do not treat the extra angles as additional products. ' +
    'Any face not visible in them is unknown — keep it plain and consistent with the visible materials, and do not ' +
    'invent detail on it.'
  );
}

/**
 * What a refinement is allowed to change.
 *
 * A refine used to reach the engine as a bare instruction beside a picture,
 * with nothing anywhere saying that the picture was the point. "Add one subtle
 * prop" is a complete scene brief to an image model, so it wrote a new scene:
 * the prop arrived, and so did new lighting, new shadows and a new surface.
 *
 * Both variants name the dimensions that go wrong in practice rather than
 * saying "keep everything", which a model reads as a mood. The local one also
 * releases the shadows and reflections belonging to the change, because a new
 * object that casts nothing is its own kind of wrong.
 */
export function editPreservationDirective(scope: 'local' | 'global'): string {
  if (scope === 'local') {
    return (
      'This is a change to a photograph that already exists, not a new photograph. Return the same image with ' +
      'one change made. Everything the instruction does not name comes back exactly as it is now: the same framing, ' +
      'the same crop, the same camera position, the same subject placement and pose, the same lighting, the same ' +
      'colours, the same background and the same dimensions. Do not re-render, re-stage, re-light or re-compose the ' +
      'picture. Change only what was asked for, together with the shadows, reflections and contact points that move ' +
      'with it.'
    );
  }
  return (
    'This is a change to a photograph that already exists, not a new photograph. Apply the instruction to the image ' +
    'you were given and keep what it does not name: the same subject and the same face, the same product with the ' +
    'same label, geometry and colour, and the same dimensions. Do not replace the subject and do not redesign the ' +
    'product.'
  );
}

/**
 * Why the extra references are attached to a refinement.
 *
 * Without this the model has been handed the picture plus two more photographs
 * of things already in it, which reads as an invitation to build a new
 * composition out of all three.
 */
export function inheritedIdentityDirective(): string {
  return (
    'The extra attached references are the same product and the same person that are already in this picture. Use ' +
    'them to hold that identity exact while you make the change, not as a reason to re-stage the shot.'
  );
}

/**
 * Does the shot direction already decide the camera?
 *
 * Camera belongs to the shot; a Scene may only express a tendency. Rather than
 * emit both and let them argue in prose — which is how a scene that mentions
 * 50mm ends up beating a recipe asking for an 85mm macro — the compiler emits
 * exactly one. If the direction speaks about lens, distance, height, framing or
 * depth, the scene's tendency is dropped entirely and there is no conflict to
 * resolve.
 *
 * Deliberately generous: a false positive costs only the scene's default, while
 * a false negative would put two cameras in one prompt.
 */
export function shotSpecifiesCamera(text: string): boolean {
  return /\b\d{2,3}\s?mm\b|\bf\/\d|\blens\b|\bcamera\b|\bshot from\b|\beye[- ]level\b|\blow angle\b|\bhigh angle\b|\boverhead\b|\btop[- ]down\b|\bbird'?s[- ]eye\b|\bclose[- ]up\b|\bmacro\b|\bwide shot\b|\bcrop(?:ped)?\b|\bframing\b|\bdepth of field\b|\bbokeh\b|\bshallow (?:focus|depth)\b|\bdeep focus\b/i.test(
    text,
  );
}

/**
 * A scene only ever contributes text, never an image, but its prose can
 * still name a product or wardrobe brand of its own (for demo purposes). When
 * a real product or presenter is attached alongside it, these directives are
 * appended last so they outrank whatever the scene's own text described.
 */
export function sceneGuardDirectives(opts: { hasProduct: boolean; hasPerson: boolean }): string[] {
  const out: string[] = [];
  if (opts.hasProduct) {
    out.push(
      'Disregard any product, bottle, package, or brand name described in the scene direction above — the only product in this image is the one shown in the attached product photo; do not substitute, redesign, invent, or merge it with anything named in the scene text.',
    );
  }
  if (opts.hasPerson) {
    out.push(
      'Disregard any wardrobe, accessory, or garment brand named in the scene direction above — dress the attached person reference only in the generic material and color terms described; do not print, stitch, or render any brand name or wordmark from the scene text onto them.',
    );
  }
  return out;
}

/**
 * The brand's standing rules, as directives.
 *
 * Unconditional, and the only thing about a brand that is. A rule the user
 * wrote is a boundary, not taste: it cannot override a creative request, it
 * only stops the model doing something they already said they never want. That
 * is why it needs no token, while everything else about a brand does.
 *
 * What a brand contributes to a picture — its colours, its mark — arrives the
 * same way a product or a scene does: as a chip the user placed. This used to
 * also emit the palette, mood, keywords and things-to-avoid behind a `brand`
 * token, which put a second, vaguer statement of the palette beside the colour
 * chip that already said it better, and asked users for art direction nobody
 * could write. Both are gone; `imagery.*` and `palette.usage` stay in the
 * format and in the export, they simply no longer reach a prompt.
 *
 * The lines are prefixed "Brand ..." on purpose: `dedupe` is exact-string and
 * first-occurrence-wins, so an unprefixed prohibition could silently collapse
 * into a product's own "Avoid:" line and be read as being about the product.
 */
export function brandRuleDirectives(brand: any): string[] {
  const out: string[] = [];
  const rules = brand?.rules ?? {};
  const never = (Array.isArray(rules.never) ? rules.never : [])
    .map((x: unknown) => String(x ?? '').trim())
    .filter(Boolean)
    .slice(0, 24);
  if (never.length) out.push(`Brand rules — never: ${never.join(', ')}.`);
  // Prose is written by hand and rarely ends in punctuation; directives are
  // space-joined, so without this it fuses into whatever follows.
  const notes = String(rules.notes ?? '')
    .trim()
    .slice(0, 600);
  if (notes) out.push(`Brand rules: ${/[.!?]$/.test(notes) ? notes : `${notes}.`}`);
  return out;
}

const MARK_ROLE_LABEL: Record<string, string> = {
  primary: 'logo',
  mark: 'mark',
  wordmark: 'wordmark',
  monochrome: 'monochrome logo',
  alternate: 'alternate logo',
};

/** Display name for an attached brand mark, e.g. "Acme Coffee wordmark". */
export function markLabel(brand: any, logo: any): string {
  const kind = MARK_ROLE_LABEL[String(logo?.role ?? '')] ?? 'logo';
  const name = String(brand?.meta?.name ?? '').trim();
  return name ? `${name} ${kind}` : `Brand ${kind}`;
}
