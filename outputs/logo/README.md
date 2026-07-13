# SDL — Symbol Delta Ledger — Logo

## Concept

One shape encodes all three words of the name:

- **Ledger** — four horizontal rows, stacked like records. Even rhythm: bar height equals gap (18/18 units), the cadence of an append-only log.
- **Delta** — the rows taper upward, so the silhouette is Δ, the universal glyph for change.
- **Symbol** — the apex resolves to a single accent-colored node: one symbol at the top of the graph, the atomic unit SDL tracks.

Secondary read: a beam-search frontier narrowing to a single entry symbol — the token-economy story (broad codebase in, minimal context out).

## Values expressed

- **Precision** — pure geometry, one stroke weight, strict symmetry.
- **Token thrift** — the mark is 5 primitives (4 lines + 1 circle). No gradients, no filters.
- **Determinism** — identical at any scale; monochrome-safe; single accent color.

## Audience

Engineers and AI-agent tooling users. The mark works where they see it: GitHub avatar, npm page, terminal favicon, README hero, MCP client tool icons. Legible at 16 px.

## Files

| File | Use |
|------|-----|
| `sdl-mark.svg` | Primary mark, light backgrounds (ink `#101826`, accent teal `#0D9488`) |
| `sdl-mark-dark.svg` | Mark for dark backgrounds (ink `#F8FAFC`, accent `#2DD4BF`) |
| `sdl-mark-mono.svg` | Single-color mark via `currentColor` — inherits text color, for docs/embeds |
| `sdl-icon.svg` | App icon / avatar — dark rounded square `#0B1220` |
| `sdl-lockup.svg` | Horizontal lockup: mark + hand-drawn stroke wordmark "SDL" (no font dependency, pure paths) |
| `sdl-lockup-dark.svg` | Lockup for dark backgrounds |
| `preview2.html` | Variant sheet (serve via `node outputs/logo/serve.mjs`, then http://127.0.0.1:4173/preview2.html) |

## Palette

| Role | Light bg | Dark bg |
|------|----------|---------|
| Ink | `#101826` (slate 950) | `#F8FAFC` (slate 50) |
| Accent (the symbol node) | `#0D9488` (teal 600) | `#2DD4BF` (teal 300) |
| Icon field | — | `#0B1220` |

Teal: signals live/indexed/verified in dev-tool idiom without colliding with git-diff red/green semantics used inside SDL's own delta output.

## Construction

- Grid: 256 × 256, content optically centered.
- Apex node: circle r = 11 at (128, 60).
- Rows: stroke 18, round caps, at y = 96 / 132 / 168 / 204; half-widths grow linearly (20.5 → 82) toward a base of 164 units.
- Clear space: keep one base-row-height (36 units) of padding on all sides.
- Minimum size: 16 px. Below that, use the accent node alone.

## Wordmark

Lockup letterforms are stroke-drawn paths (cap height ≈ 96, weight matched to the mark's bars) — geometric, rounded, no font license or embedding needed.

---

## v2 — Sheared Strata + Iris Gate (from user sketch, 2026-07-12)

Cleanup of hand sketch: strata delta with −6° shear (slice gaps ascend to the right — motion, versions advancing), optional central **iris gate** representing the Iris context ladder.

- **Strata** — 6 bands, 52 units thick, 22-unit gaps, rotated −6° about (256,300), clipped to Δ (apex 256,64; base 76/436 at y=448). Apex slice stays a clean detached triangle; base corners land inside the bottom band so the last gap exits through the right edge, as in the sketch.
- **Iris** — three nested levels rotating counterclockwise (same direction as the shear): Δ outline (stroke 9) → Δ outline rotated −14°, scaled 0.58 (stroke 8) → solid ∇ kernel. Reads as an aperture stepping down — card → skeleton → hot path → the kernel is the gated window. Knockout margin via even-odd clip (halo triangle R116 about centroid 256,318), so the mark stays transparent-background safe.

| File | Use |
|------|-----|
| `sdl-mark-v2.svg` | Sheared strata, no iris — favicons/small sizes (light) |
| `sdl-mark-v2-dark.svg` | Same, dark backgrounds |
| `sdl-mark-v2-iris.svg` | With iris gate — hero/README use, ≥96 px (light) |
| `sdl-mark-v2-iris-dark.svg` | Same, dark backgrounds |
| `preview3.html` | v2 variant sheet incl. teal-apex and teal-iris accent options |

Guidance: below ~64 px the iris muddies — use the no-iris cut. Teal accent variants (apex slice or iris strokes in `#0D9488`/`#2DD4BF`) shown in `preview3.html`.

---

## v3 — Strata Delta + Interlocked Triangle (from user sketch, 2026-07-12)

Vector cleanup of the second sketch: sheared strata Δ (unchanged from v2) with a centered **interlocked triangle** — a flat Penrose-style tribar — plus a solid Δ kernel.

- **Tribar construction** — ring between outer triangle (circumradius 100 about center 256,306) and hole triangle (circumradius 44) is tiled exactly into three trapezoid beams (width 28). Each beam wraps one corner and is flush-cut against the next beam's inner edge line — left beam wraps the apex (chirality taken from the sketch: apex chevron hangs to the right). No overlaps, no gaps; the weave illusion comes purely from the cut placement.
- **Kernel** — small solid Δ at the hole centroid: the symbol at the center of the gate.
- **Knockout** — even-odd clip halo (circumradius 124), transparency-safe.
- Meaning: strata ledger + delta silhouette; interlocked beams = symbols ↔ deltas ↔ ledger, mutually dependent graph; kernel = the one symbol the ladder resolves to.

| File | Use |
|------|-----|
| `sdl-mark-v3.svg` | Flat outline beams — primary (light) |
| `sdl-mark-v3-dark.svg` | Dark backgrounds |
| `sdl-mark-v3-gradient.svg` | Sketch-faithful metallic gradient beams (hero/marketing) |
| `render-v3-*.png` | Raster proofs |
| `preview4.html` | v3 variant sheet |

Guidance: v3 holds down to ~48 px; below that use `sdl-mark-v2.svg` (no center motif).

---

## v4 — Faithful vectorization of user sketch (2026-07-12, final direction)

Exact cleanup of the hand-drawn logo (not a redesign). Differences from v2/v3 that match the source image:

- Cut grid rotated **+7°** (gaps descend to the right — v2/v3 had it backwards).
- Large solid apex cap (~61 units), 5 thin gaps (13 units), slabs 50 units, wide bottom slab passing fully beneath the motif (thick left, sliver right).
- Main Δ uses the sketch's proportions: apex (256,62), base (71,421)–(441,421), edge slope ≈1.94 (taller than equilateral).
- Tribar built with the same 1.94 aspect (similar to the outer Δ): outer apex (256,197), base y=365, hole scaled 0.15 about centroid (256,309) — fat beams, small hole.
- **Center hole is empty** — no kernel, no slab visible through it (halo knockout covers the full motif area; even-odd clip keeps transparency).
- White beams, thin ink outlines (stroke 5, miter joints), per-beam metallic gradients matching the sketch's shading directions.

| File | Use |
|------|-----|
| `sdl-mark-v4.svg` | Faithful mark, light backgrounds |
| `sdl-mark-v4-dark.svg` | Dark backgrounds (white strata/outlines, same gradients) |
| `render-v4.png`, `render-v4-sheet.png` | Raster proofs |
| `preview5.html` | v4 sheet |
