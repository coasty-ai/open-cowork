# open-cowork Design System

> Single source of truth for the open-cowork design system across web (`apps/web`), the desktop webview (`apps/desktop`), and mobile (`apps/mobile`). This document is normative: when code and this doc disagree, the doc wins (or the doc is updated by decision, not drift).
>
> **Phase scope.** This spec defines the **foundation** (tokens, scales, role vocabulary, contracts). It does *not* refactor app screens — that is Phase 3. Honoring it on day one requires **zero** changes to existing `oc-*` rules because every legacy `--color-*` name survives as an alias (see §2.4).

---

## 1. Principles

1. **Dark-first.** Dark is the product identity and the default (`:root` = dark, `color-scheme: dark`). Light is a *first-class peer* under `[data-theme='light']`, not an afterthought — both themes pass WCAG AA for text and UI. (shadcn ships light as `:root`; we deliberately invert this. It is our one intentional deviation from shadcn's posture.)
2. **Borders over heavy shadows.** Surfaces are separated primarily by 1px borders plus surface-color steps. Elevation (shadow) is *additive and subtle*, introduced only where a surface genuinely floats (modal, popover) — never as the sole boundary signal.
3. **Black-and-white monochrome.** The whole neutral ramp is *pure grayscale* (R=G=B — no blue/slate tint): near-black `#0a0a0a` → near-white `#fafafa`. The primary accent is neutral too — near-white on dark (a white primary button / focus ring / active rail) and near-black on light (a black primary button). Saturated color is reserved *exclusively* for semantic status — **success (green), warning (amber), destructive (red)**; even `info` is neutral. Nothing in the chrome carries hue. (The legacy `--color-accent` alias points at `--primary`, so existing rules pick up the monochrome accent automatically.)
4. **One type hierarchy.** A single typographic ladder (`--font-size-xs..3xl`) with paired line-heights, four weights, and named heading presets (`h1..h4`, `body`, `caption`) drives every surface. No per-page magic font sizes; no one-off weights.
5. **Single token source.** One platform-neutral package (`@open-cowork/tokens`, plain JS hex/numbers) is the origin. `tokens.css` (web custom properties) and `theme.ts` (RN object) are both *generated* from it and guarded by a parity test, so they cannot drift. Anything CSS-only (`color-mix`, `calc`, `rem`, `:focus-visible`) is composed *per platform* from shared plain inputs — never shared as a CSS string.

---

## 2. Color tokens

shadcn-style **role pairs**: a `*-foreground` token is the text/icon color that sits *on* the matching surface. All values are **plain hex** (RN-shareable) unless flagged CSS-only. Contrast figures use the WCAG 2.x relative-luminance formula and have been independently verified by the critique panels; the values below are the *corrected* set (several originally-proposed light status hues failed AA and were darkened).

### 2.1 Dark palette (the `:root` default)

| Role token | Hex | Notes / verified contrast |
|---|---|---|
| `--background` | `#0a0a0a` | pure-neutral near-black (no blue tint) |
| `--foreground` | `#fafafa` | ~19:1 on bg (AAA) |
| `--card` | `#161616` | primary surface |
| `--card-foreground` | `#fafafa` | AAA |
| `--popover` | `#1c1c1c` | dialogs/menus sit one step above card |
| `--popover-foreground` | `#fafafa` | AAA |
| `--muted` | `#1f1f1f` | raised fill |
| `--muted-foreground` | `#a3a3a3` | ~7.9:1 on bg (AA) — captions/hints |
| `--secondary` | `#272727` | secondary button fill |
| `--secondary-foreground` | `#fafafa` | AAA |
| `--accent` | `#272727` | neutral hover/selected wash |
| `--accent-foreground` | `#fafafa` | AAA |
| `--border` | `#2e2e2e` | 1px separators (decorative; exempt from 3:1) |
| `--input` | `#404040` | stronger control border — the field affordance |
| `--ring` | `#fafafa` | focus ring = primary; near-white, ~19:1 on bg |
| `--primary` | `#fafafa` | **monochrome accent** — near-white (a white primary button on dark) |
| `--primary-foreground` | `#0a0a0a` | ink on the white primary — ~19:1 (AAA) |
| `--destructive` | `#d83a3f` | **solid-fill** danger (buttons/banners) |
| `--destructive-foreground` | `#ffffff` | 4.57:1 on the red fill (AA-normal) |
| `--destructive-text` | `#ff7070` | danger used **as text/border/dot** on bg (AAA) |
| `--success` | `#4ade80` | as text (AAA) |
| `--success-foreground` | `#06140c` | ink for solid success chips |
| `--warning` | `#f5b83d` | as text (AAA) |
| `--warning-foreground` | `#1a1300` | ink for solid warning banner/badge |
| `--info` | `#fafafa` | **neutral, not blue** — "Running" reads via its label + pulse |
| `--info-foreground` | `#0a0a0a` | ink for any solid info surface |

### 2.2 Light palette (`[data-theme='light']`)

| Role token | Hex | Notes / verified contrast |
|---|---|---|
| `--background` | `#fafafa` | pure-neutral near-white (no blue tint) |
| `--foreground` | `#0a0a0a` | ~19:1 on bg (AAA) |
| `--card` | `#ffffff` | |
| `--card-foreground` | `#0a0a0a` | AAA |
| `--popover` | `#ffffff` | |
| `--popover-foreground` | `#0a0a0a` | AAA |
| `--muted` | `#f4f4f4` | |
| `--muted-foreground` | `#555555` | ~7:1 on bg/muted (AA) |
| `--secondary` | `#f4f4f4` | |
| `--secondary-foreground` | `#0a0a0a` | AAA |
| `--accent` | `#f4f4f4` | neutral hover wash |
| `--accent-foreground` | `#0a0a0a` | AAA |
| `--border` | `#e4e4e4` | |
| `--input` | `#cacaca` | stronger field border |
| `--ring` | `#0a0a0a` | focus ring = primary; near-black, ~19:1 on bg |
| `--primary` | `#0a0a0a` | **monochrome accent** — near-black (a black primary button on light) |
| `--primary-foreground` | `#fafafa` | white on the near-black primary — ~19:1 (AAA) |
| `--destructive` | `#c5303a` | solid-fill danger |
| `--destructive-foreground` | `#ffffff` | AA on fill |
| `--destructive-text` | `#c5303a` | as text on bg (AA) |
| `--success` | `#0f7a4f` | as text (AA) |
| `--success-foreground` | `#ffffff` | |
| `--warning` | `#8a5a00` | as text (AA) |
| `--warning-foreground` | `#ffffff` | |
| `--info` | `#0a0a0a` | **neutral, not blue** |
| `--info-foreground` | `#ffffff` | |

> **Status hues on light surfaces:** badges render on `--muted` (`#f4f4f4`). The light `--success` `#0f7a4f` / `--warning` `#8a5a00` are deliberately dark so they clear AA-normal (4.5:1) on both `--muted` and `--background` — lighter greens/ambers fail there.

### 2.3 The monochrome accent (exact value + contrast notes)

The accent is neutral, not blue. In dark mode it is near-white (so the primary
button, focus ring, active sidebar rail, tab underline, and spinner all read as
white); in light mode it is near-black (a black primary button). This is the
classic black-and-white shadcn look.

| | Dark | Light |
|---|---|---|
| `--primary` / `--ring` | **`#fafafa`** (near-white) | **`#0a0a0a`** (near-black) |
| Foreground on the solid fill | `#0a0a0a` (ink) | `#fafafa` (white) |
| Foreground-on-fill contrast | **~16:1 (AAA)** | **~15:1 (AAA)** |
| Ring-on-background contrast | **~16:1** | **~15:1** (both ≫ the 3:1 non-text minimum) |

Because the accent equals the foreground neutral, primary actions get maximum
contrast (and the dark primary keeps its ink foreground — white-on-white would
be invisible). Hue is reserved for status only, so nothing competes with the
black-and-white chrome.

### 2.4 Migration: current `--color-*` → new role token (lossless aliases)

The **role tokens are the source**; the legacy names are thin aliases defined in `:root` (re-themed at `:root` only — never on a nested element). **No existing `oc-*` rule needed to change:** they read `--color-*`, which now resolve to the pure-grayscale neutral ramp + the monochrome accent.

```css
/* legacy alias  ->  new role token */
--color-bg:              var(--background);
--color-surface:         var(--card);
--color-surface-raised:  var(--muted);
--color-border:          var(--border);
--color-text:            var(--foreground);
--color-text-muted:      var(--muted-foreground);
--color-accent:          var(--primary);          /* the monochrome accent */
--color-accent-contrast: var(--primary-foreground);
--color-success:         var(--success);
--color-warning:         var(--warning);
--color-danger:          var(--destructive-text);  /* see note ↓ */
--color-info:            var(--info);
--focus-ring-color:      var(--ring);
```

| Current name | New role token (alias) | Notes |
|---|---|---|
| `--color-bg` | `--background` | pure-neutral `#0a0a0a` (dark) / `#fafafa` (light) |
| `--color-surface` | `--card` | pure-neutral `#161616` (dark) / `#ffffff` (light) |
| `--color-surface-raised` | `--muted` (also `--secondary`/`--accent`) | one tone, three roles |
| `--color-border` | `--border` | new sibling `--input` for field affordance |
| `--color-text` | `--foreground` | |
| `--color-text-muted` | `--muted-foreground` | |
| `--color-accent` | `--primary` | **now monochrome** — neutral white (dark) / black (light), not blue |
| `--color-accent-contrast` | `--primary-foreground` | now correctly INK in dark |
| `--color-success` | `--success` | light value darkened (AA) |
| `--color-warning` | `--warning` | light value darkened (AA) |
| `--color-danger` | `--destructive-text` | **deliberate:** `styles.css` uses danger predominantly as *text/border/dot* (`oc-field__error`, `oc-error-state__message`, step-tree dots, badge borders), so the alias maps to the text-grade red. The *fill* usages migrate explicitly — see below. |
| `--color-info` | `--info` | |
| `--focus-ring-color` | `--ring` | one-line change |

**The one behavioral fix this delivers (the destructive fill/text split).** A single `--destructive` cannot pass AA both as white-on-red *fill* and as red *text on bg*. We therefore split the role: `--destructive` (solid fill + `--destructive-foreground`) vs `--destructive-text` (red as text/border). The fill usages — `.oc-button--danger`, `.oc-offline-banner`, `.oc-screen-view__live`, `.oc-screen-view__stale` — should migrate from the overloaded `--color-accent-contrast` on-color to the proper `--destructive`/`--warning` fill + `--destructive-foreground`/`--warning-foreground`. They render correctly today by luck (ink on red ≈ 6.8); the migration makes correctness explicit and AA-guaranteed. This is *opportunistic* (Phase 3 per-rule), not required day one.

> **Naming clash resolved:** shadcn's `--accent` is the *neutral hover tint*, not the brand. The brand blue moves to `--primary`, `--accent` becomes the neutral wash, and the legacy `--color-accent` alias points at `--primary` so existing CSS is unaffected.

---

## 3. Typography scale

A single ladder, **canonical shadcn `xs..3xl` naming**, expressed in `rem` (browser-scalable) with px equivalents + paired line-heights for the RN mirror. **Base body stays 14px** — this matches the current product (`--color-text` body, field labels, descriptions all 14px today) and deliberately avoids a global type-size bump. Heading presets are composite objects (`size, lineHeight, weight, letterSpacing`) so the same shape mirrors 1:1 into `theme.ts`. Font families are unchanged.

### 3.1 Size ladder

| Token | rem | px | Line-height token | Absorbs (current literals) |
|---|---|---|---|---|
| `--font-size-2xs` | 0.6875rem | 11 | `--lh-snug` | `0.6875rem` live/stale chips |
| `--font-size-xs`† | 0.75rem | 12 | `--lh-snug` | badges, cost-pill, timeline-at, step-type, copy btn |
| `--font-size-sm` | 0.8125rem | 13 | `--lh-normal` | hints, errors, codeblock, machine-meta |
| `--font-size-base` | 0.875rem | 14 | `--lh-normal` | **default body**, field labels, descriptions |
| `--font-size-md` | 0.9375rem | 15 | `--lh-normal` | button-md |
| `--font-size-lg` | 1rem | 16 | `--lh-snug` | card title, empty-state title |
| `--font-size-xl` | 1.125rem | 18 | `--lh-snug` | modal title, wallet stat dd boundary |
| `--font-size-2xl` | 1.3125rem | 21 | `--lh-tight` | replaces magic `1.3rem` `.page-title` (h2) |
| `--font-size-3xl` | 1.625rem | 26 | `--lh-tight` | new page hero (h1) |

† `--font-size-xs` (12px) absorbs the existing 12px usages (badges, pills) without rounding them up to 13px and visibly enlarging every badge; `--font-size-2xs` (11px, the smaller rung) covers the existing `0.6875rem` live/stale chips. This keeps the ladder a faithful superset of today's rendered sizes — no surface changes size in Phase 2.

### 3.2 Line-heights & weights

```css
--lh-tight:  1.25;   /* headings */
--lh-snug:   1.4;    /* sub-headings, dense rows, card/empty titles */
--lh-normal: 1.5;    /* body (matches today's body line-height) */

--font-weight-normal:   400;   /* body */
--font-weight-medium:   500;   /* tabs, de-emphasized labels */
--font-weight-semibold: 600;   /* the dominant weight: buttons, labels, card titles, badges */
--font-weight-bold:     700;   /* h1–h3, logo word, wallet figures */
```

The stray one-off weight `650` (`app.css`) and the mobile 500–800 spread collapse onto this 4-step set.

### 3.3 Heading hierarchy (the contract)

Defined as composite presets so "one hierarchy everywhere" is enforceable; in RN these become a `typography` object with identical keys.

| Level | size | weight | line-height | tracking | Replaces |
|---|---|---|---|---|---|
| **h1** (page hero) | `3xl` (26) | bold (700) | tight | `-0.02em` | overloaded `.page-title` h1 use |
| **h2** (page section) | `2xl` (21) | bold (700) | tight | `-0.015em` | `.page-title` h2 use, inline `1.3rem` |
| **h3** (subsection / modal title) | `xl` (18) | semibold (600) | snug | `-0.01em` | `.oc-modal__title` (1.125rem) |
| **h4** (card title) | `lg` (16) | semibold (600) | snug | `-0.005em` | the ~9 hand-set `<h2 style={{fontSize:'1rem'}}>`; = existing `.oc-card__title` |
| **body** | `base` (14) | normal (400) | normal | `0` | default text |
| **body-strong / label** | `base` (14) | semibold (600) | normal | `0` | field labels, composer label |
| **caption** | `sm` (13) | normal (400) | normal, color `--muted-foreground` | `0` | the copy-pasted `color:var(--color-text-muted)` caption pattern → one `.oc-caption` |
| **micro** | `xs` (12) | semibold (600) | snug | `0` | badges, pills, timeline-at |

---

## 4. Spacing scale

**Confirm the existing 4px numbered scale — no change.** It is already consistent and shadcn-aligned (the audit's cleanest area). The numbered scale is the **canonical source of truth**.

```css
--space-1: 0.25rem;  /* 4  */    --space-5: 1.25rem; /* 20 */
--space-2: 0.5rem;   /* 8  */    --space-6: 1.5rem;  /* 24 */
--space-3: 0.75rem;  /* 12 */    --space-7: 2rem;    /* 32 */
--space-4: 1rem;     /* 16 */    --space-8: 2.5rem;  /* 40 */
```

### Mobile reconciliation (named → numbered)

Mobile's `xs/sm/md/lg/xl` is a 5-step subset of the same 4px grid missing `space-5/7/8`. The shared source emits a **numeric `space` array `[4,8,12,16,20,24,32,40]`** as the truth; `theme.ts` re-exports the friendly named tiers as a thin lookup so existing RN `StyleSheet` code keeps working, and the missing rungs become available to RN for the first time.

| Mobile name | Current px | Canonical token | px |
|---|---|---|---|
| `xs` | 4 | `space[1]` | 4 |
| `sm` | 8 | `space[2]` | 8 |
| `md` | 12 | `space[3]` | 12 |
| `lg` | 16 | `space[4]` | 16 |
| `xl` | 24 | `space[6]` | 24 |
| *(new)* `xl2` | — | `space[7]` | 32 |
| *(new)* `xl3` | — | `space[8]` | 40 |

New RN code uses the numbered scale; named tiers are a compatibility shim. Sub-token literals (`2px`, `height:220`) stay raw — below the scale by design, out of tokenization scope.

---

## 5. Radii + elevation

### 5.1 Radii — single base + calc derivation

One tunable base; emitted values are byte-identical to today (`4/8/12/999`).

```css
--radius:      8px;                          /* single base — the only number to tune */
--radius-sm:   calc(var(--radius) - 4px);    /* 4px  */
--radius-md:   var(--radius);                /* 8px  */
--radius-lg:   calc(var(--radius) + 4px);    /* 12px */
--radius-full: 999px;                        /* pills, dots, logo ring */
```

RN cannot `calc()`, so the shared source emits **resolved integers** `{ sm:4, md:8, lg:12, full:999 }` *plus* `radiusBase: 8`; the parity guard checks the resolved integers. Documented component→radius rule: inputs/buttons/badges/code = `md`; cards/modals/popovers = `lg`; pills/dots/logo = `full`; small inline boxes = `sm`. (App callouts `.notice`/`.json-editor` move `md`→`lg` in Phase 3 to stop sitting tighter beside `oc-card`.)

### 5.2 Elevation — subtle, additive (the flat-modal fix)

Borders stay the primary boundary; shadows only add depth where a surface floats. Two-theme aware (dark needs deeper, lower-alpha; light reads harsher so lower alpha still).

```css
/* dark */
--shadow-sm:  0 1px 2px 0 rgb(0 0 0 / 0.40);                  /* cards, raised buttons (optional) */
--shadow-md:  0 4px 12px -2px rgb(0 0 0 / 0.45);              /* popovers, dropdowns */
--shadow-lg:  0 16px 40px -8px rgb(0 0 0 / 0.60);            /* modal/dialog — fixes flat overlay */
--shadow-ring: inset 0 0 0 1px color-mix(in srgb, currentColor 12%, transparent); /* logo ring, tokenized */
--overlay-scrim: rgb(0 0 0 / 0.66);                          /* modal backdrop (was hardcoded 60%) */

/* light */
[data-theme='light'] {
  --shadow-sm: 0 1px 2px 0 rgb(16 20 38 / 0.06), 0 1px 3px rgb(16 20 38 / 0.10);
  --shadow-md: 0 4px 12px -2px rgb(16 20 38 / 0.10);
  --shadow-lg: 0 16px 40px -8px rgb(16 20 38 / 0.18);
  --overlay-scrim: rgb(16 20 38 / 0.40);
}
```

Applied: `.oc-modal { box-shadow: var(--shadow-lg); }` (the one concrete visual upgrade), `.oc-modal-backdrop { background: var(--overlay-scrim); }`, `.oc-logo__mark { box-shadow: var(--shadow-ring); }`. `--shadow-sm` is defined but applied conservatively (cards may stay border-only to preserve the flat dark aesthetic; available for popovers/floating menus). The shadow *geometry* (offsets/blur/spread/alpha) is shared as structured data so RN can map it to native shadow props (§7).

### 5.3 Interaction states (replaces the global `filter:brightness` hack)

Per-role hover/active so contrast never drops below AA, and `Pressable` pressed-states map to the same resolved colors.

```css
/* dark / light */
--primary-hover:     #d4d8e2 / #2c3242   /* white dims on dark; black lifts on light */
--primary-active:    #c2c7d4 / #10131c
--secondary-hover:   #2a3349 / #e4e7ee
--destructive-hover: #e5484d / #b32a33
--disabled-opacity:  0.5                 /* + cursor:not-allowed; never recolor text */
--focus-ring-width:  2px;
--focus-ring-offset: 2px;
```

Hover is an explicit color swap (`transition: background-color/border-color`), not `filter:brightness(1.1)` — predictable contrast on every variant. Disabled = opacity + `not-allowed`, never a low-contrast gray.

---

## 6. Component variant vocabulary

Canonical variant/size/tone names the tokens must support so web and RN match 1:1 in *contract* (implementations stay platform-specific). Current names survive as **aliases** when renamed so nothing breaks.

- **Button**: `variant = primary | secondary | destructive | ghost | outline` × `size = sm | md`. Each maps to a `{bg, fg, border}` role triple. `outline` = transparent bg + `--border` + `--foreground`; `ghost` already exists. **`danger` → `destructive` is a DECISION**, shipped with a deprecation alias: `ButtonVariant` accepts both, `danger` is documented `@deprecated`, and `.oc-button--danger` stays as an alias selector of `.oc-button--destructive` so existing call sites (and RN `AppButton`) keep working until Phase 3 migrates them. **`destructive` means a SOLID FILL on both platforms** (fixes the web-solid vs mobile-outline divergence): fill `--destructive`, text `--destructive-foreground`.
- **Badge / status tone**: `tone = neutral | success | warning | info | destructive`. Each = solid `--{role}`/`--destructive-text` foreground + a tinted border (`tinted(role, 0.4)`); neutral = `--muted` bg + `--muted-foreground`. (`Badge` keeps `tone`; `RunStatusBadge` keeps its curated label map and pulse.)
- **CostPill**: `variant = estimate | actual` (unchanged).
- **Curated status labels** stay in shared TS (co-located in the token package) so mobile drops its raw `status.replace(/_/g,' ')` and matches web's `RUN_STATUS_META` labels.
- **`formatCents`** is promoted to the shared source — canonical impl `` `${cents < 0 ? '-' : ''}$${(Math.abs(cents)/100).toFixed(2)}` `` (already correct in `CostPill.tsx`) — so the mobile `theme.ts` copy (`$-0.05`) stops diverging from web (`-$0.05`).

> Note on `variant` vs `tone`: we keep both prop names (Button uses `variant`, Badge uses `tone`) as the established API; the *vocabulary of values* is what unifies. Renaming the prop itself is out of scope (would churn every call site for no token benefit).

---

## 7. RN-shareability rules

**One platform-neutral source** (`@open-cowork/tokens`, plain JS) emits to both `tokens.css` and `theme.ts`; a parity guard diffs them. The split:

### 7.1 SHARED — plain values, emitted identically to both
- **All role colors**, both themes — solid hex (every token in §2.1/§2.2, including `*-foreground` ink colors and `--destructive-text`). Mobile gains its first light palette here.
- **`--primary`/`--ring`** restrained hex; **interaction-state colors** (`primary-hover/active`, `secondary-hover`, `destructive-hover`) as hex; `disabled-opacity` as a number.
- **Spacing** — numeric array `[4,8,12,16,20,24,32,40]` + named tiers (`xs..xl3`).
- **Radii** — resolved integers `{sm:4, md:8, lg:12, full:999}` + `radiusBase:8`.
- **Typography** — size ladder as px numbers (CSS converts to `rem`), line-heights unitless, weights as numbers, tracking as numbers, font-family stacks as strings, and the named heading presets as `{size, lineHeight, weight, letterSpacing}` objects.
- **Tint/scrim/shadow inputs** — the tint percentages (`tint.border = 0.4`, `tint.fill = 0.08`), scrim base+alpha, and shadow geometry (`{x, y, blur, spread, color, alpha}` per step) as plain numbers/strings.
- **`formatCents`** util + the curated `RUN_STATUS_META` labels (co-located TS).

### 7.2 CSS-ONLY — never shared as literals; reproduced per platform from shared inputs

| CSS-only mechanism | Where | RN reproduction |
|---|---|---|
| `color-mix(in srgb, … 40%/8%, transparent)` — badge/error/approval borders & tints | `styles.css` badges, error-state, approval-bar | RN `tinted(role, alpha)` helper: shared solid hex + the shared `tint.border`/`tint.fill` constant → `rgba()`. **This also fixes the audit's "mobile solid fills vs web translucent tints" divergence** — both derive from one constant. |
| `--overlay-scrim` / shadow alphas | modal backdrop, `--shadow-*` | RN backdrop = `rgba()` from shared scrim base+alpha. Shadows → iOS `shadowColor/Opacity/Radius/Offset` + Android `elevation`, derived from the shared geometry; multi-layer `--shadow-lg` collapses to the dominant layer on RN. |
| `calc()` radii | radius derivation | RN consumes pre-resolved integers; `calc` is CSS-only sugar over the same base. |
| `--shadow-ring` (logo `currentColor` mix) | logo mark | RN `BrandLogo` paints the mark with an already-resolved color, so it computes the 12% ring directly — no `currentColor`. |
| `rem` units, `:root`/`[data-theme]` cascade, `:focus-visible` ring, `filter:brightness`, CSS aliasing | tokens.css/styles.css | No RN equivalent. `theme.ts` exports `themes.dark`/`themes.light` (no cascade); ring *color* is shared, focus *mechanism* is RN focus props; RN has no legacy aliases (it is new code consuming role tokens directly). |

### 7.3 Parity guard
A vitest test imports the source, the parsed `tokens.css`, and `theme.ts`, and asserts for **every shared key** that all three agree (hex equality for colors; numeric equality for spacing/radii/type) **and that both themes define the identical key set** (catches mobile's current missing light palette). CSS-only effects are excluded from byte-comparison but their **shared derivation inputs** (tint %, scrim alpha, shadow geometry) are asserted equal. As a defense against per-platform derivation drift, the guard also spot-checks one **resolved output** (e.g. the success-badge border `rgba` and the `--shadow-lg` mapped to RN props) to confirm each platform actually consumed the shared input at the same alpha.

---

## 8. Logo rule

- **Canonical mark:** `packages/ui/src/components/Logo.tsx` — the theme-aware `currentColor` "horizon" SVG. It fades transparent→`currentColor`, so on dark it renders white and on light it renders black with no asset swap. This is the single source for the brand mark.
- **Wordmark kept in chrome (decided).** The nav and login keep the mark **plus** the `open-cowork` wordmark (`Logo`'s `withWordmark` stays `true` by default). "Mark-only" means there is no separate wordmark *lockup asset*, and the bare circular mark is used where text doesn't fit (favicon, app icon, splash). The `.oc-logo__word` styles stay.
- **Orphans deleted:** `public/logo_light.svg` and `public/logo_dark.svg` (root `public/`, runtime-unreferenced, ambiguously named by target-background) are removed. The doc-comment reference in `Logo.tsx` ("the project's `logo_light.svg` / `logo_dark.svg`") is updated to stop pointing at deleted files.
- The inset logo ring is tokenized as `--shadow-ring` (§5.2) but remains a brand-mark detail, not a general elevation token.
