#!/usr/bin/env node
/**
 * Hidden Atlas — data integrity check
 *
 * Runs in CI before deploy, and after any automated append. Exits non-zero on
 * any problem so a malformed entry can never reach the live site.
 *
 *   node scripts/validate.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const REGIONS = ['europe', 'asia', 'africa', 'americas', 'oceania'];
const BUDGETS = ['low', 'mid', 'high'];
const CROWDS = [1, 2, 3];
const IMPACTS = ['high', 'med', 'low'];

let problems = 0;
const fail = (msg) => { console.error(`  ✗ ${msg}`); problems++; };

const places   = read('data/places.json');
const tips     = read('data/tips.json');
const eats     = read('data/eats.json');
const calendar = read('data/calendar.json');
const html     = readFileSync(join(ROOT, 'index.html'), 'utf8');

/* Pull the tag/category label dictionaries out of index.html so we can prove
   every tag actually renders as a word rather than a raw key. */
const enBlock = html.slice(0, html.indexOf('ko:{'));
const koBlock = html.slice(html.indexOf('ko:{'));
const keysOf = (src, name) => {
  const m = src.match(new RegExp(name + ':\\{([\\s\\S]*?)\\}'));
  return m ? new Set([...m[1].matchAll(/(\w+):/g)].map((x) => x[1])) : new Set();
};

/* ------------------------------------------------------------------ places */
const seen = new Set();
for (const p of places) {
  const at = `place "${p.id || '(no id)'}"`;
  if (!p.id) fail(`${at}: missing id`);
  if (seen.has(p.id)) fail(`${at}: duplicate id`);
  seen.add(p.id);

  for (const f of ['name', 'country', 'why', 'know', 'season']) {
    if (!p[f]?.en?.trim()) fail(`${at}: missing ${f}.en`);
    if (!p[f]?.ko?.trim()) fail(`${at}: missing ${f}.ko`);
  }
  if (p.why?.en && p.why.en === p.why.ko) fail(`${at}: why.ko is untranslated`);
  if (p.know?.en && p.know.en === p.know.ko) fail(`${at}: know.ko is untranslated`);

  if (!REGIONS.includes(p.region)) fail(`${at}: bad region "${p.region}"`);
  if (!BUDGETS.includes(p.budget)) fail(`${at}: bad budget "${p.budget}"`);
  if (!CROWDS.includes(p.crowd))   fail(`${at}: bad crowd "${p.crowd}"`);
  if (!Array.isArray(p.tags) || !p.tags.length) fail(`${at}: no tags`);

  if (!Array.isArray(p.coords) || p.coords.length !== 2) {
    fail(`${at}: coords must be [lat, lon]`);
  } else {
    const [la, lo] = p.coords;
    if (typeof la !== 'number' || la < -90 || la > 90)   fail(`${at}: latitude out of range (${la})`);
    if (typeof lo !== 'number' || lo < -180 || lo > 180) fail(`${at}: longitude out of range (${lo})`);
    if (la === 0 && lo === 0) fail(`${at}: coords are [0,0] — almost certainly a placeholder`);
  }
  if (p.wiki && /^https?:/i.test(p.wiki)) fail(`${at}: wiki must be an article title, not a URL`);
}

/* Every tag must have a label in BOTH languages, or it renders as a raw key. */
const allTags = new Set(places.flatMap((p) => p.tags || []));
for (const [lang, src] of [['en', enBlock], ['ko', koBlock]]) {
  const labels = keysOf(src, 'tags');
  for (const tag of allTags) {
    if (!labels.has(tag)) fail(`tag "${tag}" has no ${lang} label in index.html`);
  }
}

