/**
 * Dial geometry.
 *
 * Angles are measured CLOCKWISE FROM 12 O'CLOCK, so 0° is the top of the circle and
 * the day reads downward the way a clock face does. This matters for a whole
 * non-obvious reason: the sweep flag is inverted between sources.
 *
 *   SVG 2, equation 4.4  —  sweep-flag = 1 means CLOCKWISE in screen coordinates
 *                           (y grows downward, so "clockwise on screen").
 *   Smashing Magazine's arc article describes 1 as counter-clockwise. It is wrong.
 *   We follow SVG 2. See docs/research/day-dial-svg.md §1.
 *
 * PROGRESS IS NOT DRAWN WITH `d`. Interpolating `d` makes the large-arc flag flip at
 * 50% and the arc visibly tears. Every progress arc is instead a fixed-length path
 * with `pathLength="100"`, `stroke-dasharray: 100 100`, and an animated
 * `stroke-dashoffset = 100 − startUnits − lengthUnits`. `d` is constant; only a
 * scalar changes.
 */

export interface Point {
  x: number;
  y: number;
}

/** Clockwise from 12 o'clock, 0° at the top, 90° at the right. */
export function polarToCartesian(cx: number, cy: number, radius: number, angleDeg: number): Point {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

/**
 * Angle for a clock time, measured clockwise from twelve o'clock.
 *
 * The full circle is the AWAKING DAY, 08:30 to 24:00 — 15.5 hours — not the 24-hour
 * clock. Twelve o'clock is 08:30 (wake) and the day closes back at twelve o'clock
 * (sleep).
 *
 * This matters more than it sounds. Mapping 24 hours onto 360° puts the day's
 * 15.5 hours in a 93° wedge, so a quarter of the dial carries all the information and
 * the rest is decoration. Mapping the awake span instead makes every degree mean
 * something: 9 hours of study is 59% of the circle, and the gaps are visible as gaps.
 *
 * Times before 08:30 wrap to the end of the circle. The dial does not draw them —
 * sleep is not part of the day — but the needle uses the wrap to park itself.
 */
export function minutesToAngle(minutes: number, dayStartMin: number, dayLengthMin: number): number {
  const offset = ((minutes - dayStartMin) % (24 * 60) + 24 * 60) % (24 * 60);
  return (offset / dayLengthMin) * 360;
}

/**
 * Open arc, stroked rather than filled.
 *
 * Drawn with a single A command and `large-arc` chosen from the sweep. Used for
 * every progress band, which means these paths never change — only the dash offset
 * moves.
 */
export function arcPath(cx: number, cy: number, radius: number, startDeg: number, endDeg: number): string {
  const sweep = endDeg - startDeg;
  // A zero-length arc renders nothing, and a full circle cannot be expressed with a
  // single A. Callers clamp to a tiny sliver rather than emitting a degenerate path.
  const safeEnd = Math.abs(sweep) < 0.01 ? startDeg + 0.01 : endDeg;
  const largeArc = Math.abs(safeEnd - startDeg) > 180 ? 1 : 0;
  const sweepFlag = safeEnd >= startDeg ? 1 : 0;

  const from = polarToCartesian(cx, cy, radius, startDeg);
  const to = polarToCartesian(cx, cy, radius, safeEnd);
  return `M ${from.x.toFixed(3)} ${from.y.toFixed(3)} A ${radius} ${radius} 0 ${largeArc} ${sweepFlag} ${to.x.toFixed(3)} ${to.y.toFixed(3)}`;
}

/**
 * Full ring as a stroked circle.
 *
 * There is no `startDeg`, so there is no arc-flag ambiguity: the entire control of
 * this element's appearance is `stroke-dasharray`. This is the dim backing track.
 */
export function fullRingPath(cx: number, cy: number, radius: number): string {
  const { x, y } = polarToCartesian(cx, cy, radius, 0);
  return `M ${x.toFixed(3)} ${y.toFixed(3)} A ${radius} ${radius} 0 1 1 ${(2 * cx - x).toFixed(3)} ${(2 * cy - y).toFixed(3)}`;
}

/**
 * Filled donut segment, used for the clickable hit area so that the whole wedge
 * counts — including the hollow middle and the gaps between neighbours.
 *
 * `fill-rule="evenodd"` means winding direction is irrelevant: the two subpaths alone
 * create the hole. The outer ring is still drawn clockwise and the inner counter-
 * clockwise so the shape survives a stylesheet reset to the `nonzero` default.
 */
export function donutSegmentPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startDeg: number,
  endDeg: number,
): string {
  const outer = arcPath(cx, cy, rOuter, startDeg, endDeg);
  const inner = arcPath(cx, cy, rInner, endDeg, startDeg); // reversed → counter-clockwise
  return `${outer} L ${polarToCartesian(cx, cy, rInner, startDeg).x.toFixed(3)} ${polarToCartesian(cx, cy, rInner, startDeg).y.toFixed(3)} ${inner} Z`;
}

/** Plain wedge, centre to rim. Used for the hover wash under a slice. */
export function wedgePath(cx: number, cy: number, rOuter: number, startDeg: number, endDeg: number): string {
  const to = polarToCartesian(cx, cy, rOuter, startDeg);
  const arc = arcPath(cx, cy, rOuter, startDeg, endDeg);
  return `M ${cx} ${cy} L ${to.x.toFixed(3)} ${to.y.toFixed(3)} ${arc} Z`;
}

/**
 * `stroke-dashoffset` for a sub-arc, in `pathLength` units.
 *
 * Each slice is its own path carrying `pathLength="100"`, which normalises that arc's
 * length to 100 units regardless of its real pixel length or its angular span. So a
 * slice covering 6% of the day is still a 100-unit path, and a block that is 50%
 * focused draws a 50-unit lit band. That is what makes the numbers radius-independent:
 * the same value works for a 2° sliver and a 40° block.
 *
 * `fromUnits` is where the sub-arc begins, 0 for the start of the slice.
 */
export function dashFor(fromUnits: number, lengthUnits: number): { dasharray: string; dashoffset: number } {
  const from = clampUnits(fromUnits);
  const len = clampUnits(lengthUnits);
  return {
    // A zero-length dash would render as a stray line cap, so render it as nothing.
    dasharray: len <= 0.01 ? "0 100" : `${len} ${100 - len}`,
    // Position `p` on the path shows pattern index `(p + dashoffset) mod 100`, so
    // subtracting the start pushes the dash forward to begin there.
    dashoffset: -from,
  };
}

/** The whole path. Used for the dim track, which is always fully drawn. */
export function fullDash(): { dasharray: string; dashoffset: number } {
  return { dasharray: "100 100", dashoffset: 0 };
}

function clampUnits(units: number): number {
  if (!Number.isFinite(units)) return 0;
  if (units < 0) return 0;
  if (units > 100) return 100;
  return units;
}

/**
 * Mid-angle of a segment, used to place labels and to align the timer panel to the
 * slice it belongs to.
 */
export function midAngle(startDeg: number, endDeg: number): number {
  return (startDeg + endDeg) / 2;
}

/**
 * A small gap between slices, in degrees, applied at both ends of a segment.
 *
 * One degree is about 1.2px at a 70px radius and 5px at a 300px radius, so a fixed
 * degree value scales with the dial. Two degrees reads as a hairline gap at hero
 * size without swallowing a 40-minute block.
 */
export function withGaps(startDeg: number, endDeg: number, gapDeg = 1.2): [number, number] {
  const half = Math.min(gapDeg, Math.max(0, (endDeg - startDeg) / 4));
  return [startDeg + half, endDeg - half];
}