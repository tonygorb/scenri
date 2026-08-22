import { useCallback, useState, type CSSProperties } from 'react';

/**
 * A feed picture that holds its own space until it can actually be seen.
 *
 * The shot that just finished is the one moment the app has no cached copy of
 * the picture: the shimmer used to unmount in the same commit that mounted the
 * image, so the tile went blank for the whole decode of a full resolution PNG
 * and then snapped. Here the shimmer stays until the browser says the pixels
 * are ready, the box keeps the brief's own shape while it waits, and the image
 * fades in rather than appearing mid-scroll.
 *
 * The callback ref is not decoration: a cached image can finish loading before
 * React attaches its onLoad, and without the `complete` check that picture
 * would never be marked loaded and never become visible.
 */
export function FeedImage({ src, alt = '', aspect }: { src: string; alt?: string; aspect?: number }) {
  const [loaded, setLoaded] = useState(false);
  const measure = useCallback((el: HTMLImageElement | null) => {
    if (el?.complete) setLoaded(true);
  }, []);
  return (
    <span
      className="sc-cellimg"
      data-loaded={loaded || undefined}
      style={aspect ? ({ '--sc-cell-ar': aspect } as CSSProperties) : undefined}
    >
      {!loaded && <span className="sc-shimmer" />}
      <img
        ref={measure}
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
      />
    </span>
  );
}
