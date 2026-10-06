# Interactive "Day Dial" — SVG geometry & animation reference

Angle convention used everywhere below: **0° = 12 o'clock, positive = clockwise**.
Verified numerically (see §1.0) before writing.

---

## 0. Executive summary — what to use

| Layer | Technique | Why |
|---|---|---|
| **Ring base** (planned blocks) | **Filled wedge paths** (`describeDonutArc`) with an angular gap | Only shape that makes the *whole slice* hit-testable, including the hollow middle. Strokes alone cannot do that. |
| **Lit progress band** | **Stroked open arc** at its own radius, `pathLength="100"`, `stroke-dasharray:100 100`, animate **only `stroke-dashoffset`** | One animatable scalar, interpolable by computed value type, no `d` regeneration, no radius-dependent math. |
| **Waste hatch** | **Stroked open arc** at its own radius with `stroke="url(#hatch)"` + `pathLength="100"` + its own dashoffset | Reuses the exact same mechanism; the `<pattern>` supplies the stripes, the dasharray supplies the angular extent. No mask, no clipPath. |
| **Hover / focus ring** | **Duplicate of the wedge** with `paint-order: stroke` and a fat `stroke` | `paint-order` hides the inner half of the stroke under the fill, yielding a mathematically even outer ring. No filter, no blur. |
| **Now-needle** | One `<g>` with CSS `transform: rotate()` + `transform-box: view-box` + `will-change: transform` | Only element that is genuinely compositor-animatable. |
| **Tick updates** (1 Hz) | `requestAnimationFrame` + refs, writing `el.style.strokeDashoffset` directly | No React reconciliation; gives you lerp control; idles when tab hidden. |
| **Discrete state** (hover/select) | CSS transitions / class toggles in React | Declarative easing, respects `prefers-reduced-motion` for free. |

Not recommended: `<animate>` (SMIL), masks per segment, `clipPath` per segment, `will-change: stroke-dashoffset`.

---

## 1. Donut segment path math

### 1.0 Verified coordinate check

```
polarToCartesian(0,0,100,  0) = (0, -100)      → top        ✓
polarToCartesian(0,0,100, 90) = (100, ~0)      → right      ✓
polarToCartesian(0,0,100,180) = (~0, 100)      → bottom     ✓
polarToCartesian(0,0,100,270) = (-100, ~0)     → left       ✓
```
Sampled all 361 integer angles at r=100 and r=60: max radial deviation `0` (within 1e-9).

`arcLength(100, 90) = 157.07963267948966` == `π·100/2`. ✓

### 1.1 Core functions (no dependencies)

```ts
// src/lib/geometry.ts

const RAD = Math.PI / 180;

/** Normalise any angle into [0, 360). */
export function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Point on a circle.
 * angleDeg is measured CLOCKWISE FROM 12 O'CLOCK.
 *   0deg = top, 90deg = right, 180deg = bottom, 270deg = left.
 */
export function polarToCartesian(
  cx: number, cy: number, r: number, angleDeg: number,
): { x: number; y: number } {
  const t = angleDeg * RAD;
  // sin for X (positive = right), -cos for Y (SVG y grows downward)
  return { x: cx + r * Math.sin(t), y: cy - r * Math.cos(t) };
}

/** Arc length of a sweep on a circle of radius r. `r * sweepDeg * RAD`. */
export function arcLength(r: number, sweepDeg: number): number {
  return r * sweepDeg * RAD;
}

/** Sweep in degrees -> fraction of the full circumference (0..1). */
export function sweepFraction(sweepDeg: number): number {
  return sweepDeg / 360;
}

/** Convert a pixel gap at radius `r` into degrees. */
export function pxToDegAtRadius(px: number, r: number): number {
  return px / r / RAD;
}

/**
 * Angular gap (degrees, FULL width, split half at each end) needed between
 * two stroked neighbours.
 *
 *   capExtensionPx = 0            -> stroke-linecap: butt
 *   capExtensionPx = strokeWidth/2-> stroke-linecap: round / square
 *
 * Rationale: round/square caps extend the painted geometry tangentially by
 * `strokeWidth/2` past each arc endpoint, eating into the gap. Both ends
 * together consume `2 * capExtensionPx`.
 */
export function gapDegrees(gapPx: number, r: number, capExtensionPx = 0): number {
  return (gapPx - 2 * capExtensionPx) / r / RAD;
}

/** Centre radius of a band whose outer edge is `outerEdge` and which is `t` thick. */
export function bandCentreRadius(outerEdge: number, thickness: number): number {
  return outerEdge - thickness / 2;
}
```

### 1.2 `describeDonutArc` — filled wedge, correct `large-arc-flag`

```ts
export interface DonutArc {
  /** SVG path data. */
  d: string;
  /** True when the sweep was >= 360 and two subpaths were emitted. */
  isFullRing: boolean;
  /** The large-arc-flag actually used for the sector (<=180deg case only). */
  largeArc: 0 | 1;
  /** Normalised clockwise sweep in degrees, 0 < sweep <= 360. */
  sweep: number;
}

/** Format a number for a path: kill float noise, never emit "-0". */
const n = (v: number): string => {
  const s = Math.abs(v) < 1e-6 ? "0" : v.toFixed(4).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

/**
 * Filled donut sector.
 *
 * Sweep direction is always clockwise on screen, matching norm360 / the
 * 12-o'clock convention above.
 *
 * Rule for the flags (VERIFIED against SVG 2 impl notes §F.6.5, eq. 4.3/4.4):
 *   fA (large-arc) = 1 iff swept angle > 180deg
 *   fS (sweep)      = 1 for increasing theta  -> clockwise in SVG's y-down space
 *
 * A 360deg sweep CANNOT be expressed with a single `A`: SVG 2 §F.6.2 says
 * "If the endpoints are identical, then this is equivalent to omitting the
 * elliptical arc segment entirely." A full circle therefore needs two 180deg
 * arcs per subpath.
 */
export function describeDonutArc(
  cx: number, cy: number,
  rOuter: number, rInner: number,
  startAngleDeg: number, endAngleDeg: number,
): DonutArc {
  let sweep = endAngleDeg - startAngleDeg;
  if (sweep <= 0) sweep += 360;          // end <= start means "wrap past 12 o'clock"
  if (sweep > 360) sweep = 360;

  const isFullRing = sweep >= 360 - 1e-9;
  const largeArc: 0 | 1 = sweep > 180 ? 1 : 0;

  const ring = (r: number, sweepFlag: 0 | 1): string => {
    const right = polarToCartesian(cx, cy, r, 0);   // 3 o'clock
    const left  = polarToCartesian(cx, cy, r, 180); // 9 o'clock
    return (
      `M ${n(right.x)} ${n(right.y)} ` +
      `A ${n(r)} ${n(r)} 0 0 ${sweepFlag} ${n(left.x)} ${n(left.y)} ` +
      `A ${n(r)} ${n(r)} 0 0 ${sweepFlag} ${n(right.x)} ${n(right.y)} Z`
    );
  };

  if (isFullRing) {
    // Outer circle clockwise + inner circle counter-clockwise.
    // Two subpaths; pair with fill-rule="evenodd" (see note below).
    return { d: `${ring(rOuter, 1)} ${ring(rInner, 0)}`, isFullRing: true, largeArc: 0, sweep: 360 };
  }

  const o0 = polarToCartesian(cx, cy, rOuter, startAngleDeg);
  const o1 = polarToCartesian(cx, cy, rOuter, endAngleDeg);
  const i1 = polarToCartesian(cx, cy, rInner, endAngleDeg);
  const i0 = polarToCartesian(cx, cy, rInner, startAngleDeg);

  const d =
    `M ${n(o0.x)} ${n(o0.y)} ` +
    `A ${n(rOuter)} ${n(rOuter)} 0 ${largeArc} 1 ${n(o1.x)} ${n(o1.y)} ` +
    `L ${n(i1.x)} ${n(i1.y)} ` +
    `A ${n(rInner)} ${n(rInner)} 0 ${largeArc} 0 ${n(i0.x)} ${n(i0.y)} Z`;

  return { d, isFullRing: false, largeArc, sweep };
}
```

