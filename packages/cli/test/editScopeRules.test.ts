import { describe, it, expect } from 'vitest';
import { scopeOfInstruction } from '../src/editScopeRules.js';

const scope = (s: string) => scopeOfInstruction(s).scope;

describe('edit scope', () => {
  // The refinement that started this: it added the prop it was asked for and
  // also repainted the lighting, the shadows and the surface texture.
  it('reads a single targeted change as local', () => {
    expect(scope('add one subtle prop that suits the product, nothing that hides it')).toBe('local');
    expect(scope('remove the cup on the left')).toBe('local');
    expect(scope('delete that box behind it')).toBe('local');
    expect(scope('take out the sticker on the label')).toBe('local');
    expect(scope('replace the flower with a sprig of rosemary')).toBe('local');
  });

  it('reads a change to the picture itself as global', () => {
    expect(scope('make it nighttime')).toBe('global');
    expect(scope('warmer light')).toBe('global');
    expect(scope('move the camera lower')).toBe('global');
    expect(scope('make it more editorial')).toBe('global');
    expect(scope('change the background to a studio sweep')).toBe('global');
    expect(scope('wider framing')).toBe('global');
    expect(scope('change her outfit')).toBe('global');
  });

  // The asymmetry is the whole design: a wrong local could discard a change the
  // user asked for, a wrong global only leaves the old behaviour in place.
  it('falls back to global whenever it is not sure', () => {
    expect(scope('')).toBe('global');
    expect(scope('   ')).toBe('global');
    expect(scope('nicer')).toBe('global');
    expect(scope('do something interesting with it')).toBe('global');
  });

  it('treats two requests in one sentence as global, because only one region could be kept', () => {
    expect(scope('remove the cup and add a plant')).toBe('global');
    expect(scope('remove the box then clean up the shelf')).toBe('global');
  });

  it('treats a paragraph of art direction as global however it starts', () => {
    const long =
      'add a small ceramic dish to the left of the bottle and let the surface read as honed stone with a ' +
      'quiet fall of light coming from somewhere off to the right of the set';
    expect(scope(long)).toBe('global');
  });

  // A whole-frame word anywhere wins, because the sentence is then at least
  // partly about the picture rather than about a thing inside it.
  it('lets a global cue outrank a local verb in the same sentence', () => {
    expect(scope('add a prop and make it moodier')).toBe('global');
    expect(scope('remove the cup, warmer overall')).toBe('global');
  });

  it('explains which cue decided, so a surprising call can be read back', () => {
    expect(scopeOfInstruction('make it nighttime').matched).toContain('time');
    expect(scopeOfInstruction('remove the cup on the left').matched).toContain('region');
    expect(scopeOfInstruction('add one subtle prop to the shelf').matched).toContain('verb+object');
  });
});
