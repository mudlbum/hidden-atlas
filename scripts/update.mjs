#!/usr/bin/env node
/**
 * Hidden Atlas — daily updater
 *
 * Runs in GitHub Actions with no API keys and no npm dependencies.
 * Every network call is wrapped: a source that fails is recorded and skipped,
 * it never fails the build. Worst case the site serves yesterday's live.json.
 *
 *   1. Enriches curated places with Wikipedia images + extracts (cached).
 *   2. Pulls public travel feeds (Atlas Obscura, Wikivoyage, Reddit, blogs).
 *   3. Computes a deterministic daily rotation so the page changes every day.
 *   4. Writes data/live.json and data/enriched.json.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

const UA = 'HiddenAtlas/1.0 (https://github.com/; daily static site builder)';
const TIMEOUT = 20000;
const ENRICH_BUDGET = 80;        // Wikipedia lookups per run — at 250ms spacing the
                                 // whole catalogue warms in a single run (~20s)
const ENRICH_MAX_AGE_DAYS = 120; // refresh a successful entry roughly every 4 months
const ENRICH_RETRY_DAYS = 1;     // retry a failed lookup the next day, not in 4 months

const log = (...a) => console.log('[hidden-atlas]', ...a);

/* ------------------------------------------------------------------ utils */

async function get(url, { as = 'text', headers = {} } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept-Language': 'en', ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return as === 'json' ? await res.json() : await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readJson = async (name, fallback) => {
  try {
    return JSON.parse(await readFile(join(DATA, name), 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJson = (name, value) =>
  writeFile(join(DATA, name), JSON.stringify(value, null, 2) + '\n', 'utf8');

const decode = (s = '') =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const pick = (xml, ...tags) => {
  for (const tag of tags) {
    const m =
      xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')) ||
      xml.match(new RegExp(`<${tag}[^>]*href=["']([^"']+)["']`, 'i'));
    if (m) return decode(m[1]);
  }
  return '';
};

/** Minimal RSS 2.0 + Atom parser. */
function parseFeed(xml, limit = 6) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return blocks.slice(0, limit).map((b) => ({
    title: pick(b, 'title'),
    link: (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] || pick(b, 'link', 'guid'),
    date: pick(b, 'pubDate', 'published', 'updated'),
    summary: decode(pick(b, 'description', 'summary', 'content')).slice(0, 260),
  })).filter((i) => i.title && i.link);
}

/* ------------------------------------------------------------ photo picking
 * Wikipedia's "lead image" for a geographic article is very often a locator
 * map, an orthographic projection or a coat of arms rather than a photograph.
 * Those look broken on a travel card, so we reject them and go looking through
 * the article's other images for an actual photo.
 */
/* Bump when the filter below changes — cached photos chosen by an older
   revision are then re-checked automatically on the next run. */
const PHOTO_REV = 3;

const NOT_A_PHOTO = new RegExp(
  '(^|[_\\-\\s(])(' +
  [
    // maps and locators, including the non-English words Commons actually uses
    'maps?', 'locator', 'location', 'karte', 'mapa', 'carte', 'kaart',
    'posizione', 'ubicaci[oó]n', 'localisation', 'situation', 'lage', 'plan',
    // insignia
    'flag', 'coat[_\\-\\s]?of[_\\-\\s]?arms', 'seal', 'emblem', 'logo', 'banner',
    // diagrams and abstractions
    'orthographic', 'projection', 'globe', 'topograph\\w*', 'relief', 'blank',
    'outline', 'administrative', 'district', 'region', 'province',
    'chart', 'diagram', 'graph', 'icon', 'symbol',
    // satellite imagery — technically a photo, but not a travel photo
    'satellite', 'sentinel\\d*', 'landsat', 'modis', 'nasa', 'esa',
    // composites read as clutter at card size
    'montage', 'collage', 'composite',
    // historical map sheets, often scanned by libraries
    'atlas', 'cadastr\\w*', 'quan[_\\-\\s]?tu', 'daqing', 'nautical', 'admiralty',
  ].join('|') +
  ')([_\\-\\s.)0-9]|$)', 'i'
);

/* CJK map words appear in Commons filenames with no surrounding separators,
   so they need a separate substring test rather than the delimiter pattern. */
const CJK_MAP = /[全地]?[図图圖]|地圖|絵図/;

function looksLikePhoto(url) {
  if (!url) return false;
  let name = '';
  try { name = decodeURIComponent(url.split('/').pop().split('?')[0]); } catch { name = url; }
  // SVG is never a photograph; PNG is usually a map or diagram in this context.
  if (/\.svg$/i.test(name)) return false;
  if (NOT_A_PHOTO.test(name)) return false;
  if (CJK_MAP.test(name)) return false;
  return /\.(jpe?g|webp|png)$/i.test(name);
}

/** Resized Commons file URL — stable endpoint, no manual thumb-path surgery. */
const commonsThumb = (file, width = 800) =>
  `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/^File:/, ''))}?width=${width}`;

/** Fall back to scanning the article's images for the largest real photograph. */
async function findPhotoInArticle(title) {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2' +
    '&generator=images&gimlimit=40&prop=imageinfo&iiprop=url|size|mime&titles=' +
    encodeURIComponent(title);
  const j = await get(url, { as: 'json' });
  const cands = (j.query?.pages || [])
    .map((pg) => ({ title: pg.title, info: pg.imageinfo?.[0] }))
    .filter((x) => x.info && /^image\/(jpeg|webp)$/i.test(x.info.mime))
    .filter((x) => looksLikePhoto(x.title))
    // Ignore tiny icons and absurdly wide panoramas that crop to nothing.
    .filter((x) => x.info.width >= 640 && x.info.width / x.info.height < 4)
    .sort((a, b) => b.info.width * b.info.height - a.info.width * a.info.height);
  return cands.length ? commonsThumb(cands[0].title) : null;
}

/* ------------------------------------------------- 1. Wikipedia enrichment */

async function enrich(places, cache) {
  const now = Date.now();
  // A failed lookup must not look "fresh" — otherwise one bad day would blank a
  // card for four months. Failures get a short retry window instead.
  const stale = (e) => {
    if (!e) return true;
    if (e.error || !e.image) return !e.triedAt || now - Date.parse(e.triedAt) > ENRICH_RETRY_DAYS * 864e5;
    // Photo was chosen by an older, weaker filter — re-check it.
    if ((e.photoRev || 0) < PHOTO_REV) return true;
    return !e.fetchedAt || now - Date.parse(e.fetchedAt) > ENRICH_MAX_AGE_DAYS * 864e5;
  };

  const queue = places.filter((p) => p.wiki && stale(cache[p.id])).slice(0, ENRICH_BUDGET);
  if (!queue.length) {
    log('enrichment: cache warm, nothing to fetch');
    return { ok: queue.length, failed: 0 };
  }

  let ok = 0;
  let failed = 0;
  for (const p of queue) {
    // Action API rather than the REST summary endpoint: it lets us ask for an
    // exact thumbnail width (pithumbsize), so we never have to rewrite the URL
    // ourselves. Hand-editing a Commons thumb URL yields HTTP 400.
    const url =
      'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2' +
      '&prop=pageimages|extracts|info&inprop=url&piprop=thumbnail&pithumbsize=800' +
      '&exintro=1&explaintext=1&redirects=1&titles=' +
      encodeURIComponent(p.wiki.replace(/_/g, ' '));
    try {
      const j = await get(url, { as: 'json' });
      const page = j.query?.pages?.[0];
      if (!page || page.missing) throw new Error('no such article');

      let photo = page.thumbnail?.source || null;
      let source = 'lead';
      // Search the article's own images when the lead image is a map/diagram —
      // and equally when there is no lead image at all, which is common for
      // regions and nature reserves and used to leave the card blank.
      if (!photo || !looksLikePhoto(photo)) {
        log(`enrichment: ${p.id} ${photo ? 'lead image is not a photo' : 'has no lead image'}, searching article`);
        await sleep(200);
        const better = await findPhotoInArticle(p.wiki.replace(/_/g, ' ')).catch(() => null);
        photo = better;
        source = better ? 'article' : 'none';
      }

      const stamp = new Date().toISOString();
      cache[p.id] = {
        image: photo,
        thumb: photo,
        photoSource: source,
        photoRev: PHOTO_REV,
        extract: (page.extract || '').slice(0, 400) || null,
        page: page.fullurl || null,
        fetchedAt: stamp,
        triedAt: stamp,
      };
      if (!photo) log(`enrichment: ${p.id} has no usable photo — card will show its pattern`);
      ok++;
    } catch (err) {
      // Keep whatever we already had; only record that we tried, so tomorrow retries.
      cache[p.id] = {
        ...(cache[p.id] || {}),
        triedAt: new Date().toISOString(),
        error: String(err.message || err),
      };
      failed++;
      log(`enrichment failed for ${p.id}: ${err.message || err}`);
    }
    await sleep(250); // be a good Wikimedia citizen
  }
  log(`enrichment: ${ok} ok, ${failed} failed`);
  return { ok, failed };
}

/* --------------------------------------------------------- 2. Live sources */

const SOURCES = [
  {
    id: 'atlas-obscura',
    label: { en: 'Atlas Obscura', ko: '아틀라스 옵스큐라' },
    kind: 'rss',
    url: 'https://www.atlasobscura.com/feeds/latest',
  },
  {
    id: 'nomadic-matt',
    label: { en: 'Nomadic Matt', ko: '노매딕 맷' },
    kind: 'rss',
    url: 'https://www.nomadicmatt.com/travel-blog/feed/',
  },
  // The Broke Backpacker removed its RSS feed — /feed/ now 302s to the homepage,
  // which parsed as 0 items while still reporting HTTP 200. Replaced with r/travel.
  {
    id: 'reddit-travel',
    label: { en: 'r/travel', ko: 'r/travel' },
    kind: 'rss',
    url: 'https://www.reddit.com/r/travel/top/.rss?t=week&limit=6',
    optional: true,
  },
  {
    id: 'reddit-solotravel',
    label: { en: 'r/solotravel', ko: 'r/solotravel' },
    kind: 'rss',
    url: 'https://www.reddit.com/r/solotravel/top/.rss?t=week&limit=6',
    optional: true, // Reddit sometimes blocks datacenter IPs — treat failure as normal
  },
];

async function fetchFeeds() {
  const items = [];
  const status = [];

  for (const s of SOURCES) {
    try {
      const xml = await get(s.url);
      const parsed = parseFeed(xml, 5).map((i) => ({ ...i, source: s.id, sourceLabel: s.label }));
      // HTTP 200 with nothing parsed is a failure, not a success: it's what a
      // feed that has been retired and now redirects to an HTML page looks like.
      if (!parsed.length) throw new Error('reachable but produced 0 items — feed may have moved or been retired');
      items.push(...parsed);
      status.push({ id: s.id, ok: true, count: parsed.length });
      log(`${s.id}: ${parsed.length} items`);
    } catch (err) {
      status.push({ id: s.id, ok: false, error: String(err.message || err), optional: !!s.optional });
      log(`${s.id}: FAILED (${err.message || err})${s.optional ? ' — optional, ignoring' : ''}`);
    }
    await sleep(400);
  }
  return { items, status };
}

/** Wikivoyage's own "Off the beaten path" + "Destination of the month" features. */
async function fetchWikivoyage() {
  const out = [];
  const templates = [
    { tpl: 'Template:Otbp', kind: { en: 'Off the beaten path', ko: '숨은 명소' } },
    { tpl: 'Template:Dotm', kind: { en: 'Destination of the month', ko: '이달의 여행지' } },
  ];
  for (const t of templates) {
    try {
      const j = await get(
        `https://en.wikivoyage.org/w/api.php?action=parse&page=${encodeURIComponent(t.tpl)}&prop=links|text&format=json&formatversion=2`,
        { as: 'json' }
      );
      const link = (j.parse?.links || []).find((l) => l.ns === 0 && l.exists);
      if (!link) throw new Error('no article link in template');
      const text = decode(j.parse?.text || '').slice(0, 300);
      out.push({
        title: link.title,
        link: 'https://en.wikivoyage.org/wiki/' + encodeURIComponent(link.title.replace(/ /g, '_')),
        summary: text,
        kind: t.kind,
        source: 'wikivoyage',
        sourceLabel: { en: 'Wikivoyage', ko: '위키보야지' },
      });
    } catch (err) {
      log(`wikivoyage ${t.tpl}: FAILED (${err.message || err})`);
    }
    await sleep(300);
  }
  return out;
}

/* ------------------------------------------------- 3. Deterministic rotation */

/** Stable integer hash of a string — same input, same output, forever. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Pick n items from a list, rotating by date so the set changes daily but never repeats within a cycle. */
function rotate(list, n, seedKey) {
  if (!list.length) return [];
  const offset = hash(seedKey) % list.length;
  const out = [];
  for (let i = 0; i < Math.min(n, list.length); i++) {
    out.push(list[(offset + i * 7) % list.length]);
  }
  return [...new Set(out)];
}

/* -------------------------------------------------------------------- main */

async function main() {
  const today = new Date().toISOString().slice(0, 10);

  const places = await readJson('places.json', []);
  const tips = await readJson('tips.json', []);
  const eats = await readJson('eats.json', []);
  const cache = await readJson('enriched.json', {});

  if (!places.length) throw new Error('places.json is empty or missing — refusing to write live.json');

  const enrichment = await enrich(places, cache);
  await writeJson('enriched.json', cache);

  const { items: feedItems, status } = await fetchFeeds();
  const wikivoyage = await fetchWikivoyage();

  const previous = await readJson('live.json', null);
  const merged = [...wikivoyage, ...feedItems];

  // If every network source failed, keep yesterday's feed rather than showing an empty page.
  const feed = merged.length ? merged : previous?.feed || [];
  const feedIsStale = !merged.length && !!previous?.feed?.length;

  const ids = places.map((p) => p.id);
  const live = {
    generatedAt: new Date().toISOString(),
    date: today,
    rotation: {
      places: rotate(ids, 3, 'place:' + today),
      tip: rotate(tips.map((t) => t.id), 1, 'tip:' + today)[0] || null,
      eat: rotate(eats.map((e) => e.id), 1, 'eat:' + today)[0] || null,
    },
    counts: { places: places.length, tips: tips.length, eats: eats.length },
    feed: feed.slice(0, 24),
    feedIsStale,
    sources: status,
    enrichment,
  };

  await writeJson('live.json', live);
  log(`wrote live.json — ${live.feed.length} feed items${feedIsStale ? ' (carried over)' : ''}`);
}

main().catch((err) => {
  console.error('[hidden-atlas] fatal:', err);
  process.exit(1);
});