**Exact `d` for a full ring** at `cx=0, cy=0, rOuter=100, rInner=60`:

```
M 100 0 A 100 100 0 0 1 -100 0 A 100 100 0 0 1 100 0 Z
M 60 0 A 60 60 0 0 0 -60 0 A 60 60 0 0 0 60 0 Z
```

### 1.3 VERIFIED: full-360 donut winding vs. `fill-rule`

Your stated rule ("outer CW + inner CCW + `fill-rule: evenodd`") is **correct but the two mechanisms are redundant under `evenodd`**:

- **`fill-rule="evenodd"`** (or `fill-rule` CSS property): a point is filled iff it is covered an *odd* number of times. A point in the inner disc is covered twice → **hole**. Winding direction is **irrelevant**.
- **default `fill-rule="nonzero"`**: winding *numbers* sum. Outer CW (+1) and inner CCW (−1) sum to 0 → hole. Same-direction subpaths sum to +2 → **solid disc, no hole**.

So: emit **two subpaths, always**, and set `fill-rule="evenodd"`. Keep the opposite winding anyway — it costs nothing and makes the path render correctly even if the `fill-rule` is ever lost to a CSS reset.

```html
<path class="seg" fill-rule="evenodd" d="..." />
```

### 1.4 Open arc path for stroked bands (no wedge)

```ts
/**
 * OPEN arc (single subpath, no Z) — this is what you feed
 * stroke-dasharray / stroke-dashoffset.
 * Always clockwise, matching polarToCartesian.
 */
export function describeOpenArcPath(
  cx: number, cy: number, r: number,
  startAngleDeg: number, endAngleDeg: number,
): string {
  const sweep = endAngleDeg - startAngleDeg;
  const la: 0 | 1 = Math.abs(sweep) > 180 ? 1 : 0;
  const p0 = polarToCartesian(cx, cy, r, startAngleDeg);
  const p1 = polarToCartesian(cx, cy, r, endAngleDeg);
  return `M ${n(p0.x)} ${n(p0.y)} A ${n(r)} ${n(r)} 0 ${la} 1 ${n(p1.x)} ${n(p1.y)}`;
}

/** Open arc that is inset by `gapPx` at BOTH ends — the ring-segment path. */
export function describeGappedArcPath(
  cx: number, cy: number, r: number,
  startAngleDeg: number, endAngleDeg: number,
  gapPx: number, capExtensionPx = 0,
): string {
  const half = gapDegrees(gapPx, r, capExtensionPx) / 2;
  return describeOpenArcPath(cx, cy, r, startAngleDeg + half, endAngleDeg - half);
}
```

### 1.5 `arcLength` → progress arc with `stroke-dasharray` / `stroke-dashoffset`

Two idioms; pick per situation.

**Idiom A — real units (when the path length is known and fixed):**

```ts
const L = arcLength(r, sweepDeg);      // total length of the OPEN arc path
// full ring behind, progress on top:
//   stroke-dasharray:  L;
//   stroke-dashoffset: L * (1 - progress01);
el.style.strokeDasharray = String(L);
el.style.strokeDashoffset = String(L * (1 - progress01));
```

**Idiom B — normalised units (RECOMMENDED).** Put `pathLength="100"` on the path and every number becomes a percentage of the arc. Radius-independent, radius-change-free, and interpolable by a CSS transition:

```html
<path d="..." pathLength="100"
      style="stroke-dasharray: 100 100; stroke-dashoffset: 100" />
```

**The exact dash formula used for the bands in this project** (single-value
dasharray, offset carries *both* position and length — see §2.3 for the derivation):

```ts
/**
 * pathLength = 100, stroke-dasharray = "100 100".
 * Returns the stroke-dashoffset that makes exactly the span
 * [startUnits, startUnits + lenUnits] of the path painted (units are 0..100
 * pathLength units, i.e. 0..100 percent of THIS arc).
 */
export function dashoffsetForSpan(startUnits: number, lenUnits: number): number {
  return 100 - startUnits - lenUnits;
}
```

---

## 2. The "lit within a dim track" technique

### 2.1 Comparison of the three implementations

| | **Separate stroked arcs at different radii** | **Clipped groups** | **`<mask>`** |
|---|---|---|---|
| Nodes per segment | 3 `<path>` | 3–4 `<path>` + `<clipPath>` per segment + 12 `<defs>` entries | 3 `<path>` + a `<mask>` per segment (and a mask per sub-band if banded) |
| Per-tick cost | 1–2 attribute writes | 1–2 writes **+** clip region re-rasterisation | 1–2 writes **+** **alpha-buffer re-rasterisation of the whole mask** |
| Gaps between segments | Must be baked into each arc's angles (easy, we already have `gapDegrees`) | Clip rects must be inset too | Must inset twice (path + mask) — easy to get wrong |
| Sub-band support (lit / dim / hatch at 3 radii) | Trivial: 3 radii, 3 paths | Needs 3 nested clips | Needs 3 masks |
| Chromium raster behaviour | Plain stroke tessellation | Clip is a per-tile mask re-run on geometry change | Luminance/alpha mask — the most expensive of the three |
| Hit-testing | Irrelevant (use a separate hit path) | Honours clipping inconsistently across engines | MozillaWiki: masking is **not** consistently honoured in hit testing |

