# Direction: آنتن (iRegister)

Second revision. The first pass stripped the interface to flat surfaces under the anti-slop rules;
this pass adds a lit glass material on top of that skeleton, because the product is about signal and
a pane that catches light is a better metaphor than a flat card. Every line below is the one-line
reason R-31 asks for. If a reason cannot be written in one line, the decision does not belong here.

## Product read

A phone tool used in a hurry, often on a bad connection, by someone who is about to hand the phone to
a carrier clerk. It is an instrument, not a landing page. That read survives the restyle: the glass is
material, not decoration, and nothing moves unless the app is actually doing something.

## Dials (R-37)

| Dial | Value | Why |
|---|---|---|
| ENERGY | 2 (held) | The glass needs a lit field behind it to read as glass, so the page carries two soft colour pools. They are still, never animated. |
| RHYTHM | 2 (functional) | Two densities only: the choice grid and the reading column. Variation is structural, not decorative. |
| MOTION | 2 (state only) | Three motions exist: a sweep across the primary action while it runs, one pass of light along the sheet edge when a file is ready, and 150ms colour transitions. All report state, all stop. |

## Material: liquid glass

- The field: a fixed layer with four radial pools (teal upper right, indigo upper left, teal right
  middle, teal lower edge) at 26 to 50 percent, over a near-black base. Static, no animation, no orbs
  as objects. Its only job is to give the glass something to tranmsit.
- The panes: translucent white (5.5 percent on dark, 72 percent on light) with a 1px hairline and an
  inset 1px specular on the top edge, which is what makes an edge read as glass rather than as a border.
- Real blur is spent only where a pane sits over moving content: the header, the tab bar, the sheet,
  the two-level menu and the toast. Cards do not blur, because eight blurred cards is soup and costs
  fill rate on the phone that matters.
- Radius scale follows the material: 14 for cards and menus, 12 for controls, 22 for the sheet.
- One grain layer at 3 percent over the field kills banding on an OLED screen without being visible
  as texture.

## Palette (R-01, R-29)

Two neutrals plus one accent.

- Base `#0c0e10`: a near-black with no blue cast, so the field tints stay the only chromatic event.
- Accent `#3dbccd`: one cyan, chosen because the product is about signal, and because it holds 4.5:1
  on the field and on its own button label.
- Status colours: green `#4fbf8b` for success only, red `#e8756f` for error only. Never decorative.

The accent still marks exactly two things: the selected carrier and the single primary action.

## Typography (R-06)

Vazirmatn, because the interface is Persian and Persian shapes at 11px need a typeface drawn for them.
Self-hosted as one variable file (`public/fonts/Vazirmatn.woff2`, 100 to 900), so the UI renders in
the intended typeface with no third-party request, and the service worker keeps it offline.

Every text surface uses it, including values that used to be monospace: APN, UUID, the XML preview.
preview. Persian users read Latin identifiers inside Persian sentences, and a second typeface broke
the rhythm more than it clarified the value. Hierarchy is carried by size, weight and colour instead.

Type scale: 20 (product name), 14 (control labels), 12.5 (body), 10.5 to 11.5 (metadata).

## Layout (R-05, R-14)

Sections are separated by hairline labels, not by floating cards, because eight carrier choices are a
list, not eight features pretending to be distinct.

The primary action sits above the tab bar on a glass shelf: same pane, same hairline, so the button
belongs to the bottom of the screen instead of looking like a strip cut out of the field.

## Menus (R-10, R-33)

A native `<select>` popup is drawn by the operating system: system font, system highlight blue, and
the system light theme even when this app is dark. It leaves the surface the user is looking at. The
three option fields therefore use a listbox the app draws: same material as the rest of the shell,
44px rows, keyboard rules from the ARIA combobox pattern, and an upward flip when the menu would
otherwise leave the viewport.

## States (R-27)

- Empty: history shows a labelled empty state, not a blank column.
- Recovery: when history is not empty, the build screen leads with the last profile, its operator, and how old it is, plus one button that mints a fresh one. The age is a fact from the ledger of local history, never an estimate sold as a countdown.
- Guard: a single switch that keeps a fresh file in hand. When it is on, the recovery block becomes a ready card with one accent button, so the drop costs a confirmation instead of a wait. The switch is 44px tall by 26 wide, the knob is the only thing that moves.
- Cloud guard: a quiet row under the switch that starts the MDM enrollment. It is a row, not a card, because it is the same job done better; the label says what changes for the user (no taps, device becomes managed).
- Busy: the primary action shows «در حال ساخت…» with the sweep while the request runs, and the sheet explains the install steps when the file is ready.
- Link down: three failed watch pings put a labelled banner above the recovery card, because the moment the link dies is the moment the recovery action matters. It is text, not a red alert, since a dead link often means the antenna is already gone.
- Error: a failed build falls back to the local profile builder and says so in a toast, so the screen never dies on a network error.

## Themes (R-21, R-34)

Both themes are built from the same token set and both were captured and checked. Light is not an
inverted dark: the field becomes pastel, panes become white at 72 percent, hairlines become a soft
grey, and the accent darkens to hold contrast.

## Motion (R-19)

A light sweep across the button while the profile request is in flight, a single 1.15s pass along the
sheet's top edge when a file is actually ready, and 150ms transitions on colour and border. Nothing
loops outside its state, nothing plays under `prefers-reduced-motion`, and nothing moves on a screen
the user is only reading.

## What changed in the glass pass

| Was | Now | Why |
|---|---|---|
| Flat opaque surfaces | Translucent panes with a specular edge | Glass is the material the product earns: signal, light, edge |
| No background | Four static colour pools plus 3 percent grain | Glass needs something behind it or it is just grey |
| 10 / 8 px radii | 14 / 12 / 22 px radii | Softer corners read as a moulded pane, not a table |
| Underlined segmented tabs | Glass capsule with a lifted active pane | The selection is an object, so it should look like one |
| 2px bar under the active tab | Lit capsule behind the tab icon | Marks the target, not the edge |
| Dimmed sheet backdrop | Light dim only, no blur | A heavy blur turned the page into mush and cost fill rate |

## What stayed removed

| Removed | Rule |
|---|---|
| Animated gradient orbs, grid, dot patterns | R-07 |
| Neon glow as decoration, glow on text and icons | R-13 |
| Pill everything: every badge, chip and bar a capsule | R-11 |
| Check glyphs and arrow glyphs used as decoration | R-04, R-08 |
| Em dashes in copy | R-02 |
| Fake status dots and dotted separators | R-09 |
| Glass on every card | Eight blurred cards is soup, and it costs the phone |