/* -------------------------------------------------------------------- tips */
const tipCats = new Set(tips.map((t) => t.cat));
for (const t of tips) {
  const at = `tip "${t.id || '(no id)'}"`;
  if (!t.title?.en || !t.title?.ko) fail(`${at}: missing title translation`);
  if (!t.body?.en  || !t.body?.ko)  fail(`${at}: missing body translation`);
  if (!IMPACTS.includes(t.impact))  fail(`${at}: bad impact "${t.impact}"`);
  if (t.src && !/^https:\/\//.test(t.src)) fail(`${at}: src must be an https URL`);
}
for (const [lang, src] of [['en', enBlock], ['ko', koBlock]]) {
  const labels = keysOf(src, 'cats');
  for (const c of tipCats) {
    if (!labels.has(c)) fail(`tip category "${c}" has no ${lang} label in index.html`);
  }
}

/* ------------------------------------------------------------------- plans */
/* plans.json is keyed by place id. A place without a plan is fine — the page
   degrades to a "plan coming" note — but a plan that exists must be complete,
   or the detail page renders half-empty sections. */
let plans = {};
try { plans = read('data/plans.json'); } catch { fail('data/plans.json is missing or unparseable'); }

for (const [id, pl] of Object.entries(plans)) {
  const at = `plan "${id}"`;
  if (!seen.has(id)) { fail(`${at}: no place with this id`); continue; }

  for (const f of ['hub', 'getting', 'stay', 'cost', 'book']) {
    if (!pl[f]?.en?.trim() || !pl[f]?.ko?.trim()) fail(`${at}: missing ${f}.en/.ko`);
    else if (pl[f].en === pl[f].ko) fail(`${at}: ${f}.ko is untranslated`);
  }

  if (!pl.days || typeof pl.days.min !== 'number') fail(`${at}: days.min must be a number`);
  else if (pl.days.ideal != null && pl.days.ideal < pl.days.min) fail(`${at}: days.ideal is below days.min`);

  if (!Array.isArray(pl.itinerary) || !pl.itinerary.length) fail(`${at}: no itinerary`);
  else {
    pl.itinerary.forEach((d, i) => {
      if (!d.t?.en?.trim() || !d.t?.ko?.trim()) fail(`${at}: day ${i + 1} missing a translation`);
      else if (d.t.en === d.t.ko) fail(`${at}: day ${i + 1} ko is untranslated`);
    });
    // The itinerary is what "trip length" promises — they must agree.
    if (pl.days?.ideal && pl.itinerary.length > pl.days.ideal) {
      fail(`${at}: ${pl.itinerary.length} itinerary days but days.ideal is ${pl.days.ideal}`);
    }
  }

  for (const n of pl.nearby || []) {
    if (!seen.has(n)) fail(`${at}: nearby "${n}" is not a known place id`);
    if (n === id) fail(`${at}: lists itself as nearby`);
  }
  if (pl.iata && !/^[A-Z]{3}$/.test(pl.iata)) fail(`${at}: iata "${pl.iata}" is not a 3-letter code`);
}

/* -------------------------------------------------------------- eats + cal */
for (const e of eats) {
  const at = `eat "${e.id || '(no id)'}"`;
  for (const f of ['dish', 'where', 'note']) {
    if (!e[f]?.en || !e[f]?.ko) fail(`${at}: missing ${f} translation`);
  }
}
for (let m = 1; m <= 12; m++) {
  const c = calendar.find((x) => x.month === m);
  if (!c) { fail(`calendar: month ${m} missing`); continue; }
  if (!Array.isArray(c.picks) || c.picks.length < 3) fail(`calendar month ${m}: needs 3+ picks`);
  for (const p of c.picks || []) {
    if (!p.p?.en || !p.p?.ko || !p.w?.en || !p.w?.ko) fail(`calendar month ${m}: incomplete pick`);
  }
  if (!c.note?.en || !c.note?.ko) fail(`calendar month ${m}: note missing a translation`);
}

/* ------------------------------------------------------------------ report */
const byRegion = REGIONS.map((r) => `${r} ${places.filter((p) => p.region === r).length}`).join(' · ');
const planned = Object.keys(plans).length;
console.log(`places ${places.length} (${byRegion})`);
console.log(`plans ${planned}/${places.length} — ${places.length - planned} still need a day-by-day itinerary`);
console.log(`tips ${tips.length} · eats ${eats.length} · calendar ${calendar.length} months · tags ${allTags.size}`);

if (problems) {
  console.error(`\n${problems} problem(s) found — refusing to pass.`);
  process.exit(1);
}
console.log('\n✓ all data valid');