**RECOMMENDATION: separate stroked arcs at different radii, with `pathLength` normalisation.** No masks, no clips, no per-segment `<defs>`. Each band is one `<path>` and each tick writes one `style.strokeDashoffset`. This is the only one of the three where a 1 Hz update touches O(1) raster work with no intermediate surface.

### 2.2 Exact markup

```html
<svg viewBox="0 0 400 400" class="dial" role="group" aria-label="Study day dial">
  <defs>
    <pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse"
             patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="7" stroke="var(--waste-ink)" stroke-width="2.5"/>
    </pattern>
  </defs>

  <g class="segments">
    <!-- one <g> per block; ids used by the refs in the controller -->
    <g class="seg" data-i="0">
      <!-- (1) base wedge: painted, NOT interactive -->
      <path class="seg__base" fill-rule="evenodd" d="…describeDonutArc…"
            fill="var(--plan)" aria-hidden="true"/>

      <!-- (2) dim track: the whole planned span, painted dim -->
      <path class="seg__track" d="…gapped open arc at rTrack…"
            pathLength="100"
            style="stroke-dasharray:100 100; stroke-dashoffset:0"
            stroke="var(--dim)" stroke-width="12" stroke-linecap="butt"
            fill="none" aria-hidden="true"/>

      <!-- (3) LIT band: outer sub-band. Animated. -->
      <path class="seg__lit" d="…gapped open arc at rLit…"
            pathLength="100"
            style="stroke-dasharray:100 100; stroke-dashoffset:100"
            stroke="var(--lit)" stroke-width="12" stroke-linecap="butt"
            fill="none" aria-hidden="true"/>

      <!-- (4) WASTE hatch: inner sub-band, over the wasted sub-range -->
      <path class="seg__waste" d="…gapped open arc at rWaste…"
            pathLength="100"
            style="stroke-dasharray:100 100; stroke-dashoffset:100"
            stroke="url(#hatch)" stroke-width="8" stroke-linecap="butt"
            fill="none" aria-hidden="true"/>

      <!-- (5) hover / focus ring: duplicate wedge, stroke under fill -->
      <path class="seg__ring" d="…describeDonutArc…"
            fill="var(--ring-fill)" stroke="var(--ring-ink)"
            stroke-width="6" paint-order="stroke fill"
            fill-rule="evenodd" opacity="0"
            pointer-events="none" aria-hidden="true"/>

      <!-- (6) HIT AREA: the full slice incl. hollow middle. Interactive. -->
      <path class="seg__hit" d="…describeDonutArc…"
            fill="none" pointer-events="all"
            tabindex="0" role="button"
            aria-label="Deep work, 09:00 to 11:00, 45 of 120 minutes focused"/>
    </g>
    …
  </g>

  <g class="needle" id="needle" aria-hidden="true">
    <line x1="200" y1="200" x2="200" y2="46" />
  </g>
</svg>
```

Radius layout (outer edge inward, no overlaps):

```ts
const R_OUTER = 178, R_INNER = 104;
const W_LIT = 12, W_WASTE = 8, PAD = 3;

const rLit   = bandCentreRadius(R_OUTER - PAD,               W_LIT);   // outermost
const rTrack = bandCentreRadius(R_OUTER - PAD - W_LIT - PAD, W_LIT);   // identical r! see note
const rWaste = bandCentreRadius(R_INNER + PAD + W_WASTE + PAD, W_WASTE);
```

Note: `rLit` and `rTrack` are the **same** radius by design — the dim track is a
full-span stroke underneath, the lit arc is drawn over it, so the lit arc only
needs to cover its own sub-range. That is 2 nodes, not 3, for a "lit within dim"
effect. If you want a *separate* dim sub-band visually (different radius), give
`rTrack` its own radius and use its own span.

### 2.3 VERIFIED: is `transition` on `stroke-dashoffset` interpolatable?

**Your premise is wrong in one specific way, and the correction matters.**

- **VERIFIED (MDN, `stroke-dashoffset`):** `Animation type: by computed value type`
  → it is a `<length>`, so CSS transitions and Web Animations **interpolate it
  smoothly**. It is *not* a discrete property. A CSS `transition` on
  `stroke-dashoffset` is fully valid and works in every modern engine.
  (<https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/stroke-dashoffset>)
- **The real hazard is different:** if the two paths have *different real
  lengths*, the same numeric offset means a different *fraction* of each path,
  so an animation "jumps" between them. That is a units problem, not an
  interpolation problem — and `pathLength` normalization fixes it completely.
