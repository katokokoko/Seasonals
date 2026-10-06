# Water background judge (fixed prompt)

この文面は採点のたびに **そのまま** 採点 subagent に渡す (iteration ごとに書き換えない。書き換えると点がぶれる)。
採点者は毎回 fresh な Opus で、Read だけを使い、diff や前回の点は見ない。

改訂 (2026-10-05、iter 11 から): ユーザーの指定で、浅い所の砂の色を「砂色の beige」から「淡い vanilla cream」(`water-vanilla-ref.png` の上端の色) に変えた。色の参照画像を 1 枚足し、depth & colour 軸の文言をそれに合わせた。それ以外は変えていない。iter 10 までの点とは depth の基準が少し違う。

---

You are judging the animated water background of a web app against a reference photo. Read every image path given below with the Read tool before scoring. Do not read any other file, do not run commands, and do not edit anything.

## What you are looking at

- **Reference** (`docs/web/reference/water-ref.png`): a photo looking **straight down** at shallow, clear water over pale sand. It is **not** a picture of lens-shaped bulges or blobs. What makes it look like real water:
  - the sand bottom is clearly visible through the clear water, with fine grain and small specks; there is no milky film;
  - a network of bright white to cream light lines (caustics) lies on the sand. The lines vary in width and have a crisp core with a soft glow. They form irregular, rounded cells that are stretched and flowing in one direction. The sand inside the cells is darker than the lines (the light is focused into the lines), and the crossings of lines are the brightest;
  - the moving water surface wobbles the whole view of the bottom, shows thin flowing bright strands where its ripples catch the light, and has sparse small star-like sparkles;
  - the colour changes with depth: mint to teal where it is deeper, pale sand where it is shallow, and slightly deeper aqua between the cells; no grey, muddy or neon tones;
  - tiny sparse bubbles or specks.
- **Colour reference for the shallow sand** (`docs/web/reference/water-vanilla-ref.png`): a UI mock of the same app. Use it **only** for one colour: the soft, warm, very pale vanilla cream of its top background band. The app's shallow sand should be that vanilla cream (not the photo's grey-beige). Ignore everything else in this image.
- **App images** (the only things you score are the water itself):
  - `artifacts/seasonals-web/.screenshots/water-only-1440.png`: the water shader rendered alone, with no UI. Judge material quality mainly from this and the crop.
  - `artifacts/seasonals-web/.screenshots/water-crop.png`: a 1:1 crop from the middle of water-only.
  - `artifacts/seasonals-web/.screenshots/water-home-1440.png`: the Home screen. Under and around the UI cards and the calendar the water is intentionally calmer ("quiet zones") so that text stays readable. Use this image to judge harmony: the calm areas should still read as the same clear water (not flat paint), and the UI must stay readable. Ignore the UI itself and the two cartoon characters.
  - `artifacts/seasonals-web/.screenshots/water-calendar-1440.png`: a work screen; its water should be calm and quiet behind the content.

## Rubric (score each 1 to 5; 4 means "close to the reference's quality", 5 means "indistinguishable in quality")

1. **clarity**: the sand bottom, its grain and specks are clearly visible through clear water; the water is not a milky film or a single flat colour. 3 = a tinted surface with little sense of a bottom; 5 = reads like the reference's clear water over sand.
2. **caustics**: bright white to cream light lines form an irregular network of rounded cells on the sand; line width varies; crisp core plus soft glow; the cells' interiors are darker than the lines; crossings are brightest; cells look stretched / flowing rather than like cracked tiles or a uniform grid. 3 = thin uniform lines, or cells that look like tiles or stained glass; 5 = like the reference.
3. **surface**: it feels like looking down through a moving rippled surface: the bottom is wobbled, thin flowing bright strands from the surface ripples, sparse small star-like sparkles. 3 = no sense of a surface between the viewer and the bottom; 5 = like the reference.
4. **depth & colour**: colour varies with depth (mint / teal deeper, pale vanilla-cream sand where shallow, slightly deeper aqua between cells); natural contrast; no grey, muddy, washed-out or neon tones. 3 = one flat pastel colour, grey-beige shallows, or too washed out; 5 = like the reference (with vanilla shallows).
5. **harmony**: on Home the calm areas still read as the same clear water and the UI stays readable; the work screen stays quiet; the whole is not noisy or busy; no rendering artifacts (banding, seams, tiling, aliasing, cartoonish shapes). 5 = feels native and polished.

## Output

Return **only** this JSON (no prose before or after):

```json
{"scores":{"clarity":0,"caustics":0,"surface":0,"depth":0,"harmony":0},"pass":false,"top_fix":"one sentence: the single change that would raise the lowest score the most, in concrete visual terms","notes":{"clarity":"one sentence on how it differs from the reference","caustics":"…","surface":"…","depth":"…","harmony":"…"}}
```

`pass` is true only if every score is 4 or higher. Be strict and calibrated: do not give 4 unless the water is genuinely close to the reference's quality on that axis.
