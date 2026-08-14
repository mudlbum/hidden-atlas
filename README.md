# Hidden Atlas 🧭

A daily-updated field guide to lesser-known places worth travelling for — bilingual (English / 한국어), static, and free to run.

**No API keys. No database. No dependencies.** A GitHub Action runs each morning, refreshes the data, commits it, and redeploys GitHub Pages.

---

## What's on the page

| Section | What it does |
| --- | --- |
| **Today's compass** | Three destinations chosen by a date-seeded rotation — different every day, deterministic so the page and the build agree. |
| **Right now** | Month-specific picks: places where *this* month is the reason to go, plus a value note about pricing that month. |
| **The atlas** | Every destination, filterable by region, trip type, budget, and how far off the radar it is. Optional world map. |
| **Field notes** | Practical layer — entry rules, money, flights, health, etiquette. High-impact notes are surfaced first and cite official sources. |
| **Worth the detour** | Regional dishes that don't travel. |
| **Live wire** | Auto-fetched each morning from Wikivoyage's own featured picks, Atlas Obscura, and independent travel writers. |

Also: language toggle (persisted), paper/night themes, save-for-later, `/` to search, and a print stylesheet.

---

## How the automation works

`.github/workflows/daily.yml` runs `scripts/update.mjs` at **05:20 UTC daily**, then deploys Pages.

The script:

1. **Enriches destinations** — pulls photos and summaries from the Wikipedia REST API, capped at 12 lookups per run and cached in `data/enriched.json`. The whole catalogue warms up over a few days and refreshes every ~4 months.
2. **Fetches live feeds** — Atlas Obscura, Nomadic Matt, The Broke Backpacker, Reddit r/solotravel, plus Wikivoyage's `Otbp` (Off the beaten path) and `Dotm` (Destination of the month) templates.
3. **Computes the daily rotation** — same FNV-1a hash used client-side, so server and browser always pick the same three places.
4. **Writes `data/live.json`** and commits only if something changed.

### Failure behaviour

Every network call is individually wrapped.

- One source fails → it's recorded in `live.json.sources` and skipped; the page shows `4/5 sources live`.
- *Every* source fails → yesterday's feed is carried over and flagged with `feedIsStale`, which renders a visible notice rather than an empty section.
- `places.json` missing or empty → the script refuses to write and exits non-zero, so a bad commit can't wipe the site.

Reddit is marked `optional` because it frequently blocks datacenter IPs; a 403 from Reddit is expected and harmless.

---

## Setup

```bash
git init && git add . && git commit -m "Hidden Atlas"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then in the repo:

1. **Settings → Pages → Source: GitHub Actions**
2. **Settings → Actions → General → Workflow permissions: Read and write**
3. **Actions → Daily update → Run workflow** to populate images immediately (otherwise the first photos appear at 05:20 UTC tomorrow).

Live at `https://<you>.github.io/<repo>/`.

### Local preview

```bash
python3 -m http.server 8000   # then open http://localhost:8000
node scripts/update.mjs       # refresh data manually
```

Opening `index.html` via `file://` will not work — `fetch()` needs a server.

---

## Editing content

All content lives in `data/`. Every user-facing string is `{"en": "...", "ko": "..."}`.

**Add a destination** to `data/places.json`:

```json
{
  "id": "unique-slug",
  "name":    { "en": "Name",    "ko": "이름" },
  "country": { "en": "Country", "ko": "국가" },
  "region": "europe",
  "tags": ["nature", "hiking"],
  "crowd": 2,
  "budget": "mid",
  "season":  { "en": "May–Sep", "ko": "5~9월" },
  "coords": [62.104, -7.443],
  "wiki": "Exact_Wikipedia_Article_Title",
  "why":  { "en": "Why it's worth the trip.", "ko": "..." },
  "know": { "en": "Practical detail that decides the trip.", "ko": "..." }
}
```

- `region` — `europe` · `asia` · `africa` · `americas` · `oceania`
- `crowd` — `1` off the radar · `2` quiet · `3` known but not crowded
- `budget` — `low` · `mid` · `high`
- `wiki` — the exact article title; this is what fetches the photo. Omit it and the card falls back to a generated contour pattern.
- New `tags` need a label added to `UI.en.tags` / `UI.ko.tags` in `index.html`, or they display as the raw key.

`tips.json` takes an optional `src` (source URL) and `verified` (`YYYY-MM`) — use them for anything regulatory.

---

## Ad slots

Three placements are reserved, currently rendering as dashed placeholders. They're driven by the `ADS` object near the top of the `<script>` in `index.html`:

| Slot | Size | Where |
| --- | --- | --- |
| `top` | 970×90 | Leaderboard, between "Right now" and the atlas |
| `grid` | 300×250 | In-grid card, after the 9th destination |
| `foot` | 970×90 | Leaderboard, above the footer |

To go live, set `enabled: true` (already on) and paste the network's markup into the matching `html` field:

```js
top: { w:970, h:90, html:`<ins class="adsbygoogle" ...></ins>` },
```

Keep `w`/`h` matching the real creative size — the placeholder reserves that height, so the swap causes no layout shift. Set `ADS.enabled = false` to hide every slot, or delete a container (`#ad-top`, `#ad-foot`) from the HTML to drop that one placement. `ADS.grid.after` controls how many cards precede the in-grid slot; it's skipped automatically when a filter leaves too few results for it to land mid-list.

Slots are labelled *Advertisement / 광고* (most networks require this), and hidden in the print stylesheet.

**Note:** if you add a network that sets cookies, the footer currently states the site does no tracking — update that copy and consider whether you need a consent banner for EU/UK visitors.

## Structure

```
index.html                  Single-file front end (styles + logic inline)
data/places.json            Destinations
data/tips.json              Practical notes
data/eats.json              Regional dishes
data/calendar.json          Month-by-month timing
data/live.json              ← generated daily
data/enriched.json          ← generated, Wikipedia image cache
scripts/update.mjs          Daily updater (Node 20, zero deps)
.github/workflows/daily.yml Cron + deploy
```

---

## Credits

Photos and summaries from Wikipedia / Wikimedia Commons under their respective licences. Featured picks from [Wikivoyage](https://wikivoyage.org) (CC BY-SA). Map tiles © CARTO, data © OpenStreetMap contributors.

Entry and tax rules change without notice — the page says so, and you should treat it that way.