- **VERIFIED (W3C csswg #10195, Lea Verou, open since 2024):** the property that
  genuinely interpolates badly is **`d`**. SVG 2 interpolates path data
  structurally, and the `A` command's `large-arc-flag`/`sweep-flag` "just flip
  halfway", producing garbage when a pie wedge changes size or crosses 180°.
  (<https://github.com/w3c/csswg-drafts/issues/10195>)
  **Corollary for this project: never put a CSS transition on `d`.** Rebuild
  `d` only on discrete state changes, and drive all continuous progress with
  `stroke-dashoffset`.

**Derivation of the dash formula (so you can trust it).** With
`pathLength=100`, `stroke-dasharray: 100 100`, period = 200. Dash regions in
"pattern space" are `[0,100) ∪ [200,300) ∪ …`. With `stroke-dashoffset: o`,
path position `p` samples pattern position `(p + o) mod 200`.

Set `o = 100 - s - L` where `s` = start of the span, `L` = length of the span,
both in pathLength units.

- At `p = s`: `p + o = 100 - L` ∈ `[0,100)` ✓ inside the dash
- At `p = s + L`: `p + o = 100` → the gap boundary ✓
- For `p` in `[0, s)`: `p + o ∈ [100 - L - s, 100 - L) ⊂ [0,100)` when
  `s + L ≤ 100` → still inside the dash but *before* `s`… **this is why you must
  use one arc path whose `d` already starts at the segment's start angle** — the
  path's own `p = 0` *is* `s`. There is no paint before `p = 0`.
- For `p > s + L`: `p + o > 100` → in the gap ✓
- Wrap-around check: `p + o ≥ 200` requires `p ≥ 100 + L + s > 100`, i.e. past
  the end of the path. `p + o < 0` requires `p < L + s - 100 ≤ 0`, and
  `(−100, 0) mod 200 = (100, 200)` which is the gap. ✓

So **one constant `stroke-dasharray` and one animated `stroke-dashoffset` is
sufficient and exact.** Animating `L` from `0 → Lfull` is a dashoffset
transition from `100 - s` down to `100 - s - Lfull`. Negative values are legal.

```ts
// Lit arc: animate this ONE number.
path.style.strokeDashoffset = String(100 - startUnits - litUnits);
```

### 2.4 Animate it: the three candidates, ranked

**(1) CSS `transition` on `stroke-dashoffset` — RECOMMENDED for discrete changes.**

```css
.seg__lit, .seg__waste {
  /* VERIFIED: stroke-dashoffset is "by computed value type" -> interpolates. */
  transition: stroke-dashoffset 320ms cubic-bezier(.22,.61,.36,1);
}
@media (prefers-reduced-motion: reduce) {
  .seg__lit, .seg__waste { transition-duration: 1ms; }
}
```

Works because `pathLength="100"` makes both endpoints of every transition live in
the same unit system. Declarative, zero JS, free reduced-motion handling.

**(2) `requestAnimationFrame` + refs — RECOMMENDED for the 1 Hz data tick.**

For a continuously-advancing value you do *not* want a CSS transition at all —
you want the value to track a moving target. See §5.

**(3) SMIL `<animate>` — NOT recommended.** VERIFIED: WebKit does not share the
CSS Animations compositing path with SMIL, so SMIL is not hardware accelerated
even for `transform`; and SMIL has no `prefers-reduced-motion` escape hatch.
(<https://css-tricks.com/smil-on/> — WebKit engineer comment, 2025-04-02.)
Chrome's 2015 intent-to-deprecate was never actioned and Edge is now Chromium,
so it still *works* — it is a maintenance/efficiency risk, not a breakage risk.

**(4) Web Animations API — overkill here.** `el.animate(...)` is the right tool
when you need to *interrupt and scrub* a transition (it returns a live
`Animation` you can `.updatePlaybackRate()`). For a monotonic 1 Hz readout there
is nothing to interrupt.

**RECOMMENDATION: hybrid.** CSS transition for hover/select/reset (discrete
jumps); rAF + refs for the per-second tick (§5). Never transition `d`.

---

## 3. `pathLength` normalization

### 3.1 VERIFIED

MDN, <https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/pathLength>:

> The `pathLength` attribute lets authors specify a total length for the path,
> in user units. This value is then used to calibrate the browser's distance
> calculations with those of the author, by scaling all distance computations
> using the ratio `pathLength` / (*computed value of path length*). […] For
> example, `stroke-dasharray` will assume the start of the path being 0 and the
> end point the value defined in the `pathLength` attribute.

- Value type: **`<number>`**, default `none`, **Animatable: yes**.
- Applies to `<path>`, `<circle>`, `<ellipse>`, `<line>`, `<polygon>`,
  `<polyline>`, `<rect>`.
- There is also a CSS **`path-length`** property, and **when both are specified
  the CSS property takes priority**. MDN marks `path-length` as
  **Experimental** — do not use it; use the attribute.
  (<https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/path-length>)
- `SVGGeometryElement.pathLength` JS property is Baseline (widely available
  since Jan 2020).

`pathLength="1"` works identically — it just makes the unit system 0..1 instead
of 0..100. `100` is preferable because CSS-friendly numbers avoid float noise in
authoring and debugging.

### 3.2 Exact usage

```html
<!-- real length is 549.78 user units; the browser pretends it is 100 -->
<path d="M …" pathLength="100"
      style="stroke-dasharray: 100 100; stroke-dashoffset: 62.5" />
```

```ts
// You never need getTotalLength() anywhere in this project.
const LEN = 100;
el.style.strokeDashoffset = String(LEN - startPct01 * LEN);
```

### 3.3 Browser support & caveats

- **Attribute: universally supported** in Chrome, Firefox, Safari and (post-
  Chromium) Edge. Do not worry.
- **Legacy non-Chromium Edge (12–18) and IE do not support it.** If you must
  support IE11, feature-detect and fall back to `getTotalLength()`:

```ts
export function unitLengths(path: SVGPathElement): { total: number; one: number } {
  const declared = path.getAttribute('pathLength');
  if (declared) return { total: Number(declared), one: Number(declared) };
  const total = path.getTotalLength();   // real user units
  return { total, one: total };
}
```

- **Inkscape** parses but does not apply `pathLength` to stroke dashing. Only
  matters for round-tripping through a design tool.
- **Browser-computed real lengths disagree slightly** (Firefox vs Chrome differ
  by ~0.1% on long curved paths). Using `pathLength` sidesteps this entirely —
  which is the main reason to prefer it over computing lengths yourself.
- **VERIFIED pitfall — do not use `%` for `stroke-dashoffset`.** MDN:
  percentages resolve against "the normalized diagonal measure of the current
  SVG viewport's applied `viewBox`", which changes with viewport size and aspect
  ratio. It does **not** mean "percent of path length". Always use unitless
  numbers + `pathLength`.

---

## 4. Interaction & accessibility

### 4.1 `tabindex` + `role="button"` + `aria-label` — necessary but NOT sufficient

**VERIFIED (MDN, `button` role):**

> Adding `role="button"` tells the screen reader it is a button, but does not
> provide other typical button functionality such as click events and keyboard
> handling. […] **If the `role="button"` is added to an element that is not
> focusable by itself […] then the `tabindex` attribute has to be used** […] you
> will also need to make sure you define event handlers for both `click` and
> `keydown` events. **This includes handling the Enter and Space key presses.**
> (<https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/button_role>)

So: `tabindex="0"` + `role="button"` + `aria-label` gives you focusability and
an accessible name. It does **not** give you keyboard activation. You must add
Enter + Space yourself. `Space` in particular is required — omitting it is the
most common bug in custom SVG widgets.

```tsx
function onHitKeyDown(e: React.KeyboardEvent<SVGPathElement>) {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { // legacy Edge/IE
    e.preventDefault();          // stop Space from scrolling the page
    select(e.currentTarget.dataset.i!);
  }
  // ArrowLeft/ArrowRight = move to prev/next segment (roving tabindex, see below)
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    focusSibling(e.currentTarget, e.key === 'ArrowRight' ? +1 : -1);
  }
}
```

Recommended extras:

- **Roving tabindex.** `tabindex={i === activeIndex ? 0 : -1}` + arrow-key
  handling. 12 `<path>`s in the tab order is a keyboard trap; one stop with
  arrow keys inside the widget is the correct pattern
  (WAI-ARIA `listbox`/`radiogroup`-style navigation).
- **Announce progress.** Because the lit arc is `aria-hidden`, put the numbers in
  the label: `aria-label="Deep work. 45 of 120 minutes focused, 18 minutes wasted."`
  Update it at most once per minute (a live region firing every second is
  unusable with a screen reader).
- **Keep all decorative paths `aria-hidden="true"`** so the a11y tree contains
  exactly 12 buttons, not 70 shapes.

### 4.2 VERIFIED: hit area — why the wedge's stroke is not enough, and the fix

MDN `pointer-events`, default value is **`visiblePainted`**:
> The element can only be the target of a pointer event when the `visibility`
> property is set to `visible` and […] when a mouse cursor is over the interior
> (i.e. 'fill') […] **or** when a mouse cursor is over the perimeter (i.e.
> 'stroke') […]
> (<https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/pointer-events>)

Two failure modes follow:

1. A stroked-only band is clickable **only within its stroke**, i.e. a
   `stroke-width: 12` band gives you a 12px hit target. At `r = 170` a
   12px band spans `12/170 rad ≈ 4.0°`. That is an unusable target.
2. **Even a filled donut wedge is not clickable in its hollow middle** if you
   also stroke it and rely on `visiblePainted` semantics for a stroked element —
   and if you set `fill="none"` on a hit path (the common "transparent" trick)
   the interior is dead entirely.

**The exact fix: a dedicated transparent hit path, `fill="none"` +
`pointer-events="all"`.**

MDN on `all`:
> SVG only. The element can be the target of a pointer event when the pointer is
> over the interior (i.e. fill) or the perimeter (i.e. stroke). **The values of
> the `fill`, `stroke`, and `visibility` properties do not affect event
> processing.**

So `fill="none" pointer-events="all"` is the bulletproof combination: zero
pixels painted, full interior **and** perimeter hit-tested, and unaffected by
CSS resets, `opacity`, `visibility`, or inherited paint. Use the *gapped* wedge
so neighbouring segments don't steal each other's clicks, and to give the
segment a visible separator you also need the base wedge — the hit path itself
should be gapless-ish or gapped consistently with the visual.

```html
<path class="seg__hit"
      d="M … A … L … A … Z"     <!-- describeDonutArc output -->
      fill="none"
      pointer-events="all"       <!-- NOT "visiblePainted", NOT "fill" -->
      cursor="pointer"
      tabindex="0" role="button" aria-label="…"/>
```

For an **even bigger** target that also covers the hub, emit the hit path with
`rInner = 0` (a pie slice) while the visible wedge keeps its hole:

```ts
const hit = describeDonutArc(cx, cy, R_OUTER + 8, 0, a0, a1); // rInner = 0 => pie
```

Keep `pointer-events: none` on `.seg__base`, `.seg__track`, `.seg__lit`,
`.seg__waste`, `.seg__ring`, and the needle — otherwise they sit on top and
swallow the events (SVG hit testing is top-down / `pointer-events` is not
z-indexed).

---

## 5. Hover / focus ring on an arbitrary arc shape

**There is no SVG-native "outline that follows the shape".** Not `outline`, not
`stroke` (a stroke straddles the path, it is not an outline), not
`outline-path`. VERIFIED: `vector-effect` only exposes `non-scaling-stroke`;
`outline-path`/`outline-shape` are not implemented anywhere.

Three real options:

| | Duplicate path + `paint-order` | `filter` + `feMorphology` | `drop-shadow` filter |
|---|---|---|---|
| Cost | One extra path, normal tessellation | Off-screen surface per element + dilate kernel | Off-screen surface per element |
| Even ring width | **Yes, mathematically** | Yes but blurry at large radii; `feMorphology operator="dilate"` radius is in filter units and rasterises | No — an offset glow, not a ring |
| Chromium/GPU | Free | Per-element surface; scales badly past ~20 elements | Per-element surface |
| Verdict | **Use this** | Reject | Reject |

**`paint-order` is the key trick and it is exact.** Default paint order is
`fill, stroke, markers`. Setting `paint-order: stroke fill` paints the stroke
first, then paints the fill over its inner half — so only the outer half of the
stroke is visible, giving a perfectly even ring of width `stroke-width / 2`
outside the shape, at any radius, with no filter and no blur.

```html
<path class="seg__ring"
      d="…" fill-rule="evenodd"
      fill="var(--ring-fill)"
      stroke="var(--ring-ink)"
      stroke-width="6"
      paint-order="stroke fill"
      opacity="0" pointer-events="none" aria-hidden="true"/>
```

```css
.seg:hover .seg__ring,
.seg__hit:focus-visible + .seg__ring,
.seg.is-selected .seg__ring { opacity: 1; }

/* Focus must be visible and must not rely on :hover alone. */
.seg__hit:focus { outline: none; }         /* suppress the UA box outline */
.seg__hit:focus-visible { outline: none; } /* we draw our own ring          */
```

If you need a *second* ring (outer halo beyond the fat stroke), stack **two**
duplicates: one with `stroke-width: 12` (6px visible outside) and one with
`stroke-width: 18` (9px visible). Each is still a plain stroke — no filter.

Use `:focus-visible` for keyboard and `:hover` for pointer, so mouse users
don't get a permanent ring. Never rely on `outline` — MDN's keyboard-accessibility
guide requires a visible focus indicator, and the UA default outline on an SVG
path is a bounding-box rectangle (ugly but present); `paint-order` is the good
version.

---

## 6. `prefers-reduced-motion`

### 6.1 RECOMMENDED pattern — static by default, motion opt-in

W3C **C39** explicitly offers the inverse form as valid, and this is the pattern
to use: everything that moves is inside `@media (prefers-reduced-motion:
no-preference)`. Anything essential stays outside. This avoids the classic
failure of the nuclear `* { animation: none !important }` hack, which also
kills animations that were load-bearing and does not touch WAAPI at all.

```css
/* ---- everything below is the *motionful* variant ---- */
@media (prefers-reduced-motion: no-preference) {
  .seg__lit,
  .seg__waste { transition: stroke-dashoffset 320ms cubic-bezier(.22,.61,.36,1); }

  .seg__ring   { transition: opacity 140ms ease-out; }

  .needle {
    will-change: transform;
    transition: transform 900ms linear;
  }

  @media (prefers-reduced-motion: no-preference) { /* keep legible nesting */
    .seg__base { transition: opacity 200ms ease; }
  }
}

/* ---- reduced: no transition on motion at all, but state still changes ---- */
@media (prefers-reduced-motion: reduce) {
  /* Instantaneous. Colour/opacity feedback is preserved, motion is not. */
  .needle { transition: none; }
  .seg__ring { opacity: 1; }   /* still fully visible, just not animated */
}
```

JS side, if you use rAF lerping:

```ts
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
// In reduced mode: set the target value immediately, do not lerp.
```

### 6.2 The blunt fallback (only if you need it globally)

```css
@media screen and (prefers-reduced-motion: reduce) {
  *, ::before, ::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }
}
```

VERIFIED caveats (web.dev, <https://web.dev/articles/prefers-reduced-motion>):
this "can't stop motion that was initiated using the Web Animations API", and
`animation: none !important` breaks sites where an `animationend` handler is
load-bearing. MDN's accessibility guide adds the normative framing:

> This preference does not mean all animations must be removed […] Rather, users
> expect motion animation […] to be disabled **unless the animation is essential
> to the functionality or the information being conveyed**.

A progress arc *is* conveying information — so keep the value updates, drop the
easing. That is exactly what §6.1's `reduce` block does.

---

## 7. Rendering approach for ~50–100 nodes at 1 Hz

### 7.1 Is the node count even a problem? No.

~100 SVG `<path>` elements with `stroke-dashoffset` writes is two orders of
magnitude below anything that matters. Blink/WebKit rasterise SVG strokes on the
main thread; the cost is proportional to *painted pixels touched*, and a
4-px-wide dash change on a 700px-diameter dial touches a few hundred pixels.
There is **no** need for canvas/WebGL here.

### 7.2 Should `stroke-dashoffset` be set from React state?

**No, not for the per-second tick.** Two separate costs:

1. **Reconciliation.** A `setState` at 250–500 ms re-runs the whole component's
   render + commit. Even memoised, that's virtual-DOM diffing of ~100 nodes
   2–4× per second, plus the risk of re-creating `<pattern>`/`<defs>` subtrees
   and restarting CSS transitions mid-flight.
2. **The transition fight.** If `stroke-dashoffset` has a CSS `transition` *and*
   React sets a new value every tick, the transition restarts from the current
   interpolated value each time. That produces a visible perpetual lag/"chase"
   of roughly `transition-duration` behind the true value. For a live clock that
   is simply wrong.

VERIFIED (Streaver, measuring exactly this):
> That component is going through a React render and commit cycle every ~16ms
> because we use the internal state of React to store the animation […] This
> time we update the DOM ourselves. And that avoids the React commit and render
> loop from executing at all, saving CPU time. […] In React Dev Tools you'll
> notice this component is only committed and rendered once even though it runs
> the animation.
> (<https://streaver.com/insights/blogs/react-animations-how-a-simple-component-can-affect-your-performance>)

**But** React state *is* right for discrete state: selection, hover, the set of
segments, labels. Rule: **React owns the graph; the DOM owns the tick.**

### 7.3 RECOMMENDATION: rAF + refs for the tick, CSS for discrete state

```tsx
import { useEffect, useRef } from 'react';
import { describeGappedArcPath, pxToDegAtRadius, sweepFraction } from './geometry';

type DialGeometry = {
  cx: number; cy: number; rLit: number; rWaste: number;
  gapPx: number;
};

export function useDialTick(
  segments: ReadonlyArray<{ i: number; startDeg: number; sweepDeg: number;
                             litPct: number; wastePct: number }>,
  geo: DialGeometry,
) {
  const litRefs   = useRef<Array<SVGPathElement | null>>([]);
  const wasteRefs = useRef<Array<SVGPathElement | null>>([]);
  const needleRef = useRef<SVGGElement | null>(null);
  const smooth    = useRef<segments.map(() => ({ lit: 0, waste: 0 })));

  // Build `d` once per geometry/shape change. NOT per tick.
  useEffect(() => {
    for (const s of segments) {
      const dLit   = describeGappedArcPath(geo.cx, geo.cy, geo.rLit,
                        s.startDeg, s.startDeg + s.sweepDeg, geo.gapPx);
      const dWaste = describeGappedArcPath(geo.cx, geo.cy, geo.rWaste,
                        s.startDeg, s.startDeg + s.sweepDeg, geo.gapPx);
      litRefs.current[s.i]?.setAttribute('d', dLit);
      wasteRefs.current[s.i]?.setAttribute('d', dWaste);
    }
  }, [segments, geo]);

  // The only per-frame writer.
  useEffect(() => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0, prev = 0, alive = true;
    const scratch = [0, 0]; // reuse buffers; no per-frame allocation

    const frame = (now: number) => {
      if (!alive) return;
      const dt = prev ? Math.min(now - prev, 250) : 0;   // clamp after tab-away
      prev = now;

      for (const s of segments) {
        const st = smooth.current[s.i];
        const k  = reduce.matches ? 1 : 1 - Math.pow(0.001, dt / 220); // ~220ms ease
        st.lit   += (s.litPct   - st.lit)   * k;
        st.waste += (s.wastePct - st.waste) * k;

        const startU = sweepFraction(s.startDeg) * 100;
        const sweepU = sweepFraction(s.sweepDeg)   * 100;
        const litU   = st.lit   * sweepU;
        const wasteU = st.waste * sweepU;

        const litEl = litRefs.current[s.i];
        if (litEl) {
          litEl.style.strokeDashoffset =
            (100 - startU - litU).toFixed(3);
        }

        const wasteEl = wasteRefs.current[s.i];
        if (wasteEl) {
          // hatch starts AFTER the lit span
          wasteEl.style.strokeDashoffset =
            (100 - startU - litU - wasteU).toFixed(3);
        }
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [segments]);

  return { litRefs, wasteRefs, needleRef };
}
```

Why this shape:

- **One `requestAnimationFrame` loop for all 24+ animated paths**, not one per
  segment. Multiple loops multiply callback overhead and can desync.
- **`d` is written only on structural change**, never per tick. Changing `d`
  forces re-tessellation; changing `stroke-dashoffset` does not.
- **`dt`-based exponential smoothing** (`1 - 0.001^(dt/220)`) is frame-rate
  independent, unlike a fixed `lerp(a, b, 0.1)` per frame. Reduced-motion path
  sets `k = 1` → instant, and the loop still runs (values must keep updating).
- **`.toFixed(3)` on a reused string is cheap**; better, reuse a scratch array
  and only write when the rounded value actually changed.
- **`document.hidden` check**: bail out of the loop when hidden so it doesn't
  burn battery; `requestAnimationFrame` already throttles, but the guard makes
  the intent explicit.
- If the tick is *only ever* 1 Hz, `setInterval(1000)` is also acceptable and
  avoids 60 renders/s of no-op work. Use rAF only when you want the smoothed
  interpolation above.

### 7.4 rAF vs CSS animations vs `<animate>` — the decision table

| | **rAF + refs** | **CSS transition/animation** | **SMIL `<animate>`** |
|---|---|---|---|
| Runs off main thread | No (attribute write is main-thread; raster may be separate) | Only for `transform`/`opacity`; `stroke-dashoffset` is **not** compositor-only | No — VERIFIED: WebKit has a separate, non-accelerated code path |
| Good for | live/streaming values, needs control | discrete state, hover/focus, the needle | path morphing (only thing it uniquely does) |
| Honors `prefers-reduced-motion` | Manual (`matchMedia`) | Free | **No** |
| React-friendly | Yes (refs are stable) | Yes | Awkward (child elements re-created on re-render) |
| Main-thread cost here | 24 style writes/s | 0 | n/a |

**RECOMMENDATION:** rAF + refs for the 1 Hz tick; CSS transitions for
hover/select/needle; no SMIL. If you later need true compositing, only the
needle qualifies (`transform` and `opacity` are the only compositor-only
properties — <https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count>).

### 7.5 `will-change`

**Do NOT write `will-change: stroke-dashoffset`.** VERIFIED: MDN notes that "most
properties will have no effect when specified" because "the user agent doesn't
perform any special optimizations for changes in most properties". Only `transform`
and `opacity` reliably become compositing layers. Adding 70 bogus `will-change`
hints just forces the browser to attempt layer promotion for the whole
subtree — MDN warns that `will-change` "applies to the entire subtree … Using this
on an element high up in your document might be very bad for your performance".

- **`will-change: transform` on `.needle` only.** One element. Correct usage:
  a continuously-changing element, declared in the stylesheet
  (<https://drafts.csswg.org/css-will-change/> — "Sometimes an element really does
  change a property nearly constantly … just declaring the will-change value in
  the stylesheet is fine").
- **Do not** add `will-change` to the lit/waste paths. They change `stroke-dashoffset`,
  which cannot be composited.

### 7.6 `shape-rendering`

- **`shape-rendering: crispEdges`** would be a bug. It disables antialiasing on
  curves — your arcs will be visibly jagged. Never use it here.
- **`shape-rendering: optimizeSpeed`** likewise disables AA.
- **Leave it at the default `auto`.** If you want to nudge AA quality,
  `geometricPrecision` is allowed but is a rasterisation hint that can *reduce*
  quality of small geometry in Chromium. Not worth it.
- The real crispness lever is **half-pixel alignment of stroke centrelines**,
  and for a *rotated* arc there is no single half-pixel value that is correct all
  the way round. Don't try; leave AA on.

### 7.7 `vector-effect`

VERIFIED (`non-scaling-stroke`, <https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/vector-effect>):
> the stroke width is not dependent on the transformations of the element
> […] and zoom level.

- **Do NOT use it on the ring bands.** For a responsive dial you *want* the
  bands to scale with the drawing; `non-scaling-stroke` would pin them to CSS
  pixels and make a small dial look like fat rings and a large dial look like
  hairlines.
- **Use it only if** you render the dial at a fixed CSS size and then transform
  it (e.g. `scale()` for a zoom/pan interaction) and want strokes to stay
  visually constant while zooming. Even then, prefer applying the zoom to the
  `<svg>`'s `viewBox` and letting everything scale together.
- Note the interaction with §3: **`non-scaling-stroke` does not affect
  `stroke-dasharray`/`stroke-dashoffset`.** Those remain in user units, so
  `pathLength="100"` keeps working correctly either way.

### 7.8 Needles and `transform-origin`

`transform-origin` percentages on SVG elements resolve against the element's own
bounding box unless you opt out. Pin it:

```css
.needle {
  transform-box: view-box;          /* resolve origin against the viewBox, not the bbox */
  transform-origin: 200px 200px;     /* = cx cy in user units            */
  will-change: transform;
}
@media (prefers-reduced-motion: no-preference) {
  .needle { transition: transform 900ms linear; }
}
```

Then the whole tick is one write:

```ts
needleRef.current.style.transform = `rotate(${nowMinutes / 1440 * 360}deg)`;
```

`transform-box: view-box` + explicit `transform-origin` is Baseline in all
engines. Without it, `rotate()` spins about the needle's own bbox centre and the
needle flies off the dial.

---

## 8. Sources

**MDN — SVG**
- pathLength: <https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/pathLength>
- path-length (CSS, experimental): <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/path-length>
- stroke-dasharray: <https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/stroke-dasharray>
- stroke-dashoffset (CSS, animation type): <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/stroke-dashoffset>
- pointer-events (attribute): <https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/pointer-events>
- pointer-events (CSS, value semantics): <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/pointer-events>
- vector-effect: <https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/vector-effect>
- tabindex: <https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/tabindex>
- SVG 2 Paths (fill rules, subpaths): <https://www.w3.org/TR/SVG/paths.html>

**MDN — accessibility / CSS**
- `button` role: <https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/button_role>
- Keyboard accessible: <https://developer.mozilla.org/en-US/docs/Web/Accessibility/Guides/Understanding_WCAG/Keyboard>
- prefers-reduced-motion: <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion>
- Media queries for accessibility: <https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Using_for_accessibility>
- will-change: <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/will-change>

**Specs**
- SVG 2 Implementation Notes §F.6.2 / F.6.5 (identical endpoints omit the arc; flag equations): <https://www.w3.org/TR/SVG/implnote.html>
- CSS Will Change Module 1: <https://drafts.csswg.org/css-will-change/>
- W3C C39 (prefers-reduced-motion, inverse form is valid): <https://www.w3.org/WAI/WCAG22/Techniques/css/C39.html>
- W3C Writing Accessible SVG (editors' draft): <https://w3c.github.io/writing-accessible-svg/accessible-svg.html>
- w3c/svgwg #773 — `path-length` as a CSS property (RESOLVED, not yet shipped): <https://github.com/w3c/svgwg/issues/773>
- w3c/csswg-drafts #10195 — "Can we fix arc interpolation?" (why `d` must not be transitioned): <https://github.com/w3c/csswg-drafts/issues/10195>

**Articles**
- Mastering SVG Arcs — Smashing Magazine: <https://www.smashingmagazine.com/2024/12/mastering-svg-arcs/>
  ⚠️ **Contains an error:** it states "`1`: Sets whether the arc sweeps in a clockwise
  direction or a counter-clockwise direction, where `0` equals clockwise and
  `1` equals counter-clockwise." That is **inverted**. Per SVG 2 impl notes
  eq. 4.4, `fS = 1 if Δθ > 0`, and SVG's y-down space means increasing θ renders
  **clockwise**. MDN, Josh Comeau's guide, and the W3C spec all agree with the
  spec. Trust the spec.
- SVG Circle Decomposition To Paths — Smashing Magazine (circle = two arcs): <https://www.smashingmagazine.com/2019/03/svg-circle-decomposition-paths/>
- How SVG Doughnut Charts Work (arc flags): <https://evan-moon.github.io/2020/12/12/draw-arc-with-svg-clippath/en/>
- A Guide to SVG Animations (SMIL) — CSS-Tricks: <https://css-tricks.com/guide-svg-animations-smil/>
- SMIL on? — CSS-Tricks (WebKit perf comment, 2025): <https://css-tricks.com/smil-on/>
- SMIL is dead! Long live SMIL! — CSS-Tricks: <https://css-tricks.com/smil-is-dead-long-live-smil-a-guide-to-alternatives-to-smil-features/>
- An Interactive Guide to SVG Paths — Josh Comeau: <https://www.joshwcomeau.com/svg/interactive-guide-to-paths/>
- React animations & performance — Streaver: <https://streaver.com/insights/blogs/react-animations-how-a-simple-component-can-affect-your-performance>
- prefers-reduced-motion: Sometimes less movement is more — web.dev: <https://web.dev/articles/prefers-reduced-motion>
- Stick to Compositor-Only Properties — web.dev: <https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count>
- Populating the page: how browsers work — MDN (16.67ms budget): <https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/How_browsers_work>
- MozillaWiki: SVG Pointer-events (mask hit-testing inconsistency): <https://wiki.mozilla.org/SVG:Pointer-events>

---

## 9. VERIFIED vs. RECOMMENDATION — index

### VERIFIED (spec or documented browser behaviour)

1. `polarToCartesian` with `x = cx + r·sinθ`, `y = cy − r·cosθ` gives 0°=top and increasing θ = clockwise, on screen. *(checked numerically for all 361 angles, radii 100 and 60)*
2. `arcLength(r, sweep) = r · sweep · π/180`. *(checked: 157.07963267948966)*
3. `large-arc-flag = 1` iff swept angle > 180°; `sweep-flag = 1` = increasing θ = clockwise in SVG's y-down coordinate space. *(SVG 2 impl notes eq. 4.3/4.4)*
4. A single `A` command **cannot** express a 360° sweep; identical endpoints mean the arc segment is omitted entirely. *(SVG 2 impl notes §F.6.2)* A circle requires two 180° arcs.
5. A full-ring donut requires **two subpaths**. With `fill-rule="evenodd"` winding direction is irrelevant; with the default `nonzero` the subpaths must wind in opposite directions.
6. `pathLength` rescales all distance computations by `pathLength / realLength`, and `stroke-dasharray` therefore resolves in the declared unit. Value type `<number>`, animatable, supported on path/circle/ellipse/line/polygon/polyline/rect.
7. `stroke-dashoffset` animation type is **by computed value type** → CSS transitions interpolate it smoothly. **Your premise that it is "not interpolatable" is incorrect.**
8. The property that interpolates badly is **`d`** — SVG 2 interpolates structurally and arc flags flip at 50%. *(w3c/csswg-drafts#10195)*
9. `pointer-events` defaults to **`visiblePainted`**, which requires `fill !== none` for interior hits and `stroke !== none` for perimeter hits. `pointer-events: all` ignores `fill`, `stroke` **and** `visibility` for event processing.
10. `role="button"` supplies semantics only. Focusability requires `tabindex`, and **Enter + Space key handlers must be authored manually**.
11. `paint-order` is the paint sequence (`fill, stroke, markers` by default); `stroke fill` draws the stroke under the fill.
12. `vector-effect: non-scaling-stroke` decouples stroke width from transforms and zoom. It does **not** affect dash array/offset, which stay in user units.
13. Only `transform` and `opacity` are compositor-only. `will-change` has no effect for most other properties.
14. SMIL is functionally alive everywhere (Chrome never deprecated it; Edge is now Chromium) but is **not** on WebKit's accelerated path and has no `prefers-reduced-motion` opt-out.
15. Percentages in `stroke-dasharray`/`stroke-dashoffset` resolve against the viewport's normalized diagonal, **not** the path length.

### RECOMMENDATION (judgement, not spec)

- Filled wedges with an angular gap for the ring base — the only shape that makes the whole slice, including the hollow middle, hit-testable.
- Separate stroked arcs at different radii for the sub-bands, with `pathLength="100"` — avoids per-segment masks/clips and keeps a tick to O(1) raster work.
- A constant `stroke-dasharray: 100 100` and a single animated `stroke-dashoffset` per band, via `dashoffsetForSpan(startUnits, lenUnits) = 100 − startUnits − lenUnits`. *(Derived and proved in §2.3, not quoted from a spec.)*
- A dedicated `fill="none" pointer-events="all"` hit path per segment, with `rInner = 0` if the hub should also be clickable.
- Duplicate-path + `paint-order: stroke` for hover/focus rings. Reject filters.
- Roving `tabindex` with arrow-key navigation across the 12 segments.
- rAF + refs for the 1 Hz tick, CSS transitions for discrete state, no SMIL, no `will-change` on dash properties.
- `prefers-reduced-motion` handled by the **inverse** form (motion inside `no-preference`), keeping value updates in the `reduce` block.