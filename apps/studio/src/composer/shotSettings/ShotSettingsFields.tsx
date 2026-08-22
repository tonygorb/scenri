import type { ReactNode } from 'react';
import { FORMATS } from '../formats.js';
import { sizingOf } from '../../engines/capabilities.js';
import { Choice, Choices, RatioGlyph } from './Choices.js';
import {
  RESOLUTIONS,
  VARIANTS,
  blockedFormats,
  shapeNote,
  type QualityId,
  type ShotSettingsProps,
} from './settings.js';

/**
 * The settings themselves, without a container.
 *
 * Aspect, variants and resolution are configuration: they matter when you reach
 * for them and cost attention every second they sit in the row. They are the
 * same three controls wherever they appear — behind their own controls where
 * the row is wide, behind More where it is not, in a sheet under the thumb on a
 * phone — so they are written once and the shells only decide where they open.
 */
export function ShotSettingsFields({
  mode,
  engineId,
  engineName,
  formatId,
  onFormat,
  count,
  onCount,
  quality,
  onQuality,
}: ShotSettingsProps) {
  const blocked = blockedFormats(engineId);
  const sizing = sizingOf(engineId);

  return (
    <>
      {/* The shape is always a choice, in both modes, because it is the one of
          the three a refinement can still honour — not by editing the picture,
          which cannot change shape, but by running the same setup again at the
          new one. The composer says so before you send.

          It is also the one that is spatial rather than verbal, so it gets the
          full width of the surface and its answers get room to be shapes. */}
      <Field label="Aspect ratio" note={shapeNote(engineName, blocked)}>
        <Choices
          label="Aspect ratio"
          className="sc-seg"
          value={formatId}
          ids={FORMATS.map((f) => f.id)}
          unavailable={blocked}
          onChange={onFormat}
        >
          {FORMATS.map((f) => (
            <Choice
              key={f.id}
              id={f.id}
              className="sc-seg-o sc-seg-ratio"
              on={f.id === formatId}
              unavailable={blocked.includes(f.id)}
              label={`${f.label}, ${f.hint}`}
              onPick={() => onFormat(f.id)}
            >
              <RatioGlyph w={f.w} h={f.h} slot={17} box={14} />
              {f.hint}
            </Choice>
          ))}
        </Choices>
      </Field>

      {/* Frame count genuinely cannot survive an edit: the request carries no
          count, so an edit returns exactly one picture however many are asked
          for. Unlike the shape, there is nothing here to reinterpret. */}
      {mode === 'generation' && (
        /* Variants, not versions: these are the images one brief returns. A
           version is a branch off a finished shot, which is a different thing
           entirely. */
        <Field label="Variants">
          <Choices
            label="Variants"
            className="sc-seg"
            value={String(count)}
            ids={VARIANTS.map(String)}
            onChange={(id) => onCount(Number(id))}
          >
            {VARIANTS.map((n) => (
              <Choice
                key={n}
                id={String(n)}
                className="sc-seg-o"
                on={n === count}
                label={`${n} variant${n === 1 ? '' : 's'}`}
                onPick={() => onCount(n)}
              >
                {n}
              </Choice>
            ))}
          </Choices>
        </Field>
      )}

      {/* Resolution is the long edge asked of the engine, and an edit request
          carries no size at all: it is handed the picture and an instruction,
          and returns one the same shape. So this did nothing on a refinement
          either, which is worse than absent — the setting moved, the number
          changed, and the result could not have been affected. The same is true
          on an engine that keeps the ratio and drops the pixels. */}
      {mode === 'generation' && sizing !== 'ratio' && (
        <Field
          label="Resolution"
          // An advisory engine renders at its own size and is asked, in words,
          // to deliver this one. Printing "1536 px" as a flat fact there states
          // a promise the engine never made, so it says what it actually is.
          note={
            sizing === 'advisory'
              ? 'This engine renders at its own size, so this is a request rather than a guarantee.'
              : undefined
          }
        >
          <Choices
            label="Resolution"
            className="sc-seg"
            value={quality}
            ids={RESOLUTIONS.map((r) => r.id)}
            onChange={(id) => onQuality(id as QualityId)}
          >
            {RESOLUTIONS.map((r) => (
              <Choice
                key={r.id}
                id={r.id}
                className="sc-seg-o"
                on={r.id === quality}
                label={
                  sizing === 'advisory'
                    ? `${r.label}, asks for ${r.edge} px, ${r.note}`
                    : `${r.label}, ${r.edge} px, ${r.note}`
                }
                onPick={() => onQuality(r.id)}
              >
                {r.label}
              </Choice>
            ))}
          </Choices>
        </Field>
      )}
    </>
  );
}

/**
 * A named setting and every answer it has, under it.
 *
 * The name used to sit opposite the answers, which put three strips of
 * different widths down the right edge and left the shape — the one setting
 * that needs room to be shapes — squeezed into whatever was left. Stacked, all
 * three read at one rhythm and every answer is the same size as every other,
 * which is what a thumb wants and what a small sheet needs.
 *
 * The name is a caption, not a group label: the radio group inside carries the
 * accessible name, and every option states itself in full through its own
 * aria-label ("Square, 1:1", "2 variants", "Draft, 768 px, quick checks").
 */
function Field({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="sc-shotfield">
      <span className="sc-shotfield-lb">{label}</span>
      {children}
      {note && <p className="sc-shotfield-note">{note}</p>}
    </div>
  );
}
