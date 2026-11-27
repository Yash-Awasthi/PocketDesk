export const IS_MAC = process.platform === "darwin";

/**
 * macOS input and the pointer work in points (CGEvent's global space), so displays stay in points.
 * Pixel ratios are never needed: viewers point by fraction of the picture, and on HiDPI modes
 * CGDisplayPixelsWide reports points anyway. avfoundation numbers screens in the same
 * CGGetActiveDisplayList order, which is `output`.
 */
export function macMonitors(list) {
  return list.map((m, i) => ({
    adapter: 0,
    output: i,
    name: `Display ${i + 1}`,
    left: m.x,
    top: m.y,
    w: m.w,
    h: m.h,
    primary: !!m.primary,
  }));
}

/** A fraction of the picture showing [rect] to input coordinates, and the pointer back to a fraction. */
export const fromFraction = (r, fx, fy) => ({ x: r.x + fx * r.w, y: r.y + fy * r.h });
export const toFraction = (r, c) => ({ fx: (c.x - r.x) / r.w, fy: (c.y - r.y) / r.h });

/**
 * Where to put the pointer when a viewer opens [rect] (a monitor) after [previousIndex]: the
 * middle of a newly chosen screen; on first open (undefined) only if the pointer is on another one.
 */
export function centerFor(rect, pointer, previousIndex) {
  if (!rect || previousIndex === rect.index) return null;
  const on =
    pointer &&
    pointer.x >= rect.x &&
    pointer.x < rect.x + rect.w &&
    pointer.y >= rect.y &&
    pointer.y < rect.y + rect.h;
  return previousIndex === undefined && on ? null : fromFraction(rect, 0.5, 0.5);
}

/** The part of the input space a still frame shows: the main display on macOS, every monitor on Windows. */
export function jpegRect(list, mac = IS_MAC) {
  if (!list?.length) return null;
  if (mac) return list.find((m) => m.primary) || list[0];
  return {
    x: 0,
    y: 0,
    w: Math.max(...list.map((m) => m.x + m.w)),
    h: Math.max(...list.map((m) => m.y + m.h)),
  };
}
