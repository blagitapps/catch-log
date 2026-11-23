/* Harvey's Catch Log — everything is stored on this device (IndexedDB).
   Data format is versioned (DATA_VERSION) and the backup file is plain JSON,
   so catches can always be moved to a new phone or a future app. */
'use strict';
{
const APP_VERSION = '1.3.2';
const DATA_VERSION = 1;
const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/';
const LABEL_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/';
const ATTR = 'Imagery &copy; Esri, Maxar, Earthstar Geographics';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const view = $('#view');
const DEMO = !!window.CATCHLOG_DEMO;
// Demo only: a drawn lake stands in for satellite imagery (Claude previews can't load map tiles).
const LAKE = { n: 51.128, s: 51.118, w: -3.070, e: -3.050, W: 1000, H: 790 };
const lakeLL = (x, y) => ({ lat: +(LAKE.n - y / LAKE.H * (LAKE.n - LAKE.s)).toFixed(6), lng: +(LAKE.w + x / LAKE.W * (LAKE.e - LAKE.w)).toFixed(6) });
const LAKE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 790"><defs><linearGradient id="w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f6f7a"/><stop offset="1" stop-color="#1b4d5a"/></linearGradient><pattern id="f" width="60" height="60" patternUnits="userSpaceOnUse"><rect width="60" height="60" fill="#6f8a3e"/><path d="M0 30h60" stroke="#7d9847" stroke-width="14"/></pattern></defs><rect width="1000" height="790" fill="url(#f)"/><path d="M0 120 C200 160 420 60 1000 150" stroke="#b9a77a" stroke-width="16" fill="none"/><path d="M180 260 C220 150 420 140 560 190 C700 230 830 200 870 300 C910 400 820 470 720 500 C620 540 640 640 520 660 C390 680 300 620 250 540 C190 450 140 360 180 260Z" fill="#3e5e2a"/><path d="M200 270 C240 175 420 165 555 210 C690 250 815 225 850 310 C885 395 805 455 710 485 C610 520 625 620 515 640 C395 660 315 600 268 528 C210 440 165 355 200 270Z" fill="url(#w)"/><path d="M330 330 C380 300 430 320 420 360 C410 400 350 400 330 330Z" fill="#4f7a34"/>${[[220,250],[300,190],[420,170],[560,205],[700,240],[830,280],[860,380],[760,470],[640,560],[520,650],[380,640],[270,540],[190,400]].map(([x,y],i)=>`<circle cx="${x}" cy="${y}" r="13" fill="#e9e2cc" stroke="#2a3a20" stroke-width="2"/><text x="${x}" y="${y+5}" font-family="sans-serif" font-size="14" font-weight="700" text-anchor="middle" fill="#2a3a20">${i+1}</text>`).join('')}${[[120,520],[90,300],[930,560],[960,240],[620,720],[300,730],[150,680]].map(([x,y])=>`<circle cx="${x}" cy="${y}" r="34" fill="#3d5a26"/><circle cx="${x-8}" cy="${y-8}" r="20" fill="#4c6e30"/>`).join('')}<text x="520" y="420" font-family="sans-serif" font-size="28" font-weight="700" fill="#cfe6ea" fill-opacity=".8" text-anchor="middle">Willow Lake (demo)</text></svg>`;
const LAKE_URL = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(LAKE_SVG);

/* ---------------- storage ---------------- */
let dbp;
function db() {
  return dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('harvey-catch-log', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('catches')) d.createObjectStore('catches', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    let out;
    const r = fn(t.objectStore(store));
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
let mem = null; // demo fallback when the browser blocks storage
const KEYS = { catches: 'id', blobs: 'id', meta: 'key' };
const getAll = st => mem ? Promise.resolve([...mem[st].values()]) : tx(st, 'readonly', s => s.getAll());
const getOne = (st, k) => mem ? Promise.resolve(mem[st].get(k)) : tx(st, 'readonly', s => s.get(k));
const putOne = (st, v) => mem ? Promise.resolve(void mem[st].set(v[KEYS[st]], v)) : tx(st, 'readwrite', s => s.put(v));
const delOne = (st, k) => mem ? Promise.resolve(void mem[st].delete(k)) : tx(st, 'readwrite', s => s.delete(k));

// Images are stored as ArrayBuffer + type: works on every browser, old and new.
async function saveBlob(blob, id = uid()) {
  await putOne('blobs', { id, type: blob.type || 'image/jpeg', data: await blob.arrayBuffer() });
  urls.delete(id);
  return id;
}
const urls = new Map();
async function blobUrl(id) {
  if (!id) return null;
  if (urls.has(id)) return urls.get(id);
  const b = await getOne('blobs', id);
  if (!b) return null;
  const u = URL.createObjectURL(new Blob([b.data], { type: b.type }));
  urls.set(id, u);
  return u;
}

let settings = { key: 'settings', name: 'Harvey', units: 'imperial', lastBackup: null, catchesAtBackup: 0 };
let catches = [];
async function load() {
  const s = await getOne('meta', 'settings');
  if (s) settings = { ...settings, ...s };
  catches = (await getAll('catches')).sort((a, b) => (b.caughtAt || '').localeCompare(a.caughtAt || ''));
}
const saveSettings = () => putOne('meta', settings);
async function saveCatch(c) {
  c.updatedAt = new Date().toISOString();
  c.v = DATA_VERSION;
  await putOne('catches', c);
  const i = catches.findIndex(x => x.id === c.id);
  if (i >= 0) catches[i] = c; else catches.push(c);
  catches.sort((a, b) => (b.caughtAt || '').localeCompare(a.caughtAt || ''));
}

/* ---------------- units & formatting ---------------- */
const G_PER_OZ = 28.349523125;
function fmtWeight(g) {
  if (!g) return '—';
  if (settings.units === 'metric') return (g / 1000).toFixed(g < 10000 ? 2 : 1) + ' kg';
  let oz = Math.round(g / G_PER_OZ), lb = Math.floor(oz / 16);
  oz -= lb * 16;
  return lb ? `${lb}lb ${oz}oz` : `${oz}oz`;
}
function fmtLength(mm) {
  if (!mm) return '—';
  return settings.units === 'metric' ? (mm / 10).toFixed(1).replace(/\.0$/, '') + ' cm' : (mm / 25.4).toFixed(1).replace(/\.0$/, '') + ' in';
}
const fmtDate = s => s ? new Date(s).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const fmtDay = s => s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
function nowLocal() {
  const d = new Date(); d.setSeconds(0, 0);
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = deg => deg == null ? '' : COMPASS[Math.round(deg / 22.5) % 16];
const DEG = Object.fromEntries(COMPASS.map((c, i) => [c, i * 22.5]));
const WX = { 0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Light showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunder & hail', 99: 'Thunder & hail' };

function moon(when) {
  const syn = 29.530588853, ref = Date.UTC(2000, 0, 6, 18, 14);
  const days = (new Date(when) - ref) / 864e5;
  const age = ((days % syn) + syn) % syn;
  const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  return { name: names[Math.round(age / syn * 8) % 8], illum: Math.round((1 - Math.cos(2 * Math.PI * age / syn)) / 2 * 100) };
}

const RIGS = ['Hair rig', 'Ronnie rig', 'Chod rig', 'Hinged stiff rig', 'Zig rig', 'Blowback rig', 'Multi rig', 'Method feeder', 'Helicopter rig', 'Inline lead', 'Running ledger', 'Paternoster', 'Waggler', 'Stick float'];
const METHODS = ['Ledger', 'Feeder', 'Method feeder', 'Float', 'Pole', 'Surface', 'Zig', 'Lure', 'Spinning', 'Fly', 'Deadbait', 'Stalking', 'Margin'];
const BAITS = ['Boilie', 'Pop-up', 'Wafter', 'Pellet', 'Sweetcorn', 'Maggots', 'Casters', 'Worms', 'Bread', 'Luncheon meat', 'Dog biscuit', 'Particles', 'Deadbait', 'Lure'];
const history = key => [...new Set(catches.map(c => key(c)).filter(Boolean))];

/* ---------------- ui helpers ---------------- */
function toast(msg, action, fn) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (action ? ` <button type="button">${esc(action)}</button>` : '');
  t.hidden = false;
  if (action) $('button', t).onclick = () => { t.hidden = true; fn(); };
  clearTimeout(toast.t);
  if (!action) toast.t = setTimeout(() => { t.hidden = true; }, 3000);
}
function ask(title, text, yes = 'Delete') {
  return new Promise(res => {
    const m = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalText').textContent = text;
    $('#modalYes').textContent = yes;
    m.hidden = false;
    const done = v => { m.hidden = true; res(v); };
    $('#modalYes').onclick = () => done(true);
    $('#modalNo').onclick = () => done(false);
  });
}
function floatIcon(big) {
  const s = big ? 40 : 30;
  return L.divIcon({
    className: 'floatpin', iconSize: [s, s * 1.4], iconAnchor: [s / 2, s * 1.4],
    html: `<svg viewBox="0 0 20 28" width="${s}" height="${s * 1.4}"><path d="M10 27 3 14a8 8 0 1 1 14 0z" fill="#ff6b1a" stroke="#fff" stroke-width="2"/><circle cx="10" cy="9" r="3.2" fill="#fff"/></svg>`
  });
}
let maps = [];
function satLayer(m) {
  if (DEMO) {
    L.imageOverlay(LAKE_URL, [[LAKE.s, LAKE.w], [LAKE.n, LAKE.e]]).addTo(m);
    m.setMaxBounds([[LAKE.s - 0.004, LAKE.w - 0.006], [LAKE.n + 0.004, LAKE.e + 0.006]]);
    m.setMinZoom(14);
    m.attributionControl?.addAttribution('Demo lake');
    return;
  }
  L.tileLayer(TILE_URL + '{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 18, attribution: ATTR }).addTo(m);
  L.tileLayer(LABEL_URL + '{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 18 }).addTo(m);
}

/* ---------------- art ---------------- */
/* ---------------- UK freshwater species + field-guide fish drawings ---------------- */
// Each species: group, and drawing parameters (shape, fins, colours, markings). All artwork is drawn in code.
const BASE = { L: 230, D: 28, peak: .36, ped: .32, snout: .8, nose: .22, topK: 1, botK: .9, bodyEnd: .86, mouthY: 0, mouth: 'term', mouthLen: .07, eyeT: .075, eyeK: 1, iris: '#d9c27a',
  back: '#3d4a30', flank: '#a6ab88', belly: '#f0ecda', fin: '#8f7f5c', tail: 'fork', tailH: 1.2, fork: .45, dorsal: [[.42, .56, .85, 'soft']], anal: [[.62, .72, .5]], pelvic: .47, pect: .19,
  scale: 7, scaleOp: .28, barbels: 0, barbelL: 10, pat: [] };
const CARP = { L: 230, D: 34, peak: .38, ped: .34, snout: .7, nose: .3, back: '#3b2f14', flank: '#b8862e', belly: '#f0d690', fin: '#7a4a1e', iris: '#d8b040', dorsal: [[.3, .66, .75, 'long']], anal: [[.64, .72, .55]], scale: 10, scaleOp: .45, barbels: 4, barbelL: 8, mouth: 'inf', fork: .35 };
const SILVER = { back: '#2e3c44', flank: '#c9d0d2', belly: '#f6f6f0', fin: '#a9a890', scale: 8, scaleOp: .35 };
const TROUT = { L: 235, D: 24, peak: .38, ped: .36, snout: .8, nose: .24, back: '#4a4426', flank: '#c8b070', belly: '#f4ecd0', fin: '#8a7a4a', dorsal: [[.4, .52, .85, 'soft'], [.77, .81, .3, 'adipose']], anal: [[.64, .73, .5]], tail: 'fork', fork: .12, scale: 4, scaleOp: .12, mouthLen: .12 };
const SPECIES_DATA = [
  ['Carp', 'Common carp', CARP],
  ['Carp', 'Mirror carp', { ...CARP, scaleOp: .04, pat: [['mirror']] }],
  ['Carp', 'Leather carp', { ...CARP, scaleOp: 0, flank: '#a8803a', pat: [['leather']] }],
  ['Carp', 'Linear carp', { ...CARP, scaleOp: .04, pat: [['linear']] }],
  ['Carp', 'Ghost carp', { ...CARP, back: '#5e5848', flank: '#cfcab8', belly: '#f4f0e4', fin: '#8a8270', scaleOp: .3, pat: [['ghost']] }],
  ['Carp', 'Grass carp', { L: 255, D: 24, peak: .4, ped: .38, snout: .7, nose: .32, back: '#3e4a32', flank: '#9aa07a', belly: '#e8e4cc', fin: '#6a6a50', dorsal: [[.42, .53, .8, 'soft']], scale: 11, scaleOp: .55 }],
  ['Carp', 'Crucian carp', { ...CARP, L: 200, D: 42, peak: .42, back: '#4a3c14', flank: '#b08a2a', belly: '#e8cc80', fin: '#9a6a2a', dorsal: [[.33, .63, .8, 'long']], barbels: 0, fork: .25, pat: [['spot', .82, 0, 4, '#2a2010']] }],
  ['Carp', 'F1 carp', { ...CARP, L: 210, D: 38, flank: '#b48a36', barbels: 2, barbelL: 4 }],
  ['Carp', 'Goldfish', { ...CARP, L: 190, D: 36, back: '#c24e10', flank: '#ec862a', belly: '#f8c878', fin: '#e8782a', iris: '#e8b040', barbels: 0, scaleOp: .3 }],
  ['Carp', 'Koi', { ...CARP, back: '#e8e2d4', flank: '#f2eee4', belly: '#f8f6f0', fin: '#efe6d6', iris: '#3a2a1a', scaleOp: .25, pat: [['koi']] }],
  ['Predators', 'Pike', { L: 270, D: 20, peak: .46, ped: .44, snout: .75, nose: .2, bodyEnd: .84, mouthY: -.35, mouthLen: .15, eyeT: .1, back: '#2f4416', flank: '#7a9a30', belly: '#ece6b6', fin: '#b85a2a', iris: '#e8d070', dorsal: [[.66, .79, 1.05, 'soft']], anal: [[.67, .79, .85]], pelvic: .53, fork: .3, scale: 4, scaleOp: .08, pat: [['pike']] }],
  ['Predators', 'Zander', { L: 250, D: 20, peak: .37, ped: .34, snout: 1.05, eyeK: 1.4, iris: '#d8dcc8', mouthLen: .12, back: '#4a5048', flank: '#a9aea0', belly: '#f0eee6', fin: '#9a9a88', dorsal: [[.3, .47, 1.2, 'spiny'], [.5, .7, .9, 'soft']], anal: [[.64, .73, .6]], scale: 5, scaleOp: .2, pat: [['bars', 7, '#3a4038', .28], ['finspots']] }],
  ['Predators', 'Perch', { L: 215, D: 30, peak: .38, ped: .3, snout: .9, back: '#2e4418', flank: '#8fae48', belly: '#f0e8c0', fin: '#e2622a', iris: '#e8b030', dorsal: [[.26, .46, 1.3, 'spiny', '#5a6a40'], [.49, .66, .9, 'soft', '#6a7a4a']], anal: [[.62, .7, .55]], scale: 6, scaleOp: .22, mouthLen: .1, pat: [['bars', 6, '#1f2e10', .55], ['dorsalspot']] }],
  ['Predators', 'Ruffe', { L: 180, D: 26, peak: .36, snout: .8, back: '#5a5232', flank: '#a89a6a', belly: '#ece4c8', fin: '#b8aa80', eyeK: 1.3, iris: '#8a9ab0', dorsal: [[.28, .72, 1.0, 'spiny']], scale: 6, scaleOp: .2, pat: [['mottle', '#3e3820', 30], ['finspots']] }],
  ['Predators', 'Wels catfish', { L: 290, D: 26, peak: .18, ped: .16, snout: .6, nose: .45, bodyEnd: .9, botK: .85, eyeK: .55, eyeT: .1, back: '#2a2a1e', flank: '#5e5a44', belly: '#d8d0b4', fin: '#4a4636', dorsal: [[.28, .32, .45, 'soft']], anal: [[.42, .9, .42]], tail: 'round', tailH: .8, scaleOp: 0, barbels: 6, barbelL: 34, mouthLen: .1, pat: [['mottle', '#1e1e14', 50]] }],
  ['Predators', 'Eel', { L: 300, D: 12, peak: .28, ped: .06, snout: .8, nose: .35, bodyEnd: .97, back: '#2c2a14', flank: '#6a5a22', belly: '#e6d690', fin: '#4a4220', iris: '#d8c070', tail: 'none', dorsal: [[.36, .97, .3, 'band']], anal: [[.5, .97, .3, 'band']], pelvic: 0, pect: .2, scaleOp: 0 }],
  ['Silver fish', 'Roach', { ...SILVER, L: 200, D: 28, peak: .38, fin: '#d8492e', iris: '#d83a2a', dorsal: [[.42, .55, .9, 'soft', '#6a6a5a']] }],
  ['Silver fish', 'Rudd', { ...SILVER, L: 200, D: 29, peak: .4, back: '#3e4a2e', flank: '#d8c890', belly: '#f4ecd0', fin: '#e0402a', iris: '#e8b030', mouthY: -.7, dorsal: [[.5, .62, .85, 'soft', '#7a5a3a']] }],
  ['Silver fish', 'Common bream', { L: 215, D: 44, peak: .4, ped: .26, snout: .7, back: '#3a3018', flank: '#a88a48', belly: '#e6d4a0', fin: '#4a3e2a', dorsal: [[.4, .52, 1.0, 'soft']], anal: [[.54, .82, .5]], fork: .55, tailH: 1.1, mouth: 'inf', scale: 7, scaleOp: .35 }],
  ['Silver fish', 'Silver bream', { ...SILVER, L: 190, D: 38, peak: .4, ped: .26, snout: .7, fin: '#9a9a8a', dorsal: [[.4, .52, 1.0, 'soft']], anal: [[.54, .8, .5]], fork: .55, eyeK: 1.3, pat: [['redbase']] }],
  ['Silver fish', 'Roach × bream hybrid', { ...SILVER, L: 205, D: 36, peak: .4, ped: .28, flank: '#c2bea6', fin: '#a87a5a', dorsal: [[.42, .54, .95, 'soft']], anal: [[.56, .76, .5]], fork: .5 }],
  ['Silver fish', 'Chub', { L: 225, D: 26, peak: .34, ped: .36, snout: .7, nose: .32, back: '#2e3830', flank: '#b8b498', belly: '#efebd8', fin: '#5a5244', iris: '#c8a84a', dorsal: [[.43, .54, .8, 'soft']], scale: 11, scaleOp: .6, fork: .3, mouthLen: .1, pat: [['redbase']] }],
  ['Silver fish', 'Dace', { ...SILVER, L: 190, D: 20, peak: .36, ped: .3, snout: .75, fin: '#cfc8a0', iris: '#d8d0b0', fork: .6, dorsal: [[.43, .54, .85, 'soft']] }],
  ['Silver fish', 'Ide', { ...SILVER, L: 215, D: 28, back: '#3a4038', flank: '#bfbca8', fin: '#c8603a', scale: 7 }],
  ['Silver fish', 'Golden orfe', { L: 215, D: 27, back: '#d86010', flank: '#f2a040', belly: '#f8d898', fin: '#f0a050', iris: '#e8c040', scale: 7, scaleOp: .3 }],
  ['Silver fish', 'Barbel', { L: 250, D: 24, peak: .32, ped: .32, snout: 1.1, bodyEnd: .85, botK: .72, back: '#4a3e22', flank: '#a8884e', belly: '#e8d8b0', fin: '#c06a3a', iris: '#d8b060', mouth: 'inf', mouthLen: .05, barbels: 4, barbelL: 16, dorsal: [[.4, .51, 1.25, 'soft', '#7a6a4a']], anal: [[.67, .74, .65]], fork: .45, scale: 6, scaleOp: .3 }],
  ['Silver fish', 'Gudgeon', { L: 170, D: 17, peak: .32, ped: .35, snout: .9, botK: .75, back: '#5a5a3a', flank: '#b0a888', belly: '#eee8d8', fin: '#b8a880', mouth: 'inf', mouthLen: .05, barbels: 2, barbelL: 7, eyeK: 1.2, scale: 6, scaleOp: .3, pat: [['blotchrow', 8, '#3a4a5a']] }],
  ['Silver fish', 'Bleak', { ...SILVER, L: 170, D: 16, peak: .36, snout: .9, mouthY: -.7, fin: '#c8c8b8', back: '#4a6070', fork: .6, eyeK: 1.2, scaleOp: .2 }],
  ['Silver fish', 'Minnow', { L: 150, D: 16, peak: .38, ped: .38, snout: .7, back: '#4a5230', flank: '#a8a880', belly: '#eee4c8', fin: '#a89a6a', scale: 3, scaleOp: .1, pat: [['blotchrow', 10, '#2a3018']] }],
  ['Silver fish', 'Tench', { L: 225, D: 30, peak: .4, ped: .5, snout: .7, nose: .32, back: '#22320f', flank: '#56772a', belly: '#d8c070', fin: '#2d3d18', iris: '#d8402a', tail: 'trunc', fork: .08, tailH: 1.05, dorsal: [[.42, .55, .8, 'round']], anal: [[.62, .72, .55, 'round']], scale: 3.5, scaleOp: .15, barbels: 2, barbelL: 4 }],
  ['Silver fish', 'Golden tench', { L: 225, D: 30, peak: .4, ped: .5, snout: .7, nose: .32, back: '#c07a18', flank: '#e8a840', belly: '#f6d888', fin: '#c08a2a', iris: '#d8402a', tail: 'trunc', fork: .08, tailH: 1.05, dorsal: [[.42, .55, .8, 'round']], anal: [[.62, .72, .55, 'round']], scale: 3.5, scaleOp: .15, barbels: 2, barbelL: 4, pat: [['mottle', '#5a3a10', 14]] }],
  ['Game fish', 'Brown trout', { ...TROUT, pat: [['spots', 30, '#1d1a12', [-.85, .35], 2.6], ['spots', 14, '#c43a26', [-.3, .4], 2.2, '#f4ecd0']] }],
  ['Game fish', 'Sea trout', { ...TROUT, back: '#3e4c56', flank: '#d6dade', belly: '#f6f6f2', fin: '#8a9098', fork: .18, pat: [['xspots', 22, '#1d222a', [-.8, .2]]] }],
  ['Game fish', 'Atlantic salmon', { ...TROUT, L: 265, D: 25, ped: .3, back: '#34444e', flank: '#d2d8dc', belly: '#f8f8f4', fin: '#7a8088', fork: .3, pat: [['xspots', 14, '#1d222a', [-.85, -.1]]] }],
  ['Game fish', 'Rainbow trout', { ...TROUT, back: '#4a5a3a', flank: '#c8ccb0', belly: '#f4f0e0', fin: '#8a8a70', pat: [['band', '#d86a7a'], ['spots', 50, '#1d1a12', [-.9, .3], 1.6], ['tailspots']] }],
  ['Game fish', 'Brook trout', { ...TROUT, back: '#2e3e24', flank: '#7a8a5a', belly: '#e87a3a', fin: '#d8602a', pat: [['vermic', '#c8c890'], ['spots', 10, '#d83a2a', [-.3, .3], 2, '#6a9ad8'], ['whiteedge']] }],
  ['Game fish', 'Tiger trout', { ...TROUT, back: '#4a4a26', flank: '#c8b878', belly: '#f0e4c0', pat: [['vermic', '#2a2a14']] }],
  ['Game fish', 'Golden trout', { ...TROUT, back: '#c89a20', flank: '#f0cc50', belly: '#f8e8a0', fin: '#f0c040' }],
  ['Game fish', 'Arctic char', { ...TROUT, back: '#34444a', flank: '#8a9a96', belly: '#e8603a', fin: '#d8603a', pat: [['spots', 22, '#f0e0c0', [-.7, .2], 2.2], ['whiteedge']] }],
  ['Game fish', 'Grayling', { L: 235, D: 24, peak: .36, ped: .32, snout: 1, back: '#4a5048', flank: '#b8b8b0', belly: '#efeee8', fin: '#9a8a8a', iris: '#d8c070', mouth: 'inf', mouthLen: .05, dorsal: [[.3, .6, 1.9, 'sail', '#7a4a5a'], [.79, .82, .3, 'adipose']], anal: [[.66, .74, .5]], fork: .45, scale: 7, scaleOp: .35, pat: [['spots', 9, '#1d1a12', [-.5, .2], 2.2, null, .15, .45]] }],
  ['Others', 'Pumpkinseed', { L: 170, D: 46, peak: .45, ped: .3, snout: .7, back: '#5a6a3a', flank: '#c8a050', belly: '#f0b040', fin: '#9a8a4a', dorsal: [[.36, .5, .8, 'spiny'], [.5, .74, .7, 'round']], anal: [[.56, .74, .55, 'round']], tail: 'trunc', fork: .2, tailH: 1, scale: 6, scaleOp: .3, pat: [['bluelines'], ['earspot']] }],
  ['Others', 'Bullhead', { L: 150, D: 16, peak: .18, ped: .32, snout: .6, nose: .5, botK: .7, eyeK: 1.2, back: '#4a3e26', flank: '#8a7a54', belly: '#e0d4b0', fin: '#7a6a48', dorsal: [[.32, .46, .7, 'soft'], [.48, .78, .8, 'soft']], anal: [[.52, .78, .55]], pect: .17, tail: 'round', tailH: .9, scaleOp: 0, pat: [['mottle', '#2a2214', 26]] }],
  ['Others', 'Stone loach', { L: 160, D: 12, peak: .4, ped: .7, snout: .55, botK: .8, back: '#5a5032', flank: '#a8986a', belly: '#e8dcb8', fin: '#9a8a62', tail: 'trunc', fork: .05, tailH: 1.3, barbels: 6, barbelL: 6, scaleOp: 0, pat: [['mottle', '#3a3018', 30]] }],
  ['Others', 'Three-spined stickleback', { L: 120, D: 15, peak: .4, ped: .2, snout: .9, back: '#3e5236', flank: '#9aa888', belly: '#e8503a', fin: '#a8b098', eyeK: 1.3, iris: '#5aa8c8', dorsal: [[.3, .32, 1.3, 'spine'], [.4, .42, 1.2, 'spine'], [.5, .52, .5, 'spine'], [.58, .74, .8, 'soft']], scaleOp: 0 }],
  ['Others', 'Flounder', { L: 220, D: 58, peak: .45, ped: .18, snout: .55, bodyEnd: .84, back: '#5a4a32', flank: '#7a6a48', belly: '#8a7a56', fin: '#6a5a3e', tail: 'round', tailH: .65, dorsal: [[.08, .84, .35, 'frill']], anal: [[.3, .84, .35, 'frill']], pelvic: 0, pect: 0, scaleOp: 0, eyeT: .12, pat: [['spots', 16, '#d86a2a', [-.6, .6], 3]] }]
];
const SPECIES = SPECIES_DATA.map(s => s[1]);
const SP_BY = Object.fromEntries(SPECIES_DATA.map(([g, n, p]) => [n.toLowerCase(), { group: g, name: n, p: { ...BASE, ...p } }]));
function speciesInfo(name = '') {
  const n = name.trim().toLowerCase();
  if (SP_BY[n]) return SP_BY[n];
  const hit = SPECIES_DATA.find(([, s]) => n && (n.includes(s.toLowerCase()) || s.toLowerCase().includes(n)));
  if (hit) return SP_BY[hit[1].toLowerCase()];
  const kw = [[/pike|jack/, 'Pike'], [/zander/, 'Zander'], [/perch/, 'Perch'], [/mirror/, 'Mirror carp'], [/leather/, 'Leather carp'], [/carp/, 'Common carp'], [/bream|skimmer/, 'Common bream'], [/tench/, 'Tench'], [/roach/, 'Roach'], [/rudd/, 'Rudd'], [/chub/, 'Chub'], [/barbel/, 'Barbel'], [/salmon/, 'Atlantic salmon'], [/rainbow/, 'Rainbow trout'], [/trout|brownie/, 'Brown trout'], [/cat/, 'Wels catfish'], [/eel/, 'Eel'], [/gold/, 'Goldfish']].find(([r]) => r.test(n));
  return SP_BY[(kw ? kw[1] : 'Roach').toLowerCase()];
}

function rng(seed) { let a = 0; for (const ch of String(seed)) a = (a * 31 + ch.charCodeAt(0)) | 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let artN = 0;
const f1 = n => (+n).toFixed(1);
function smooth(pts) { // Catmull-Rom -> cubic Bezier through points
  let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += ` C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return d;
}

// A realistic, field-guide style fish facing left. kind = species name.
function fishSVG(kind, seed = kind, cls = '') {
  const info = speciesInfo(kind), p = info.p, r = rng(seed + kind), id = 'fx' + (++artN);
  const { L, D } = p, cy = 65, x0 = 12, W = L + 80;
  const prof = t => {
    if (t <= p.peak) return p.nose + (1 - p.nose) * Math.pow(Math.sin(t / p.peak * Math.PI / 2), p.snout);
    const u = Math.min(1, (t - p.peak) / (p.bodyEnd - p.peak) * 1.12);
    return p.ped + (1 - p.ped) * (1 + Math.cos(u * Math.PI)) / 2;
  };
  const off = t => t < p.peak ? p.mouthY * D * .35 * (1 - t / p.peak) ** 2 : 0;
  const X = t => x0 + t * L;
  const top = t => cy - D * p.topK * prof(t) + off(t), bot = t => cy + D * p.botK * prof(t) + off(t);
  const midY = (t, k) => { const a = top(t), b = bot(t); return a + (b - a) * (k + 1) / 2; }; // k: -1 top .. 1 bottom
  const N = 28, T = [...Array(N + 1)].map((_, i) => p.bodyEnd * i / N);
  const upper = T.map(t => [X(t), top(t)]), lower = T.map(t => [X(t), bot(t)]).reverse();
  const tailX = X(p.bodyEnd);
  const nx = X(0) - D * p.nose * 1.1, cap = ` C${f1(nx)} ${f1(bot(0))} ${f1(nx)} ${f1(top(0))} ${f1(X(0))} ${f1(top(0))}`;
  const body = smooth(upper) + ` L${f1(lower[0][0])} ${f1(lower[0][1])} ` + smooth(lower).replace(/^M[^C]*/, '') + cap + 'Z';
  const outline = smooth(upper) + ' ' + smooth(T.map(t => [X(t), bot(t)])) + ` M${f1(X(0))} ${f1(bot(0))}` + cap;
  const finCol = c => c || p.fin;
  const rays = (bx1, by1, bx2, by2, tips) => tips.map(([tx, ty], i) => { const k = i / Math.max(1, tips.length - 1); return `M${f1(bx1 + (bx2 - bx1) * k)} ${f1(by1 + (by2 - by1) * k)} L${f1(tx)} ${f1(ty)}`; }).join(' ');
  let fins = '', finRays = '', front = '';
  const finShape = (t1, t2, h, shape, upperSide, col) => {
    const s = upperSide ? -1 : 1, edge = upperSide ? top : bot, hh = h * D;
    const a = [X(t1), edge(t1) - s * 2], b = [X(t2), edge(t2) - s * 2];
    let d = '', tips = [];
    if (shape === 'spiny' || shape === 'spine') {
      const n = shape === 'spine' ? 1 : Math.max(5, Math.round((t2 - t1) * 50));
      const pts = [a];
      for (let i = 0; i <= n; i++) { const t = t1 + (t2 - t1) * (n ? i / n : .5), hk = shape === 'spine' ? 1 : Math.sin(Math.PI * (.15 + .85 * i / n)) * .8 + .2; const tip = [X(t) + 2, edge(t) + s * hh * hk]; pts.push(tip); tips.push(tip); if (i < n) pts.push([X(t + (t2 - t1) / n / 2), edge(t) + s * hh * hk * .45]); }
      pts.push(b); d = 'M' + pts.map(q => f1(q[0]) + ' ' + f1(q[1])).join(' L') + 'Z';
      fins += `<path d="${d}" fill="${finCol(col)}" fill-opacity=".8" stroke="#00000055" stroke-width=".8"/>`;
      finRays += tips.map((q, i) => { const t = t1 + (t2 - t1) * (n ? i / n : .5); return `M${f1(X(t))} ${f1(edge(t))} L${f1(q[0])} ${f1(q[1])}`; }).join(' ');
      return;
    }
    if (shape === 'adipose') { d = `M${f1(a[0])} ${f1(a[1])} Q${f1((a[0] + b[0]) / 2)} ${f1(a[1] + s * hh * 1.6)} ${f1(b[0] + 3)} ${f1(b[1])}Z`; fins += `<path d="${d}" fill="${p.back}" stroke="#00000044" stroke-width=".8"/>`; return; }
    if (shape === 'band' || shape === 'frill') {
      const n = 14, out = [];
      for (let i = 0; i <= n; i++) { const t = t1 + (t2 - t1) * i / n; const hk = shape === 'band' ? Math.min(1, i / 3) : Math.sin(Math.PI * i / n) * .7 + .3; out.push([X(t), edge(t) + s * hh * hk]); }
      const endX = shape === 'band' ? x0 + L + 8 : X(t2) + 4;
      d = `M${f1(a[0])} ${f1(a[1])} ` + smooth(out).replace(/^M/, 'L') + ` L${f1(endX)} ${f1(shape === 'band' ? cy : b[1])} L${f1(b[0])} ${f1(b[1])}Z`;
      fins += `<path d="${d}" fill="${finCol(col)}" fill-opacity=".85" stroke="#00000044" stroke-width=".8"/>`;
      finRays += out.filter((_, i) => i % 1 === 0).map(q => `M${f1(q[0] - 2)} ${f1(edge((q[0] - x0) / L) - s)} L${f1(q[0])} ${f1(q[1])}`).join(' ');
      return;
    }
    let lead, trail;
    if (shape === 'long') { lead = [X(t1 + (t2 - t1) * .08), edge(t1) + s * hh]; trail = [X(t2) + 4, edge(t2) + s * hh * .3]; d = `M${f1(a[0])} ${f1(a[1])} Q${f1(a[0] - 2)} ${f1(lead[1])} ${f1(lead[0])} ${f1(lead[1])} Q${f1(X((t1 + t2) / 2))} ${f1(edge((t1 + t2) / 2) + s * hh * .35)} ${f1(trail[0])} ${f1(trail[1])} L${f1(b[0])} ${f1(b[1])}Z`; }
    else if (shape === 'sail') { lead = [X(t1 + (t2 - t1) * .2), edge(t1) + s * hh * .9]; trail = [X(t2) + 6, edge(t2) + s * hh * .55]; d = `M${f1(a[0])} ${f1(a[1])} C${f1(a[0])} ${f1(lead[1])} ${f1(X(t1 + (t2 - t1) * .6))} ${f1(edge(t1) + s * hh * 1.05)} ${f1(trail[0])} ${f1(trail[1])} L${f1(b[0])} ${f1(b[1])}Z`; }
    else if (shape === 'round') { lead = [X(t1 + (t2 - t1) * .4), edge(t1) + s * hh]; trail = [X(t2) + 3, edge(t2) + s * hh * .4]; d = `M${f1(a[0])} ${f1(a[1])} C${f1(a[0] - 2)} ${f1(a[1] + s * hh * .9)} ${f1(trail[0] + 4)} ${f1(lead[1])} ${f1(trail[0])} ${f1(trail[1])} L${f1(b[0])} ${f1(b[1])}Z`; }
    else { lead = [X(t1 + (t2 - t1) * .3), edge(t1) + s * hh]; trail = [X(t2) + 6, edge(t2) + s * hh * .3]; d = `M${f1(a[0])} ${f1(a[1])} Q${f1(a[0])} ${f1(lead[1] - s * 2)} ${f1(lead[0])} ${f1(lead[1])} Q${f1((lead[0] + trail[0]) / 2)} ${f1((lead[1] + trail[1]) / 2 - s * hh * .1)} ${f1(trail[0])} ${f1(trail[1])} L${f1(b[0])} ${f1(b[1])}Z`; }
    fins += `<path d="${d}" fill="${col ? col : `url(#${id}fn)`}" fill-opacity=".9" stroke="#00000044" stroke-width=".8"/>`;
    tips = [...Array(7)].map((_, i) => { const k = i / 6; return [lead[0] + (trail[0] - lead[0]) * k, lead[1] + (trail[1] - lead[1]) * k]; });
    finRays += rays(a[0], a[1], b[0], b[1], tips);
  };
  for (const [t1, t2, h, sh = 'soft', col] of p.dorsal) finShape(t1, t2, h, sh, true, col);
  for (const [t1, t2, h, sh = 'soft', col] of p.anal) finShape(t1, t2, h, sh, false, col);
  if (p.pelvic) finShape(p.pelvic, p.pelvic + .06, .55, 'soft', false);
  // tail
  let tail = '';
  const th = D * p.ped * (p.topK + p.botK) / 2, H = D * p.tailH, tl = L * .17, tx1 = tailX + tl;
  if (p.tail === 'fork' || p.tail === 'trunc') {
    const notch = tx1 - tl * (p.tail === 'trunc' ? p.fork : p.fork * .9);
    tail = `M${f1(tailX - 3)} ${f1(cy - th)} C${f1(tailX + tl * .4)} ${f1(cy - th * 1.2)} ${f1(tx1 - tl * .2)} ${f1(cy - H * .9)} ${f1(tx1)} ${f1(cy - H)} Q${f1(notch + tl * .1)} ${f1(cy - H * .3)} ${f1(notch)} ${cy} Q${f1(notch + tl * .1)} ${f1(cy + H * .3)} ${f1(tx1)} ${f1(cy + H)} C${f1(tx1 - tl * .2)} ${f1(cy + H * .9)} ${f1(tailX + tl * .4)} ${f1(cy + th * 1.2)} ${f1(tailX - 3)} ${f1(cy + th)}Z`;
    finRays += [...Array(11)].map((_, i) => { const k = i / 10, y = cy - H + 2 * H * k, x = notch + (tx1 - notch) * Math.abs(1 - 2 * k) ** .7; return `M${f1(tailX)} ${f1(cy - th + 2 * th * k)} L${f1(x)} ${f1(y)}`; }).join(' ');
  } else if (p.tail === 'round') {
    tail = `M${f1(tailX - 3)} ${f1(cy - th)} C${f1(tx1)} ${f1(cy - H * 1.1)} ${f1(tx1 + 4)} ${f1(cy + H * 1.1)} ${f1(tailX - 3)} ${f1(cy + th)}Z`;
    finRays += [...Array(9)].map((_, i) => { const a = -1 + 2 * i / 8; return `M${f1(tailX)} ${cy} L${f1(tailX + tl * .85 * (1 - a * a * .3))} ${f1(cy + a * H * .85)}`; }).join(' ');
  }
  // markings
  const R = (a, b) => a + r() * (b - a);
  let pat = '';
  for (const [type, ...q] of p.pat) {
    if (type === 'pike') { for (let t = .14; t < .82; t += .028) for (let k = -.75; k < .45; k += .3) if (r() < .85) { const x = X(t + R(-.006, .006)), y = midY(t, k + R(-.08, .08)); pat += `<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="${f1(R(2.6, 4.6))}" ry="${f1(R(1.3, 2.2))}" fill="#eef0b8" opacity="${f1(R(.55, .85))}" transform="rotate(${f1(R(-25, 25))} ${f1(x)} ${f1(y)})"/>`; }
      pat += [...Array(9)].map((_, i) => `<path d="M${f1(X(.2 + i * .07))} ${f1(top(.2 + i * .07))} L${f1(X(.22 + i * .07))} ${f1(bot(.22 + i * .07))}" stroke="#1e2e0a" stroke-width="5" opacity=".18"/>`).join(''); }
    if (type === 'bars') { const [n, col, op] = q; for (let i = 0; i < n; i++) { const t = .24 + i * (.56 / n), w = D * .22 * (1 - i * .05); pat += `<path d="M${f1(X(t))} ${f1(top(t) - 2)} C${f1(X(t) + 4)} ${f1(midY(t, -.2))} ${f1(X(t) - 2)} ${f1(midY(t, .3))} ${f1(X(t) + 2)} ${f1(midY(t, .62))}" stroke="${col}" stroke-width="${f1(w)}" stroke-linecap="round" opacity="${op}" fill="none"/>`; } }
    if (type === 'mirror') for (let i = 0; i < 9; i++) { const t = R(.22, .72), k = i < 5 ? R(-.85, -.55) : R(-.15, .1); pat += `<ellipse cx="${f1(X(t))}" cy="${f1(midY(t, k))}" rx="${f1(R(4, 8) * D / 34)}" ry="${f1(R(3.5, 6) * D / 34)}" fill="#e8b860" stroke="#6a4010" stroke-width=".9" opacity=".9"/><ellipse cx="${f1(X(t) - 1)}" cy="${f1(midY(t, k) - 1)}" rx="${f1(2 * D / 34)}" ry="${f1(1.4 * D / 34)}" fill="#fff6d0" opacity=".5"/>`; }
    if (type === 'leather') for (let i = 0; i < 3; i++) { const t = .32 + i * .1; pat += `<ellipse cx="${f1(X(t))}" cy="${f1(midY(t, -.85))}" rx="4" ry="3" fill="#d8a858" stroke="#6a4010" stroke-width=".8" opacity=".8"/>`; }
    if (type === 'linear') for (let t = .2; t < .8; t += .045) pat += `<ellipse cx="${f1(X(t))}" cy="${f1(midY(t, -.08))}" rx="${f1(D * .14)}" ry="${f1(D * .11)}" fill="#e8b860" stroke="#6a4010" stroke-width=".9"/>`;
    if (type === 'ghost' || type === 'koi') for (let i = 0; i < (type === 'koi' ? 6 : 9); i++) { const t = R(.12, .78), k = R(-.9, .2), col = type === 'koi' ? (i % 3 === 2 ? '#1a1a1a' : '#d8401a') : (i % 2 ? '#f6f2e0' : '#6a6450'); pat += `<ellipse cx="${f1(X(t))}" cy="${f1(midY(t, k))}" rx="${f1(R(8, 18))}" ry="${f1(R(5, 11))}" fill="${col}" opacity="${type === 'koi' ? .9 : .5}" transform="rotate(${f1(R(-30, 30))} ${f1(X(t))} ${f1(midY(t, k))})"/>`; }
    if (type === 'spot') { const [t, k, rr, col] = q; pat += `<circle cx="${f1(X(t))}" cy="${f1(midY(t, k))}" r="${rr}" fill="${col}" opacity=".7"/>`; }
    if (type === 'spots' || type === 'xspots') { const [n, col, [k1, k2], rr = 2, halo, t1 = .12, t2 = .82] = q; for (let i = 0; i < n; i++) { const t = R(t1, t2), x = X(t), y = midY(t, R(k1, k2)), s = rr * R(.7, 1.2); if (type === 'xspots') pat += `<path d="M${f1(x - s)} ${f1(y - s)} L${f1(x + s)} ${f1(y + s)} M${f1(x + s)} ${f1(y - s)} L${f1(x - s)} ${f1(y + s)}" stroke="${col}" stroke-width="1.5" opacity=".8"/>`; else pat += `${halo ? `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(s * 1.9)}" fill="${halo}" opacity=".75"/>` : ''}<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(s)}" fill="${col}" opacity=".85"/>`; } }
    if (type === 'band') pat += `<path d="M${f1(X(.1))} ${f1(midY(.1, 0))} C${f1(X(.35))} ${f1(midY(.35, -.1))} ${f1(X(.6))} ${f1(midY(.6, -.05))} ${f1(X(.86))} ${f1(midY(.86, 0))}" stroke="${q[0]}" stroke-width="${f1(D * .45)}" opacity=".55" fill="none" stroke-linecap="round"/>`;
    if (type === 'vermic') for (let i = 0; i < 28; i++) { const t = R(.12, .82), x = X(t), y = midY(t, R(-.95, -.1)); pat += `<path d="M${f1(x)} ${f1(y)} q${f1(R(-6, 6))} ${f1(R(-4, 4))} ${f1(R(4, 9))} ${f1(R(-3, 3))}" stroke="${q[0]}" stroke-width="1.6" fill="none" opacity=".75"/>`; }
    if (type === 'mottle') { const [col, n] = q; for (let i = 0; i < n; i++) { const t = R(.08, .86), x = X(t), y = midY(t, R(-1, .5)); pat += `<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="${f1(R(2, 7))}" ry="${f1(R(1.5, 4))}" fill="${col}" opacity="${f1(R(.25, .55))}" transform="rotate(${f1(R(0, 180))} ${f1(x)} ${f1(y)})"/>`; } }
    if (type === 'blotchrow') { const [n, col] = q; for (let i = 0; i < n; i++) { const t = .16 + i * (.66 / n); pat += `<ellipse cx="${f1(X(t))}" cy="${f1(midY(t, -.05))}" rx="${f1(D * .2)}" ry="${f1(D * .14)}" fill="${col}" opacity=".45"/>`; } }
    if (type === 'bluelines') for (let i = 0; i < 6; i++) pat += `<path d="M${f1(X(.05))} ${f1(midY(.1, -.6 + i * .25))} q${f1(L * .1)} ${f1(R(-4, 4))} ${f1(L * .2)} ${f1(R(-2, 6))}" stroke="#4aa8d8" stroke-width="1.6" opacity=".7" fill="none"/>`;
    if (type === 'redbase') front += `<g fill="#d8582a" opacity=".55">${p.pelvic ? `<ellipse cx="${f1(X(p.pelvic + .03))}" cy="${f1(bot(p.pelvic + .03) + 6)}" rx="6" ry="4"/>` : ''}</g>`;
  }
  // per-species extras on fins
  const extra = [];
  if (p.pat.some(q => q[0] === 'dorsalspot')) extra.push(`<ellipse cx="${f1(X(p.dorsal[0][1] - .03))}" cy="${f1(top(p.dorsal[0][1] - .03) - D * .45)}" rx="5" ry="6" fill="#141a0a" opacity=".8"/>`);
  if (p.pat.some(q => q[0] === 'earspot')) extra.push(`<ellipse cx="${f1(X(.19))}" cy="${f1(midY(.19, -.25))}" rx="4" ry="3" fill="#1a1a1a"/><ellipse cx="${f1(X(.2) + 2)}" cy="${f1(midY(.19, -.25))}" rx="2" ry="2.2" fill="#d8301a"/>`);
  if (p.pat.some(q => q[0] === 'tailspots')) for (let i = 0; i < 12; i++) extra.push(`<circle cx="${f1(tailX + R(4, L * .15))}" cy="${f1(cy + R(-H * .7, H * .7))}" r="1.4" fill="#1d1a12" opacity=".8"/>`);
  // head details
  const gillT = p.eyeT * 2.3 + .02, eR = (2.2 + D * .12) * p.eyeK, eT = p.eyeT, ex = X(eT) + 2, ey = midY(eT, p.mouthY < 0 ? -.4 : -.3);
  const mx = nx + D * p.nose * .25, my = p.mouth === 'inf' ? midY(.02, .35) : off(0) + cy + (p.mouthY < 0 ? -1 : 1);
  const mouth = `<path d="M${f1(mx + 1)} ${f1(my)} Q${f1(X(p.mouthLen * .6))} ${f1(my + 2)} ${f1(X(p.mouthLen))} ${f1(my + (p.mouth === 'inf' ? 1 : 3))}" stroke="#1a140a" stroke-width="1.3" fill="none" opacity=".75"/>`;
  let barb = '';
  for (let i = 0; i < p.barbels; i++) { const side = i % 2, len = p.barbelL * (i < 2 ? 1 : .6); barb += `<path d="M${f1(mx + 2 + i * 2)} ${f1(my + 1)} q${f1(-2 + side * 3)} ${f1(len * .6)} ${f1(len * .35 + i)} ${f1(len)}" stroke="${p.fin}" stroke-width="${p.barbels > 4 ? 1.6 : 1.2}" fill="none" stroke-linecap="round" opacity=".95"/>`; }
  const pect = p.pect ? `<path d="M${f1(X(p.pect))} ${f1(midY(p.pect, .35))} C${f1(X(p.pect + .05))} ${f1(midY(p.pect, .45))} ${f1(X(p.pect + .1))} ${f1(midY(p.pect + .1, .75))} ${f1(X(p.pect + .11))} ${f1(midY(p.pect + .1, 1.05))} C${f1(X(p.pect + .06))} ${f1(midY(p.pect + .06, .95))} ${f1(X(p.pect + .02))} ${f1(midY(p.pect, .7))} ${f1(X(p.pect))} ${f1(midY(p.pect, .35))}Z" fill="${p.fin}" fill-opacity=".7" stroke="#00000044" stroke-width=".7"/>` : '';
  const sc = p.scale;
  return `<svg class="fishsvg ${cls}" viewBox="0 0 ${W} 130" aria-hidden="true"><defs>
<linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.back}"/><stop offset=".22" stop-color="${p.back}"/><stop offset=".5" stop-color="${p.flank}"/><stop offset=".8" stop-color="${p.belly}"/><stop offset="1" stop-color="${p.belly}"/></linearGradient>
<linearGradient id="${id}h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity=".18"/><stop offset=".25" stop-color="#000" stop-opacity="0"/><stop offset=".8" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".2"/></linearGradient>
<linearGradient id="${id}fn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.fin}"/><stop offset="1" stop-color="${p.fin}" stop-opacity=".75"/></linearGradient>
<pattern id="${id}s" width="${sc}" height="${f1(sc * .8)}" patternUnits="userSpaceOnUse"><path d="M0 ${f1(sc * .4)} q${f1(sc / 2)} ${f1(sc * .55)} ${sc} 0 M${f1(-sc / 2)} 0 q${f1(sc / 2)} ${f1(sc * .55)} ${sc} 0 M${f1(sc / 2)} 0 q${f1(sc / 2)} ${f1(sc * .55)} ${sc} 0" stroke="#000" stroke-width=".8" fill="none"/></pattern>
<radialGradient id="${id}e"><stop offset=".5" stop-color="${p.iris}"/><stop offset="1" stop-color="#3a3010"/></radialGradient>
<filter id="${id}b" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
<clipPath id="${id}c"><path d="${body}"/></clipPath></defs>
<ellipse cx="${f1(x0 + L * .5)}" cy="${f1(cy + D * p.botK + 14)}" rx="${f1(L * .42)}" ry="4" fill="#000" opacity=".18" filter="url(#${id}b)"/>
<g class="fins">${tail ? `<path class="tail" d="${tail}" fill="url(#${id}fn)" fill-opacity=".9" stroke="#00000044" stroke-width=".8"/>` : ''}${fins}<path d="${finRays}" stroke="#00000040" stroke-width=".6" fill="none"/></g>
<path d="${body}" fill="url(#${id}g)"/>
<g clip-path="url(#${id}c)">
<rect x="0" y="0" width="${W}" height="130" fill="url(#${id}s)" opacity="${p.scaleOp}"/>
${pat}
<path d="M${f1(X(gillT))} ${f1(midY(gillT, -.1))} C${f1(X(.4))} ${f1(midY(.4, -.25))} ${f1(X(.65))} ${f1(midY(.65, -.15))} ${f1(X(p.bodyEnd))} ${cy}" stroke="#00000040" stroke-width="1" fill="none" stroke-dasharray="1.5 2"/>
<ellipse cx="${f1(X(.42))}" cy="${f1(midY(.42, -.55))}" rx="${f1(L * .3)}" ry="${f1(D * .22)}" fill="#fff" opacity=".22" filter="url(#${id}b)"/>
<path d="${body}" fill="url(#${id}h)"/>
<path d="M${f1(X(gillT))} ${f1(top(gillT) - 2)} C${f1(X(gillT + .05))} ${f1(midY(gillT, -.2))} ${f1(X(gillT + .04))} ${f1(midY(gillT, .4))} ${f1(X(gillT - .02))} ${f1(bot(gillT) + 2)}" stroke="#00000060" stroke-width="1.6" fill="none"/>
<path d="M${f1(X(gillT))} ${f1(top(gillT) - 2)} C${f1(X(gillT + .05))} ${f1(midY(gillT, -.2))} ${f1(X(gillT + .04))} ${f1(midY(gillT, .4))} ${f1(X(gillT - .02))} ${f1(bot(gillT) + 2)} L0 130 L0 0Z" fill="#000" opacity=".06"/>
${front}</g>
<path d="${outline}" fill="none" stroke="#00000066" stroke-width="1"/>
${extra.join('')}${pect}${mouth}${barb}
<circle cx="${f1(ex)}" cy="${f1(ey)}" r="${f1(eR + 1)}" fill="#00000040"/><circle cx="${f1(ex)}" cy="${f1(ey)}" r="${f1(eR)}" fill="url(#${id}e)"/><circle cx="${f1(ex - eR * .1)}" cy="${f1(ey)}" r="${f1(eR * .55)}" fill="#0c0a06"/><circle cx="${f1(ex - eR * .35)}" cy="${f1(ey - eR * .38)}" r="${f1(eR * .22)}" fill="#fff" opacity=".9"/>
</svg>`;
}
function fishArt(species, seed = '') {
  const id = 'fa' + (++artN);
  return `<svg class="fishart" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs>
<linearGradient id="${id}w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9a66a"/><stop offset=".35" stop-color="#5e6a3c"/><stop offset="1" stop-color="#1c2416"/></linearGradient></defs>
<rect width="400" height="300" fill="url(#${id}w)"/>
<g fill="#fff6dc" opacity=".09"><path d="M70 0h34L50 300H16z"/><path d="M190 0h20l-64 300h-20z"/><path d="M300 0h44l-74 300h-44z"/></g>
<g fill="#1a2210" opacity=".75"><path d="M0 300 Q14 220 10 170 Q22 230 24 300Z"/><path d="M30 300 Q44 240 52 200 Q50 250 48 300Z"/><path d="M372 300 Q380 230 396 196 Q392 250 390 300Z"/></g>
<g fill="#fff" opacity=".35"><circle cx="54" cy="110" r="3"/><circle cx="48" cy="88" r="2"/><circle cx="52" cy="70" r="1.5"/></g>
${fishSVG(species, seed).replace('<svg class="fishsvg ', '<svg x="34" y="60" width="340" height="180" class="fishsvg ')}</svg>`;
}

/* ---------------- brand: cowboy in a pink hat + copyright ---------------- */
const COPYRIGHT = '© blagit fugdeit wingit apps.com';
function cowboySVG(cls = '') {
  const id = 'cb' + (++artN);
  return `<svg class="cowboy ${cls}" viewBox="0 0 120 132" role="img" aria-label="Cowboy in a pink hat"><defs>
<linearGradient id="${id}h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff7cc6"/><stop offset=".45" stop-color="#ff1493"/><stop offset="1" stop-color="#b80f6e"/></linearGradient>
<linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5cb4"/><stop offset="1" stop-color="#c2107a"/></linearGradient>
<radialGradient id="${id}f" cx=".45" cy=".4" r=".7"><stop offset="0" stop-color="#ffdcb4"/><stop offset=".7" stop-color="#f3c08e"/><stop offset="1" stop-color="#d89a68"/></radialGradient>
<linearGradient id="${id}d" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a8ac8"/><stop offset="1" stop-color="#2e5a94"/></linearGradient>
<radialGradient id="${id}s"><stop offset="0" stop-color="#fff3a8"/><stop offset=".6" stop-color="#ffd23a"/><stop offset="1" stop-color="#c8961a"/></radialGradient>
<pattern id="${id}p" width="7" height="7" patternUnits="userSpaceOnUse"><rect width="7" height="7" fill="#d62828"/><circle cx="2" cy="2" r="1.2" fill="#fff"/><circle cx="5.5" cy="5.5" r="1.2" fill="#fff"/></pattern></defs>
<path d="M14 132 C16 112 30 102 60 100 C90 102 104 112 106 132Z" fill="url(#${id}d)"/>
<path d="M14 132 C16 114 26 106 40 102 L48 132Z M106 132 C104 114 94 106 80 102 L72 132Z" fill="#6b3e1f"/>
<path d="M40 102 L48 132 M80 102 L72 132" stroke="#4a2810" stroke-width="1.5"/>
<path d="M88 117 l2.2 4.6 5 .6 -3.7 3.4 1 5 -4.5 -2.5 -4.5 2.5 1 -5 -3.7 -3.4 5 -.6Z" fill="url(#${id}s)" stroke="#a87810" stroke-width=".8"/>
<path d="M50 92 h20 v12 h-20Z" fill="#e8ae7c"/>
<path d="M38 98 L82 98 L60 120Z" fill="url(#${id}p)" stroke="#a01818" stroke-width="1"/>
<path d="M54 98 q6 8 12 0" fill="#b81e1e"/>
<ellipse cx="34" cy="70" rx="6" ry="8" fill="#eab084"/><ellipse cx="86" cy="70" rx="6" ry="8" fill="#eab084"/>
<path d="M36 62 C36 40 84 40 84 62 C84 86 74 98 60 98 C46 98 36 86 36 62Z" fill="url(#${id}f)"/>
<ellipse cx="46" cy="78" rx="5" ry="3" fill="#ff8aa0" opacity=".35"/><ellipse cx="74" cy="78" rx="5" ry="3" fill="#ff8aa0" opacity=".35"/>
<path d="M44 60 q5 -4 10 0" stroke="#5a3418" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M66 58 q5 -3 10 1" stroke="#5a3418" stroke-width="2.2" fill="none" stroke-linecap="round"/>
<ellipse cx="49" cy="66" rx="3.6" ry="4.2" fill="#fff"/><circle cx="49.6" cy="66.6" r="2.6" fill="#2a1a0e"/><circle cx="50.6" cy="65.4" r=".9" fill="#fff"/>
<path d="M66 67 q5 4 10 0" stroke="#2a1a0e" stroke-width="2.2" fill="none" stroke-linecap="round"/>
<ellipse cx="60" cy="74" rx="4" ry="3.4" fill="#e09a6a"/>
<path d="M60 80 C54 77 46 79 42 82 C38 84 36 80 39 78 C36 82 42 85 46 83 C51 81 56 82 60 84 C64 82 69 81 74 83 C78 85 84 82 81 78 C84 80 82 84 78 82 C74 79 66 77 60 80Z" fill="#6b3a16"/>
<path d="M48 86 Q60 96 72 86 Q60 90 48 86Z" fill="#8a2a1a"/><path d="M50 86.6 Q60 90 70 86.6 L69 88.4 Q60 91 51 88.4Z" fill="#fff"/>
<path d="M4 50 C2 40 12 40 22 46 C34 52 86 52 98 46 C108 40 118 40 116 50 C112 58 96 60 60 60 C24 60 8 58 4 50Z" fill="url(#${id}b)" stroke="#8a0a52" stroke-width="1.2"/>
<path d="M30 50 C27 32 32 14 42 10 C48 8 52 14 60 14 C68 14 72 8 78 10 C88 14 93 32 90 50 C80 54 40 54 30 50Z" fill="url(#${id}h)" stroke="#8a0a52" stroke-width="1.2"/>
<path d="M60 15 C58 24 58 34 60 44" stroke="#a00c5e" stroke-width="1.6" fill="none" opacity=".7"/>
<path d="M38 18 C36 26 36 34 38 42" stroke="#fff" stroke-width="3" opacity=".45" fill="none" stroke-linecap="round"/>
<path d="M30 44 C44 48 76 48 90 44 L90.6 51 C76 55 44 55 29.6 51Z" fill="#5a3418"/>
${[36, 46, 56, 66, 76, 86].map(x => `<circle cx="${x}" cy="${49 + Math.abs(x - 61) * .02}" r="1.6" fill="url(#${id}s)" stroke="#a87810" stroke-width=".4"/>`).join('')}
<path d="M10 48 C20 54 40 56 60 56" stroke="#fff" stroke-width="2" opacity=".35" fill="none" stroke-linecap="round"/>
</svg>`;
}
const brandFoot = (extra = '') => `<footer class="brandfoot ${extra}">${cowboySVG()}<b>${COPYRIGHT}</b></footer>`;

if (DEMO) window.__fish = { fishSVG, fishArt, SPECIES_DATA };
const pines = (n, y0, h, col, seed) => { const r = rng(seed); let s = ''; for (let i = 0; i < n; i++) { const x = i * 400 / n + r() * 12, hh = h * (.6 + r() * .6); s += `<path d="M${x - hh * .22} ${y0} L${x} ${y0 - hh} L${x + hh * .22} ${y0}Z"/>`; } return `<g fill="${col}">${s}<rect x="0" y="${y0 - 2}" width="400" height="8"/></g>`; };
const HERO_SVG = `<svg class="scene" viewBox="0 0 400 300" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><defs>
<linearGradient id="hs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2e2a20"/><stop offset=".45" stop-color="#8d6c3e"/><stop offset=".62" stop-color="#e9b86c"/><stop offset=".66" stop-color="#f6d695"/></linearGradient>
<linearGradient id="hw" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e7b56a"/><stop offset=".3" stop-color="#7a6238"/><stop offset="1" stop-color="#16130d"/></linearGradient>
<radialGradient id="hg"><stop offset="0" stop-color="#fff3d0"/><stop offset=".35" stop-color="#ffd98a" stop-opacity=".8"/><stop offset="1" stop-color="#f2a541" stop-opacity="0"/></radialGradient>
<filter id="hb"><feGaussianBlur stdDeviation="5"/></filter>
<linearGradient id="hj" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6b5a40"/><stop offset="1" stop-color="#2a241a"/></linearGradient></defs>
<rect width="400" height="180" fill="url(#hs)"/>
<circle cx="250" cy="160" r="80" fill="url(#hg)"/><circle cx="250" cy="162" r="20" fill="#fff4d6"/>
${pines(22, 168, 34, '#9a8058', 'a')}${pines(16, 172, 46, '#5b4a32', 'b')}
<rect y="170" width="400" height="130" fill="url(#hw)"/>
<g fill="#ffe2a0" opacity=".55"><rect x="232" y="176" width="36" height="2" rx="1"/><rect x="238" y="184" width="26" height="2" rx="1"/><rect x="242" y="193" width="18" height="2" rx="1"/><rect x="245" y="203" width="12" height="2" rx="1"/></g>
<g filter="url(#hb)" fill="#f7dcaa" opacity=".55"><rect x="-20" y="158" width="440" height="16" rx="8"/><rect x="40" y="186" width="300" height="10" rx="5" opacity=".6"/></g>
<g class="ghost" opacity=".28"><path d="M0 0 C10 -8 34 -9 48 -2 L56 -8 L54 0 L56 8 L48 2 C34 9 10 8 0 0Z" fill="#0d0b07" transform="translate(0 248)"/></g>
<g class="bob"><ellipse class="rip r1" cx="300" cy="226" rx="14" ry="3" fill="none" stroke="#ffe2a0" stroke-opacity=".55"/><ellipse class="rip r2" cx="300" cy="226" rx="14" ry="3" fill="none" stroke="#ffe2a0" stroke-opacity=".55"/>
<rect x="297" y="210" width="6" height="16" rx="3" fill="#ff6b1a"/><rect x="297" y="220" width="6" height="6" fill="#f4efe2"/></g>
<path d="M300 210 Q200 110 62 52" stroke="#f4efe2" stroke-opacity=".3" stroke-width=".8" fill="none"/>
<path d="M150 300 L188 196 L212 196 L250 300Z" fill="url(#hj)"/>
<g stroke="#1b170f" stroke-width="1.4">${[200, 206, 213, 221, 231, 243, 258, 276, 297].map(yy => { const t = (yy - 196) / 104; return `<line x1="${188 - 38 * t}" y1="${yy}" x2="${212 + 38 * t}" y2="${yy}"/>`; }).join('')}</g>
<g fill="#2a2116"><rect x="185" y="186" width="4" height="16"/><rect x="211" y="186" width="4" height="16"/><rect x="146" y="262" width="8" height="38"/><rect x="246" y="262" width="8" height="38"/></g>
<path d="M62 52 L28 300" stroke="#1b170f" stroke-width="4" stroke-linecap="round"/>
<g fill="#1b170f"><path d="M0 300 Q6 236 4 190 Q12 240 14 300Z"/><path d="M16 300 Q28 246 34 214 Q32 250 30 300Z"/><path d="M372 300 Q382 232 392 206 Q388 250 386 300Z"/><path d="M386 300 Q394 250 400 230 V300Z"/><path d="M356 300 Q362 260 366 244 Q368 266 366 300Z"/></g>
</svg>`;

function introHTML() {
  const school = [['Pike', 16, 10.4, .2, false, 1.25], ['Mirror carp', 42, 9.2, .9, true, 1.1], ['Perch', 64, 7.6, .4, false, .75], ['Brown trout', 28, 9.6, 1.8, true, .85], ['Roach', 76, 7.2, 1.2, true, .6], ['Tench', 54, 8.8, 2.6, false, .7]];
  return `<div class="intro" id="intro" role="presentation">
    <div class="rays"></div>
    ${[...Array(12)].map((_, i) => `<i class="bub" style="left:${(i * 37) % 100}%;animation-delay:${(i % 5) * .5}s;--s:${4 + (i % 4) * 3}px"></i>`).join('')}
    ${school.map(([k, top, dur, delay, ltr, sc]) => `<div class="swim ${ltr ? 'ltr' : ''}" style="top:${top}%;--dur:${dur}s;--del:${delay}s;--sc:${sc}">${fishSVG(k, k + top)}</div>`).join('')}
    <div class="weed">${HERO_WEED}</div>
    <div class="intro-t"><span class="hand">${esc(settings.name)}'s</span><b class="display">Catch Log</b><span class="hand small">Early mornings. Quiet waters. Big memories.</span></div>
    ${brandFoot('intro-brand')}
  </div>`;
}
const HERO_WEED = `<svg viewBox="0 0 400 120" preserveAspectRatio="none" aria-hidden="true"><g fill="#141a0e">${[...Array(26)].map((_, i) => { const x = i * 16 + (i % 3) * 4, h = 50 + (i * 37 % 60); return `<path d="M${x} 120 Q${x - 8} ${120 - h / 2} ${x + 3} ${120 - h} Q${x + 6} ${120 - h / 2} ${x + 6} 120Z"/>`; }).join('')}</g></svg>`;
function playIntro() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  $('#intro')?.remove();
  document.body.insertAdjacentHTML('beforeend', introHTML());
  const el = $('#intro');
  const done = () => { if (!el.isConnected) return; el.classList.add('out'); setTimeout(() => el.remove(), 600); };
  el.addEventListener('click', done);
  setTimeout(done, 7200);
}

const ICON = {
  temp: 'M10 13.5V5a2 2 0 1 1 4 0v8.5a4 4 0 1 1-4 0z', wind: 'M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h8',
  gauge: 'M12 14l4-5M4 16a8 8 0 1 1 16 0', cloud: 'M7 18a4 4 0 0 1-.5-8 6 6 0 0 1 11.5 2 3 3 0 0 1 0 6z', rain: 'M8 19l-1 2M12 19l-1 2M16 19l-1 2M7 16a4 4 0 0 1-.5-8 6 6 0 0 1 11.5 2 3 3 0 0 1 0 6z',
  moon: 'M20 14A8 8 0 1 1 10 4a7 7 0 0 0 10 10z', drop: 'M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z', pin: 'M12 21s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12zM12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
  rod: 'M3 21L20 4M20 4v9', reel: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h6', line: 'M4 20C10 14 14 10 20 4', hook: 'M14 3v11a4 4 0 0 1-8 0v-2l3 2', rig: 'M5 4h14M12 4v9M9 13h6l-3 7z',
  bait: 'M12 20a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM9 11h.01M14 14h.01M13 9h.01', clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2', ruler: 'M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2',
  scale: 'M5 8h14l-2 12H7zM9 8a3 3 0 0 1 6 0', target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01', flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9h.01'
};
const ico = n => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[n]}"/></svg>`;

/* ---------------- badges ---------------- */
const LB = 453.59237;
const BADGES = [
  ['First fish', '1', 'Log your first catch', s => s.n >= 1],
  ['Ten up', '10', 'Log 10 fish', s => s.n >= 10],
  ['Half century', '50', 'Log 50 fish', s => s.n >= 50],
  ['Century club', '100', 'Log 100 fish', s => s.n >= 100],
  ['Double figures', '10lb', 'Land a fish over 10lb', s => s.max >= 10 * LB],
  ['20lb club', '20lb', 'Land a fish over 20lb', s => s.max >= 20 * LB],
  ['Monster', '30lb', 'Land a fish over 30lb', s => s.max >= 30 * LB],
  ['Mixed bag', '3', 'Catch 3 different species', s => s.sp >= 3],
  ['Species hunter', '10', 'Catch 10 different species', s => s.sp >= 10],
  ['Predator', 'P', 'Catch a pike or zander', s => s.pred],
  ['Dawn raider', 'AM', 'Catch one before 7am', s => s.dawn],
  ['Night owl', 'PM', 'Catch one after 9pm', s => s.night],
  ['Storm chaser', 'R', 'Catch one in the rain', s => s.rain],
  ['Frost bite', '3°', 'Catch one at 3°C or colder', s => s.frost],
  ['Explorer', '3V', 'Catch fish at 3 venues', s => s.ven >= 3]
];
function badgeState(list = catches) {
  const hr = c => +(c.caughtAt || '').slice(11, 13);
  const s = {
    n: list.length, max: Math.max(0, ...list.map(c => c.weightG || 0)), sp: new Set(list.map(c => c.species).filter(x => x && x !== 'Unknown')).size,
    ven: new Set(list.map(c => (c.venue || '').toLowerCase()).filter(Boolean)).size,
    pred: list.some(c => /pike|zander/i.test(c.species)), dawn: list.some(c => hr(c) >= 3 && hr(c) < 7), night: list.some(c => hr(c) >= 21 || hr(c) < 3),
    rain: list.some(c => /rain|shower|drizzle|thunder/i.test(c.weather?.conditions || '') || c.weather?.rainMm > 0), frost: list.some(c => c.weather?.tempC != null && c.weather.tempC <= 3)
  };
  return BADGES.map(([name, glyph, hint, test]) => ({ name, glyph, hint, got: test(s) }));
}
const medal = (b, big) => `<div class="medal ${b.got ? 'got' : ''} ${big ? 'big' : ''}"><svg viewBox="0 0 60 60" aria-hidden="true"><circle class="m1" cx="30" cy="30" r="28"/><circle class="m2" cx="30" cy="30" r="22.5"/></svg><span>${esc(b.glyph)}</span></div>`;
function nextTarget() {
  if (!catches.length) return 'Log your first fish and start the collection.';
  const top = catches.reduce((a, c) => (c.weightG || 0) > (a.weightG || 0) ? c : a, catches[0]);
  const next = badgeState().find(b => !b.got);
  return next ? `Next badge: <b>${esc(next.name)}</b>. ${esc(next.hint)}.` : `Beat your <b>${fmtWeight(top.weightG)} ${esc(top.species)}</b>.`;
}

function celebrate({ pb, badges, c }) {
  if (!pb && !badges.length) return;
  const el = document.createElement('div');
  el.className = 'party';
  el.innerHTML = `<div class="party-in">
    ${[...Array(14)].map((_, i) => `<i style="--a:${i * 360 / 14}deg;--d:${(i % 3) * 0.08}s"></i>`).join('')}
    ${pb ? `<p class="kick">${pb === 'first' ? 'First ' + esc(c.species) + '!' : 'New personal best'}</p><div class="party-w">${fmtWeight(c.weightG)}</div><p class="party-s">${esc(c.species)}</p>` : `<p class="kick">Badge unlocked</p>`}
    ${badges.length ? `<div class="party-b">${badges.map(b => `<div>${medal({ ...b, got: true }, true)}<span>${esc(b.name)}</span></div>`).join('')}</div>` : ''}
    <button class="btn alt" type="button">Tight lines!</button></div>`;
  document.body.appendChild(el);
  $('button', el).onclick = () => el.remove();
}


/* ---------------- photos ---------------- */
function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
async function resizeImage(file, max = 1800, q = 0.85) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { const u = URL.createObjectURL(file); src = await loadImg(u); URL.revokeObjectURL(u); }
  const w = src.width, h = src.height, k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', q));
}

/* ---------------- map snapshot (the saved map image) ---------------- */
function loadTile(z, x, y) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    const t = setTimeout(() => rej(new Error('timeout')), 10000);
    i.onload = () => { clearTimeout(t); res(i); };
    i.onerror = () => { clearTimeout(t); rej(new Error('tile')); };
    i.src = `${TILE_URL}${z}/${y}/${x}`;
  });
}
function drawPin(g, x, y) {
  g.save();
  g.fillStyle = '#ff6b1a'; g.strokeStyle = '#fff'; g.lineWidth = 4;
  g.beginPath(); g.moveTo(x, y); g.lineTo(x - 17, y - 30); g.arc(x, y - 38, 19, Math.PI * 0.82, Math.PI * 0.18); g.closePath();
  g.fill(); g.stroke();
  g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y - 38, 7, 0, Math.PI * 2); g.fill();
  g.restore();
}
function caption(g, W, H, c) {
  g.fillStyle = 'rgba(7,26,30,.82)'; g.fillRect(0, H - 64, W, 64);
  g.fillStyle = '#fff'; g.font = '700 24px system-ui,sans-serif';
  g.fillText(`${c.species || 'Fish'}  ${fmtWeight(c.weightG)}`.trim(), 18, H - 34);
  g.font = '16px system-ui,sans-serif'; g.fillStyle = '#cfe2e3';
  g.fillText(`${[c.venue, c.swim].filter(Boolean).join(' · ')}  ${fmtDay(c.caughtAt)}  ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`, 18, H - 12);
}
async function demoSnapshot(c) {
  const W = 800, H = 520, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const img = await loadImg(LAKE_URL);
  const k = 1.5 * W / LAKE.W;
  const px = (c.lng - LAKE.w) / (LAKE.e - LAKE.w) * LAKE.W * k, py = (LAKE.n - c.lat) / (LAKE.n - LAKE.s) * LAKE.H * k;
  g.fillStyle = '#6f8a3e'; g.fillRect(0, 0, W, H);
  g.drawImage(img, W / 2 - px, H / 2 - py, LAKE.W * k, LAKE.H * k);
  drawPin(g, W / 2, H / 2);
  caption(g, W, H, c);
  return new Promise(r => cv.toBlob(r, 'image/jpeg', 0.86));
}
async function makeSnapshot(c) {
  if (DEMO) return demoSnapshot(c);
  const W = 800, H = 520, z = Math.max(12, Math.min(18, Math.round(c.zoom || 17)));
  const n = 2 ** z, lr = c.lat * Math.PI / 180;
  const px = (c.lng + 180) / 360 * n * 256;
  const py = (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n * 256;
  const x0 = px - W / 2, y0 = py - H / 2;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const jobs = [];
  for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + W) / 256); tx++)
    for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + H) / 256); ty++)
      jobs.push(loadTile(z, ((tx % n) + n) % n, ty).then(img => g.drawImage(img, tx * 256 - x0, ty * 256 - y0)));
  await Promise.all(jobs);
  drawPin(g, W / 2, H / 2);
  caption(g, W, H, c);
  g.font = '12px system-ui,sans-serif'; g.fillStyle = 'rgba(255,255,255,.75)'; g.textAlign = 'right';
  g.fillText('Imagery © Esri, Maxar', W - 10, 18);
  return new Promise((res, rej) => { try { cv.toBlob(b => b ? res(b) : rej(new Error('blob')), 'image/jpeg', 0.86); } catch (e) { rej(e); } });
}
// No signal? Draw a plain chart card now and swap in the satellite image later.
function plainSnapshot(c) {
  const W = 800, H = 520, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#14535e'; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
  for (let x = 0; x < W; x += 40) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let y = 0; y < H; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  g.fillStyle = 'rgba(255,255,255,.7)'; g.font = '15px system-ui,sans-serif';
  g.fillText('Satellite image will be added when you have signal', 18, 30);
  drawPin(g, W / 2, H / 2 - 20);
  caption(g, W, H, c);
  return new Promise(r => cv.toBlob(r, 'image/jpeg', 0.86));
}
async function updateSnapshot(c) {
  if (c.lat == null) return;
  try {
    if (!DEMO && !navigator.onLine) throw new Error('offline');
    const b = await makeSnapshot(c);
    c.mapImg = await saveBlob(b, c.mapImg || uid());
    if (c.pending) c.pending.map = false;
  } catch {
    if (!c.mapImg) c.mapImg = await saveBlob(await plainSnapshot(c));
    c.pending = { ...(c.pending || {}), map: true };
  }
}

/* ---------------- weather (Open-Meteo, free, no key) ---------------- */
function dayShift(day, d) { const t = new Date(day + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); }
async function fetchWeather(lat, lng, when) {
  if (DEMO) {
    await new Promise(r => setTimeout(r, 600));
    const d = new Date(when), mo = d.getMonth(), hr = d.getHours();
    const base = [5, 6, 8, 11, 14, 17, 19, 19, 16, 12, 8, 6][mo] + (hr > 10 && hr < 18 ? 3 : -1);
    const r = (a, b) => a + Math.random() * (b - a);
    const code = [0, 1, 2, 3, 61, 80][Math.floor(r(0, 6))];
    const p = Math.round(r(998, 1026));
    return { tempC: +base.toFixed(1), humidity: Math.round(r(60, 95)), rainMm: code >= 61 ? +r(0.2, 2).toFixed(1) : 0, cloud: Math.round(code ? r(30, 100) : r(0, 20)),
      pressure: p, trend: ['Rising', 'Steady', 'Falling'][Math.floor(r(0, 3))], windKph: Math.round(r(5, 30)), windDir: COMPASS[Math.floor(r(0, 16))], gustKph: Math.round(r(25, 50)),
      conditions: WX[code], source: 'auto', demo: true, fetchedAt: new Date().toISOString() };
  }
  const day = when.slice(0, 10);
  const age = (Date.now() - new Date(when)) / 864e5;
  if (age < -7) throw new Error('That date is too far ahead');
  const vars = 'temperature_2m,relative_humidity_2m,precipitation,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code';
  const base = age > 60 ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';
  const url = `${base}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&hourly=${vars}&start_date=${dayShift(day, -1)}&end_date=${day}&timezone=auto`;
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.reason || 'Weather service error');
  const h = j.hourly, i = h.time.indexOf(when.slice(0, 13) + ':00');
  if (i < 0 || h.temperature_2m[i] == null) throw new Error('No weather for that hour yet');
  const p = h.pressure_msl[i], p3 = h.pressure_msl[i - 3];
  const diff = p != null && p3 != null ? p - p3 : 0;
  return {
    tempC: h.temperature_2m[i], humidity: h.relative_humidity_2m[i], rainMm: h.precipitation[i], cloud: h.cloud_cover[i],
    pressure: p != null ? Math.round(p) : null, trend: diff > 1 ? 'Rising' : diff < -1 ? 'Falling' : 'Steady',
    windKph: h.wind_speed_10m[i], windDir: compass(h.wind_direction_10m[i]), gustKph: h.wind_gusts_10m[i],
    conditions: WX[h.weather_code[i]] || '', source: 'auto', fetchedAt: new Date().toISOString()
  };
}
const mph = kph => kph == null ? null : Math.round(kph / 1.609344);
function wxLine(w) {
  if (!w) return '';
  return [w.tempC != null && `${Math.round(w.tempC)}°C`, w.conditions,
    w.windKph != null && `${w.windDir || ''} ${mph(w.windKph)} mph${w.gustKph ? ` (gusts ${mph(w.gustKph)})` : ''}`.trim(),
    w.pressure && `${w.pressure} hPa ${w.trend ? w.trend.toLowerCase() : ''}`.trim()].filter(Boolean).join(' · ');
}

let busy = false;
async function processPending() {
  if (busy || !navigator.onLine) return;
  busy = true;
  let done = 0;
  try {
    for (const c of catches.filter(c => c.pending && (c.pending.map || c.pending.weather) && c.lat != null)) {
      if (c.pending.weather) {
        try { c.weather = { ...await fetchWeather(c.lat, c.lng, c.caughtAt), ...stripEmpty(c.weather) }; c.pending.weather = false; } catch {}
      }
      if (c.pending.map) await updateSnapshot(c);
      await saveCatch(c);
      done++;
    }
  } finally { busy = false; }
  return done;
}
const stripEmpty = o => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== null && v !== '' && v !== undefined));

/* ---------------- views ---------------- */
function bestBySpecies() {
  const best = {};
  for (const c of catches) if (c.weightG && (!best[c.species] || c.weightG > best[c.species].weightG)) best[c.species] = c;
  return best;
}

function listView() {
  const best = bestBySpecies();
  const top = catches.reduce((a, c) => (c.weightG || 0) > (a?.weightG || 0) ? c : a, null);
  const species = [...new Set(catches.map(c => c.species).filter(Boolean))];
  const since = catches.length - (settings.catchesAtBackup || 0);
  const needBackup = !DEMO && catches.length && since > 0 && (!settings.lastBackup || Date.now() - new Date(settings.lastBackup) > 14 * 864e5 || since >= 10);
  const hr = new Date().getHours();
  const hi = hr < 5 ? 'Night session' : hr < 12 ? 'Morning' : hr < 18 ? 'Afternoon' : 'Evening';
  const got = badgeState().filter(b => b.got).length;
  view.innerHTML = `
    <section class="hero">${HERO_SVG}
      <div class="hero-in">
        <p class="kick hand">${hi}, ${esc(settings.name)}. Tight lines.</p>
        <h1 class="display">Catch Log</h1>
        <div class="hstats">
          <div><b>${catches.length}</b><span>Fish</span></div>
          <div><b>${top?.weightG ? fmtWeight(top.weightG) : '—'}</b><span>Biggest</span></div>
          <div><b>${species.length}</b><span>Species</span></div>
          <div><b>${got}</b><span>Badges</span></div>
        </div>
      </div>
    </section>
    <a class="target" href="#stats">${ico('target')}<span>${nextTarget()}</span></a>
    ${needBackup ? `<div class="banner"><p><b>${since} catch${since > 1 ? 'es' : ''} not backed up.</b> Save a backup so a lost phone never means lost fish.</p><a class="btn alt small" href="#settings">Back up</a></div>` : ''}
    ${catches.length ? `
      <div class="searchrow"><input class="search" id="q" type="search" placeholder="Search species, venue, bait, rig…" aria-label="Search catches"></div>
      <div class="chips" id="chips"><button class="chip on" data-s="">All</button>${species.map(s => `<button class="chip" data-s="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      <div class="cards" id="cards"></div>` :
      `<div class="empty">${fishArt('Mirror carp', 'empty')}<h2 class="display">Your first fish is out there</h2><p>When you land one, tap <b>Log catch</b>. Snap the photo, drop the pin where you hooked it, and the weather fills itself in.</p><a class="btn alt" href="#add">Log your first catch</a></div>`}
    ${brandFoot()}`;
  if (!catches.length) return;
  let filt = '';
  const draw = () => {
    const q = ($('#q').value || '').toLowerCase();
    const list = catches.filter(c => (!filt || c.species === filt) &&
      (!q || [c.species, c.venue, c.swim, c.bait, c.notes, ...Object.values(c.gear || {})].join(' ').toLowerCase().includes(q)));
    $('#cards').innerHTML = list.length ? list.map(c => {
      const pb = best[c.species]?.id === c.id && c.weightG;
      return `<a class="card ${pb ? 'is-pb' : ''}" href="#catch-${c.id}"><span class="tape"></span>
        <div class="ph" data-img="${c.photos?.[0] || ''}">${c.photos?.length ? '' : fishArt(c.species, c.id)}</div>
        ${pb ? '<span class="pb">PB</span>' : ''}
        <div class="tx">
          <div class="row1"><span class="w display">${fmtWeight(c.weightG)}</span><span class="hand">${fmtDay(c.caughtAt)}</span></div>
          <span class="sp">${esc(c.species || 'Unknown')}</span>
          <span class="meta">${esc([c.venue, c.swim].filter(Boolean).join(' · '))}</span>
          <span class="pills">${c.bait ? `<i>${ico('bait')}${esc(c.bait)}</i>` : ''}${c.weather?.tempC != null ? `<i>${ico('temp')}${Math.round(c.weather.tempC)}°C</i>` : ''}${c.weather?.trend ? `<i>${ico('gauge')}${esc(c.weather.trend)}</i>` : ''}</span>
        </div></a>`;
    }).join('') : '<p class="empty">No catches match that.</p>';
    $$('.ph[data-img]').forEach(async el => { if (!el.dataset.img) return; const u = await blobUrl(el.dataset.img); if (u) el.style.backgroundImage = `url(${u})`; });
  };
  $('#q').oninput = draw;
  $('#chips').onclick = e => {
    const b = e.target.closest('.chip'); if (!b) return;
    filt = b.dataset.s; $$('.chip').forEach(x => x.classList.toggle('on', x === b)); draw();
  };
  draw();
}


function opts(list) { return [...new Set(list)].map(v => `<option value="${esc(v)}">`).join(''); }

async function formView(id) {
  const old = id ? catches.find(c => c.id === id) : null;
  if (id && !old) { location.hash = '#list'; return; }
  const c = old ? JSON.parse(JSON.stringify(old)) : { id: uid(), createdAt: new Date().toISOString(), caughtAt: nowLocal(), photos: [], gear: {}, weather: {}, released: true };
  const last = catches.find(x => x.id !== c.id);
  const imp = settings.units !== 'metric';
  let lb = '', oz = '', kg = '';
  if (c.weightG) {
    if (imp) { let t = Math.round(c.weightG / G_PER_OZ * 4) / 4; lb = Math.floor(t / 16); oz = +(t - lb * 16).toFixed(2); }
    else kg = (c.weightG / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }
  const len = c.lengthMm ? (imp ? +(c.lengthMm / 25.4).toFixed(1) : +(c.lengthMm / 10).toFixed(1)) : '';
  const w = c.weather || {};
  const g = c.gear || {};
  view.innerHTML = `
  <form id="f" novalidate>
    <div class="headrow"><h1 class="display pagehead">${old ? 'Edit catch' : 'Log a catch'}</h1><button class="btn alt small" type="submit">Save</button></div>
    <section>
      <h2>Photos</h2>
      <div class="photos" id="photos"></div>
    </section>
    <section>
      <h2>The fish</h2>
      <div class="grid2">
        <div class="full spfield"><label>Species<input name="species" list="dl-sp" value="${esc(c.species)}" placeholder="e.g. Mirror carp" autocomplete="off"></label>
          <button type="button" class="btn small" id="spPick">Choose from all ${SPECIES.length}</button>
          <div class="spprev" id="spPrev"></div></div>
        ${imp ? `<label class="unit">Weight<input name="lb" type="number" inputmode="numeric" min="0" step="1" value="${lb}"><i>lb</i></label>
                 <label class="unit">&nbsp;<input name="oz" type="number" inputmode="decimal" min="0" max="15.99" step="0.25" value="${oz}" aria-label="ounces"><i>oz</i></label>`
              : `<label class="unit full">Weight<input name="kg" type="number" inputmode="decimal" min="0" step="0.01" value="${kg}"><i>kg</i></label>`}
        <label class="unit">Length<input name="len" type="number" inputmode="decimal" min="0" step="0.1" value="${len}"><i>${imp ? 'in' : 'cm'}</i></label>
        <label class="check" style="align-self:end;padding-bottom:10px"><input type="checkbox" name="released" ${c.released ? 'checked' : ''}>Released</label>
      </div>
    </section>
    <section>
      <h2>When &amp; where</h2>
      <div class="grid2">
        <label class="full">Date &amp; time caught<input name="caughtAt" type="datetime-local" value="${esc(c.caughtAt)}"></label>
        <label>Venue<input name="venue" list="dl-venue" value="${esc(c.venue)}" placeholder="Lake or river" autocomplete="off"></label>
        <label>Swim / peg<input name="swim" list="dl-swim" value="${esc(c.swim)}" autocomplete="off"></label>
      </div>
      <div class="pickmap" id="pickmap"></div>
      <div class="row"><button type="button" class="btn small" id="gps">Use my location</button><button type="button" class="btn ghost small" id="clearpin" ${c.lat == null ? 'hidden' : ''}>Remove pin</button></div>
      <p class="hint" id="pinInfo">Tap the map to drop the pin where the fish was hooked. Drag it to fine-tune.</p>
    </section>
    <section>
      <h2>Gear &amp; bait ${last ? '<button type="button" class="btn ghost small" id="copyGear">Same as last fish</button>' : ''}</h2>
      <div class="grid2">
        <label>Rod<input name="rod" list="dl-rod" value="${esc(g.rod)}" autocomplete="off"></label>
        <label>Reel<input name="reel" list="dl-reel" value="${esc(g.reel)}" autocomplete="off"></label>
        <label>Line<input name="line" list="dl-line" value="${esc(g.line)}" placeholder="e.g. 12lb mono" autocomplete="off"></label>
        <label>Hook<input name="hook" list="dl-hook" value="${esc(g.hook)}" placeholder="e.g. Size 6 curve" autocomplete="off"></label>
        <label>Rig<input name="rig" list="dl-rig" value="${esc(g.rig)}" autocomplete="off"></label>
        <label>Method<input name="method" list="dl-method" value="${esc(g.method)}" autocomplete="off"></label>
        <label class="full">Bait<input name="bait" list="dl-bait" value="${esc(c.bait)}" placeholder="e.g. 15mm pineapple pop-up" autocomplete="off"></label>
      </div>
    </section>
    <section>
      <h2>Weather <button type="button" class="btn ghost small" id="getWx">Fill in automatically</button></h2>
      <p class="status" id="wxStatus">${w.source === 'auto' ? 'Filled from the weather records for that spot and time.' : 'Drop the pin and it fills itself in. You can change anything.'}</p>
      <div class="grid3">
        <label class="unit">Air temp<input name="tempC" type="number" inputmode="decimal" step="0.1" value="${w.tempC ?? ''}"><i>°C</i></label>
        <label>Conditions<input name="conditions" list="dl-cond" value="${esc(w.conditions)}"></label>
        <label class="unit">Cloud<input name="cloud" type="number" inputmode="numeric" min="0" max="100" value="${w.cloud ?? ''}"><i>%</i></label>
        <label class="unit">Wind<input name="wind" type="number" inputmode="numeric" min="0" value="${mph(w.windKph) ?? ''}"><i>mph</i></label>
        <label>Wind from<select name="windDir"><option value=""></option>${COMPASS.map(d => `<option ${w.windDir === d ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
        <label class="unit">Gusts<input name="gust" type="number" inputmode="numeric" min="0" value="${mph(w.gustKph) ?? ''}"><i>mph</i></label>
        <label class="unit">Pressure<input name="pressure" type="number" inputmode="numeric" value="${w.pressure ?? ''}"><i>hPa</i></label>
        <label>Pressure trend<select name="trend"><option value=""></option>${['Rising', 'Steady', 'Falling'].map(t => `<option ${w.trend === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="unit">Rain<input name="rainMm" type="number" inputmode="decimal" min="0" step="0.1" value="${w.rainMm ?? ''}"><i>mm</i></label>
        <label class="unit">Water temp<input name="waterC" type="number" inputmode="decimal" step="0.1" value="${w.waterC ?? ''}"><i>°C</i></label>
      </div>
    </section>
    <section>
      <h2>Notes</h2>
      <textarea name="notes" placeholder="How it fought, what the swim was doing, anything you want to remember">${esc(c.notes)}</textarea>
    </section>
    <div class="savebar"><a class="btn ghost" href="${old ? '#catch-' + c.id : '#list'}">Cancel</a><button class="btn alt" type="submit">Save catch</button></div>
    <datalist id="dl-sp">${opts([...history(x => x.species), ...SPECIES])}</datalist>
    <datalist id="dl-venue">${opts(history(x => x.venue))}</datalist>
    <datalist id="dl-swim">${opts(history(x => x.swim))}</datalist>
    <datalist id="dl-rod">${opts(history(x => x.gear?.rod))}</datalist>
    <datalist id="dl-reel">${opts(history(x => x.gear?.reel))}</datalist>
    <datalist id="dl-line">${opts(history(x => x.gear?.line))}</datalist>
    <datalist id="dl-hook">${opts(history(x => x.gear?.hook))}</datalist>
    <datalist id="dl-rig">${opts([...history(x => x.gear?.rig), ...RIGS])}</datalist>
    <datalist id="dl-method">${opts([...history(x => x.gear?.method), ...METHODS])}</datalist>
    <datalist id="dl-bait">${opts([...history(x => x.bait), ...BAITS])}</datalist>
    <datalist id="dl-cond">${opts(Object.values(WX))}</datalist>
  </form>`;
  const f = $('#f');
  const val = n => f.elements[n].value.trim();

  // species picker
  const prev = () => { const v = val('species'); $('#spPrev').innerHTML = v ? fishSVG(v, v) + `<span>${esc(speciesInfo(v).name === v ? '' : 'Drawn as ' + speciesInfo(v).name)}</span>` : ''; };
  f.elements.species.addEventListener('input', prev); prev();
  $('#spPick').onclick = () => pickSpecies(v => { f.elements.species.value = v; prev(); });
  // photos
  const photos = [...(c.photos || [])].map(id => ({ id }));
  const removed = [];
  const drawPhotos = async () => {
    const el = $('#photos');
    const items = await Promise.all(photos.map(async p => ({ p, u: p.url || await blobUrl(p.id) })));
    el.innerHTML = items.map(({ u }, i) => `<div class="p" style="background-image:url(${u})"><button type="button" data-i="${i}" aria-label="Remove photo">×</button></div>`).join('') +
      `<label class="addphoto cam">${ico('camera')}Take photo<input type="file" accept="image/*" capture="environment" id="pcam"></label>` +
      `<label class="addphoto">${ico('image')}From gallery<input type="file" accept="image/*" multiple id="pfile"></label>`;
    $('#pcam').onchange = $('#pfile').onchange = async e => {
      for (const file of e.target.files) {
        const b = await resizeImage(file);
        photos.push({ id: uid(), blob: b, url: URL.createObjectURL(b) });
      }
      e.target.value = '';
      drawPhotos();
    };
    $$('#photos .p button').forEach(b => b.onclick = () => { const [p] = photos.splice(+b.dataset.i, 1); if (!p.blob) removed.push(p.id); drawPhotos(); });
  };
  drawPhotos();

  // map
  let wxEdited = w.source === 'manual';
  const start = c.lat != null ? [c.lat, c.lng] : last?.lat != null ? [last.lat, last.lng] : DEMO ? [51.123, -3.06] : [54.3, -2.5];
  const m = L.map('pickmap', { tap: true }).setView(start, c.lat != null ? (c.zoom || 17) : last?.lat != null ? 15 : 5);
  maps.push(m);
  satLayer(m);
  let marker = null;
  const info = $('#pinInfo');
  const setPin = (ll, acc, init) => {
    c.lat = +ll.lat.toFixed(6); c.lng = +ll.lng.toFixed(6);
    if (acc != null) c.accuracy = Math.round(acc);
    if (!marker) {
      marker = L.marker(ll, { draggable: true, icon: floatIcon(true) }).addTo(m);
      marker.on('dragend', () => setPin(marker.getLatLng()));
    } else marker.setLatLng(ll);
    info.textContent = `Pinned at ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}${c.accuracy ? ` (GPS ±${c.accuracy} m)` : ''}. Tap or drag to move it.`;
    $('#clearpin').hidden = false;
    if (!init) autoWx();
  };
  m.on('click', e => setPin(e.latlng));
  setTimeout(() => m.invalidateSize(), 50);
  $('#clearpin').onclick = () => { if (marker) m.removeLayer(marker); marker = null; c.lat = c.lng = null; info.textContent = 'Tap the map to drop the pin where the fish was hooked.'; $('#clearpin').hidden = true; };
  const gps = () => {
    if (DEMO) {
      const ll = lakeLL(560 + Math.random() * 120, 300 + Math.random() * 80);
      m.setView(ll, 17); setPin(ll, 6);
      info.textContent += ' (Demo: pretend GPS. The real app uses the phone’s location.)';
      return;
    }
    if (!navigator.geolocation) { info.textContent = 'This phone can’t share its location. Tap the map instead.'; return; }
    info.textContent = 'Finding you…';
    navigator.geolocation.getCurrentPosition(p => {
      const ll = { lat: p.coords.latitude, lng: p.coords.longitude };
      m.setView(ll, 17); setPin(ll, p.coords.accuracy);
    }, () => { info.textContent = 'Couldn’t get your location. Allow location for this app, or tap the map.'; }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  };
  $('#gps').onclick = gps;

  // gear copy
  if ($('#copyGear')) $('#copyGear').onclick = () => {
    for (const k of ['rod', 'reel', 'line', 'hook', 'rig', 'method']) f.elements[k].value = last.gear?.[k] || '';
    f.elements.bait.value = last.bait || '';
    if (!f.elements.venue.value) f.elements.venue.value = last.venue || '';
  };

  // weather
  const wxFields = ['tempC', 'conditions', 'cloud', 'wind', 'windDir', 'gust', 'pressure', 'trend', 'rainMm'];
  wxFields.forEach(n => f.elements[n].addEventListener('input', () => { wxEdited = true; }));
  let wxT;
  const getWx = async manual => {
    const st = $('#wxStatus');
    if (c.lat == null) { st.textContent = 'Drop the pin on the map first.'; return; }
    if (!DEMO && !navigator.onLine) { st.textContent = 'No signal. It will fill in automatically once you’re back online.'; return; }
    st.textContent = 'Getting the weather for that spot and time…';
    try {
      const r = await fetchWeather(c.lat, c.lng, val('caughtAt') || nowLocal());
      f.elements.tempC.value = r.tempC ?? ''; f.elements.conditions.value = r.conditions;
      f.elements.cloud.value = r.cloud ?? ''; f.elements.wind.value = mph(r.windKph) ?? '';
      f.elements.windDir.value = r.windDir || ''; f.elements.gust.value = mph(r.gustKph) ?? '';
      f.elements.pressure.value = r.pressure ?? ''; f.elements.trend.value = r.trend || '';
      f.elements.rainMm.value = r.rainMm ?? '';
      c.weather = { ...c.weather, humidity: r.humidity, source: 'auto', demo: r.demo, fetchedAt: r.fetchedAt };
      wxEdited = false;
      st.textContent = DEMO ? 'Demo: sample weather. The real app pulls the actual weather for that spot and hour.' : 'Filled from the weather records for that spot and time.';
    } catch (e) { st.textContent = (manual ? '' : 'Weather not filled: ') + (e.message || 'try again later'); }
  };
  const autoWx = () => { if (!wxEdited) { clearTimeout(wxT); wxT = setTimeout(() => getWx(false), 700); } };
  f.elements.caughtAt.addEventListener('change', autoWx);
  $('#getWx').onclick = () => { wxEdited = false; getWx(true); };
  if (c.lat != null) setPin({ lat: c.lat, lng: c.lng }, null, true); else if (!old) gps();

  // save
  f.onsubmit = async e => {
    e.preventDefault();
    const btn = $('.savebar button[type=submit]', f); $$('button[type=submit]', f).forEach(b => b.disabled = true); btn.textContent = 'Saving…';
    try {
      const wG = imp ? ((num(val('lb')) || 0) * 16 + (num(val('oz')) || 0)) * G_PER_OZ : (num(val('kg')) || 0) * 1000;
      const l = num(val('len'));
      const before = badgeState().filter(b => b.got).map(b => b.name);
      const moved = !old || old.lat !== c.lat || old.lng !== c.lng || old.species !== val('species') || old.weightG !== Math.round(wG);
      Object.assign(c, {
        species: val('species') || 'Unknown', weightG: wG ? Math.round(wG) : null,
        lengthMm: l ? Math.round(l * (imp ? 25.4 : 10)) : null, released: f.elements.released.checked,
        caughtAt: val('caughtAt') || nowLocal(), venue: val('venue'), swim: val('swim'),
        zoom: m.getZoom(), bait: val('bait'), notes: val('notes'),
        gear: { rod: val('rod'), reel: val('reel'), line: val('line'), hook: val('hook'), rig: val('rig'), method: val('method') },
        moon: moon(val('caughtAt') || nowLocal())
      });
      const kph = v => { const n = num(v); return n == null ? null : Math.round(n * 1.609344 * 10) / 10; };
      c.weather = {
        ...(c.weather || {}), tempC: num(val('tempC')), conditions: val('conditions'), cloud: num(val('cloud')),
        windKph: kph(val('wind')), windDir: val('windDir'), gustKph: kph(val('gust')), pressure: num(val('pressure')),
        trend: val('trend'), rainMm: num(val('rainMm')), waterC: num(val('waterC')),
        source: wxEdited ? 'manual' : (c.weather?.source || (val('tempC') ? 'manual' : ''))
      };
      const wxEmpty = wxFields.every(n => !val(n));
      c.pending = { ...(c.pending || {}), weather: wxEmpty && c.lat != null };
      for (const p of photos) if (p.blob) await saveBlob(p.blob, p.id);
      for (const id of removed) await delOne('blobs', id);
      c.photos = photos.map(p => p.id);
      if (c.lat == null && c.mapImg) { await delOne('blobs', c.mapImg); c.mapImg = null; c.pending.map = false; }
      if (c.lat != null && (moved || !c.mapImg)) await updateSnapshot(c);
      await saveCatch(c);
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      toast(old ? 'Catch updated' : 'Catch saved');
      location.hash = '#catch-' + c.id;
      if (!old) {
        const others = catches.filter(x => x.id !== c.id && x.species === c.species);
        const prev = Math.max(0, ...others.map(x => x.weightG || 0));
        const pb = c.weightG && c.species !== 'Unknown' ? (!others.length ? 'first' : c.weightG > prev ? 'new' : '') : '';
        const fresh = badgeState().filter(b => b.got && !before.includes(b.name));
        setTimeout(() => celebrate({ pb, badges: fresh, c }), 400);
      }
      processPending();
    } catch (err) {
      $$('button[type=submit]', f).forEach(b => b.disabled = false); btn.textContent = 'Save catch';
      toast('Could not save: ' + (err.message || err));
    }
  };
}

function pickSpecies(done) {
  const el = document.createElement('div');
  el.className = 'modal spsheet';
  const groups = [...new Set(SPECIES_DATA.map(s => s[0]))];
  el.innerHTML = `<div class="sheet big" role="dialog" aria-label="Choose species"><div class="row"><h2 class="grow">Choose species</h2><button class="btn ghost small" type="button" data-x>Close</button></div>
    <input type="search" id="spq" placeholder="Search ${SPECIES.length} UK freshwater species" aria-label="Search species">
    <div class="splist" id="splist">${groups.map(g => `<h3 data-g>${esc(g)}</h3><div class="spgrid">${SPECIES_DATA.filter(s => s[0] === g).map(([, n]) => `<button type="button" class="sptile" data-n="${esc(n)}">${fishSVG(n, n)}<span>${esc(n)}</span></button>`).join('')}</div>`).join('')}</div></div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.addEventListener('click', e => {
    if (e.target === el || e.target.closest('[data-x]')) return close();
    const t = e.target.closest('.sptile'); if (t) { done(t.dataset.n); close(); }
  });
  $('#spq', el).oninput = e => {
    const q = e.target.value.toLowerCase();
    $$('.sptile', el).forEach(t => { t.hidden = !t.dataset.n.toLowerCase().includes(q); });
    $$('.spgrid', el).forEach(gd => { gd.previousElementSibling.hidden = gd.hidden = ![...gd.children].some(t => !t.hidden); });
  };
}

async function detailView(id) {
  const c = catches.find(x => x.id === id);
  if (!c) { location.hash = '#list'; return; }
  const best = bestBySpecies()[c.species]?.id === c.id && c.weightG;
  const w = c.weather || {}, g = c.gear || {};
  const fact = (i, k, v) => v ? `<div class="fact">${ico(i)}<div><dt>${k}</dt><dd>${esc(v)}</dd></div></div>` : '';
  const gearFacts = [fact('rod', 'Rod', g.rod), fact('reel', 'Reel', g.reel), fact('line', 'Line', g.line), fact('hook', 'Hook', g.hook), fact('rig', 'Rig', g.rig), fact('flag', 'Method', g.method), fact('bait', 'Bait', c.bait)].join('');
  const wxFacts = [fact('temp', 'Air temp', w.tempC != null && `${w.tempC}°C`), fact('cloud', 'Sky', w.conditions), fact('wind', 'Wind', w.windKph != null && `${w.windDir || ''} ${mph(w.windKph)} mph`.trim()),
    fact('wind', 'Gusts', w.gustKph != null && `${mph(w.gustKph)} mph`), fact('gauge', 'Pressure', w.pressure && `${w.pressure} hPa${w.trend ? ' · ' + w.trend.toLowerCase() : ''}`),
    fact('cloud', 'Cloud', w.cloud != null && `${w.cloud}%`), fact('rain', 'Rain', w.rainMm != null && `${w.rainMm} mm`), fact('drop', 'Humidity', w.humidity != null && `${w.humidity}%`),
    fact('temp', 'Water temp', w.waterC != null && `${w.waterC}°C`), fact('moon', 'Moon', c.moon && `${c.moon.name} · ${c.moon.illum}%`)].join('');
  view.innerHTML = `
    <section class="dhero"><span class="tape"></span>
      <div class="gallery" id="gal">${c.photos?.length ? c.photos.map(p => `<img data-img="${p}" alt="${esc(c.species)}">`).join('') : fishArt(c.species, c.id)}</div>
      <div class="shade"></div>
      ${best ? '<span class="pb big">PB</span>' : ''}
      <div class="dtx">
        <div class="big display">${fmtWeight(c.weightG)}</div>
        <h1 class="display">${esc(c.species)}</h1>
        <p>${fmtDate(c.caughtAt)}${c.released ? ' · <span class="tag">Released</span>' : ''}</p>
      </div>
    </section>
    ${c.photos?.length > 1 ? `<p class="hint center">Swipe for ${c.photos.length - 1} more photo${c.photos.length > 2 ? 's' : ''}</p>` : ''}
    <dl class="facts">${fact('pin', 'Venue', c.venue)}${fact('flag', 'Swim / peg', c.swim)}${fact('ruler', 'Length', c.lengthMm && fmtLength(c.lengthMm))}${fact('scale', 'Weight', c.weightG && (settings.units === 'metric' ? fmtWeight(c.weightG) : `${fmtWeight(c.weightG)} · ${(c.weightG / 1000).toFixed(2)} kg`))}</dl>
    <div class="block"><h2 class="display">The spot</h2>
      ${c.lat != null ? `<div class="snap" id="snap">Making map…</div>
      <div class="row" style="margin-top:12px"><a class="btn small" href="#map-${c.id}">${ico('pin')}Show on my map</a><a class="btn ghost small" href="https://www.google.com/maps?q=${c.lat},${c.lng}" target="_blank" rel="noopener">Open in Google Maps</a></div>
      <p class="hint">${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}${c.accuracy ? ` · GPS ±${c.accuracy} m` : ''}</p>` : '<p class="hint">No pin dropped for this one.</p>'}
    </div>
    ${gearFacts ? `<div class="block"><h2 class="display">What it fell to</h2><dl class="facts">${gearFacts}</dl></div>` : ''}
    <div class="block"><h2 class="display">Conditions</h2>${wxFacts ? `<dl class="facts">${wxFacts}</dl>` : ''}${c.pending?.weather ? '<p class="hint">Weather will fill in automatically when you have signal.</p>' : ''}${w.demo ? '<p class="hint">Sample weather (demo). The real app records the actual weather.</p>' : w.source === 'auto' ? '<p class="hint">From Open-Meteo weather records for that spot and hour.</p>' : ''}</div>
    ${c.notes ? `<div class="block"><h2 class="display">Notes</h2><p class="notes">${esc(c.notes)}</p></div>` : ''}
    <div class="row" style="margin:28px 0 8px"><a class="btn grow" href="#edit-${c.id}">Edit catch</a><button class="btn ghost" id="del">Delete</button></div>`;
  $$('#gal img').forEach(async el => { el.src = await blobUrl(el.dataset.img) || ''; });
  if (c.mapImg && $('#snap')) { const u = await blobUrl(c.mapImg); if (u && $('#snap')) $('#snap').innerHTML = `<img src="${u}" alt="Map with a pin where the ${esc(c.species)} was caught">`; }
  $('#del').onclick = async () => {
    if (!await ask('Delete this catch?', `${c.species} ${fmtWeight(c.weightG)} from ${fmtDay(c.caughtAt)} will be gone for good, photos too.`)) return;
    for (const b of [...(c.photos || []), c.mapImg].filter(Boolean)) await delOne('blobs', b);
    await delOne('catches', c.id);
    catches = catches.filter(x => x.id !== c.id);
    toast('Catch deleted');
    location.hash = '#list';
  };
}


function mapView(focus) {
  view.innerHTML = `<div class="fullmap" id="allmap"></div><p class="hint">${catches.filter(c => c.lat != null).length} pinned catches. Maps you've viewed with signal are kept for offline use.</p>`;
  const m = L.map('allmap').setView(DEMO ? [51.123, -3.06] : [54.3, -2.5], DEMO ? 15 : 5);
  maps.push(m);
  satLayer(m);
  const pts = [];
  let open = null;
  for (const c of catches.filter(c => c.lat != null)) {
    const mk = L.marker([c.lat, c.lng], { icon: floatIcon(false) }).addTo(m)
      .bindPopup(`<a href="#catch-${c.id}">${esc(c.species)} ${fmtWeight(c.weightG)}</a><br>${esc(c.venue || '')}<br>${fmtDay(c.caughtAt)}${c.bait ? '<br>Bait: ' + esc(c.bait) : ''}`);
    pts.push([c.lat, c.lng]);
    if (c.id === focus) open = { mk, c };
  }
  setTimeout(() => {
    m.invalidateSize();
    if (open) { m.setView([open.c.lat, open.c.lng], 17); open.mk.openPopup(); }
    else if (pts.length === 1) m.setView(pts[0], 16);
    else if (pts.length) m.fitBounds(pts, { padding: [40, 40], maxZoom: 17 });
  }, 60);
}

function statsView() {
  const badges = badgeState();
  const got = badges.filter(b => b.got).length;
  const badgeHTML = `<div class="block"><h2 class="display">Badges <small>${got} of ${badges.length}</small></h2>
    <div class="badges">${badges.map(b => `<div class="bdg ${b.got ? 'got' : ''}">${medal(b)}<b>${esc(b.name)}</b><span>${b.got ? 'Unlocked' : esc(b.hint)}</span></div>`).join('')}</div></div>`;
  if (!catches.length) { view.innerHTML = `<h1 class="display pagehead">Trophy room</h1><p class="hint">Log a few fish and your PBs, best baits and best venues show up here.</p>${badgeHTML}`; return; }
  const total = catches.reduce((a, c) => a + (c.weightG || 0), 0);
  const best = bestBySpecies();
  const count = key => { const m = {}; for (const c of catches) { const k = key(c); if (k) m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const bars = (rows, alt) => rows.length ? `<div class="bars">${rows.slice(0, 6).map(([k, v], i) => `<div class="bar ${alt ? 'alt' : ''}"><span>${esc(k)}</span><i style="width:${Math.max(6, v / rows[0][1] * 100)}%"></i><b>${v}</b></div>`).join('')}</div>` : '<p class="hint">Nothing logged yet.</p>';
  const year = new Date().getFullYear();
  const months = Array.from({ length: 12 }, (_, i) => [new Date(2000, i, 1).toLocaleString('en-GB', { month: 'narrow' }), catches.filter(c => c.caughtAt?.startsWith(`${year}-${String(i + 1).padStart(2, '0')}`)).length]);
  const mmx = Math.max(1, ...months.map(m => m[1]));
  const spCount = Object.fromEntries(count(c => c.species));
  const pbs = Object.values(best).sort((a, b) => b.weightG - a.weightG);
  view.innerHTML = `
    <h1 class="display pagehead">Trophy room</h1>
    <div class="tiles">
      <div><b class="display">${catches.length}</b><span>fish</span></div>
      <div><b class="display">${fmtWeight(total)}</b><span>total weight</span></div>
      <div><b class="display">${Object.keys(spCount).length}</b><span>species</span></div>
      <div><b class="display">${catches.filter(c => c.caughtAt?.startsWith(String(year))).length}</b><span>this year</span></div>
    </div>
    <div class="block"><h2 class="display">Personal bests</h2>
      <div class="pbs">${pbs.map((c, i) => `<a class="pbc" href="#catch-${c.id}"><div class="ph" data-img="${c.photos?.[0] || ''}">${c.photos?.length ? '' : fishArt(c.species, c.id)}</div><div class="shade"></div>
        <span class="rank">${i + 1}</span><div class="tx"><b class="display">${fmtWeight(c.weightG)}</b><span>${esc(c.species)}</span><small>${esc(c.venue || '')} · ${fmtDay(c.caughtAt)} · ${spCount[c.species]} caught</small></div></a>`).join('')}</div></div>
    ${badgeHTML}
    <div class="block"><h2 class="display">Killer baits</h2>${bars(count(c => c.bait))}</div>
    <div class="block"><h2 class="display">Rigs that work</h2>${bars(count(c => c.gear?.rig), true)}</div>
    <div class="block"><h2 class="display">Best venues</h2>${bars(count(c => c.venue), true)}</div>
    <div class="block"><h2 class="display">Pressure when they fed</h2>${bars(count(c => c.weather?.trend))}</div>
    <div class="block"><h2 class="display">${year} season</h2><div class="months">${months.map(([k, v]) => `<div><i style="height:${v / mmx * 100}%"></i><b>${v || ''}</b><span>${k}</span></div>`).join('')}</div></div>
    ${brandFoot()}`;
  $$('.pbc .ph[data-img]').forEach(async el => { if (!el.dataset.img) return; const u = await blobUrl(el.dataset.img); if (u) el.style.backgroundImage = `url(${u})`; });
}


/* ---------------- backup ---------------- */
const toDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
async function makeBackup() {
  const blobs = await getAll('blobs');
  const out = [];
  for (const b of blobs) out.push({ id: b.id, type: b.type, data: await toDataURL(new Blob([b.data], { type: b.type })) });
  const json = JSON.stringify({ format: 'harvey-catch-log', dataVersion: DATA_VERSION, appVersion: APP_VERSION, exportedAt: new Date().toISOString(), settings, catches, blobs: out });
  return new File([json], `catch-log-backup-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
}
async function exportBackup(st) {
  if (DEMO) { st.textContent = 'In the demo, backups are switched off (Claude previews can’t save files). In the installed app this saves a file with every catch and photo.'; return; }
  st.textContent = 'Packing up every catch and photo…';
  const file = await makeBackup();
  const mb = (file.size / 1048576).toFixed(1);
  let done = false;
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Catch Log backup' }); done = true; }
    catch (e) { if (e.name === 'AbortError') { st.textContent = 'Backup cancelled.'; return; } }
  }
  if (!done) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  settings.lastBackup = new Date().toISOString(); settings.catchesAtBackup = catches.length;
  await saveSettings();
  st.textContent = `Backup made: ${catches.length} catches, ${mb} MB. Keep it somewhere safe (Google Drive, iCloud, email to yourself).`;
}
async function importBackup(file, st) {
  st.textContent = 'Reading backup…';
  const j = JSON.parse(await file.text());
  if (j.format !== 'harvey-catch-log' || !Array.isArray(j.catches)) throw new Error('That isn’t a Catch Log backup file.');
  let added = 0, updated = 0;
  for (const b of j.blobs || []) {
    const data = await (await fetch(b.data)).arrayBuffer();
    await putOne('blobs', { id: b.id, type: b.type, data });
    urls.delete(b.id);
  }
  const have = new Map(catches.map(c => [c.id, c]));
  for (const c of j.catches) {
    const mine = have.get(c.id);
    if (!mine) { await putOne('catches', c); added++; }
    else if ((c.updatedAt || '') > (mine.updatedAt || '')) { await putOne('catches', c); updated++; }
  }
  await load();
  st.textContent = `Restored: ${added} new catch${added === 1 ? '' : 'es'}, ${updated} updated. Nothing was deleted.`;
}

async function settingsView() {
  const est = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  view.innerHTML = `
    <h1 class="display pagehead">Settings</h1>
    <div class="set"><h2>Back up your catches</h2>
      <p>Everything lives on this phone. A backup file holds every catch, photo and map. Save it to Google Drive or iCloud, or email it to yourself, every week or two.</p>
      <div class="row"><button class="btn alt" id="exp">Save backup file</button>
      <label class="btn ghost">Restore from backup<input type="file" accept=".json,application/json" id="imp" hidden></label></div>
      <p class="status" id="bst">${settings.lastBackup ? `Last backup ${fmtDate(settings.lastBackup)} (${settings.catchesAtBackup} catches).` : 'No backup made yet.'}</p>
      <p>Restoring adds catches from the file and never deletes anything, so it is also how you move to a new phone.</p>
    </div>
    <div class="set"><h2>Units</h2>
      <div class="seg" id="units"><button data-u="imperial" class="${settings.units !== 'metric' ? 'on' : ''}">lb &amp; oz, inches</button><button data-u="metric" class="${settings.units === 'metric' ? 'on' : ''}">kg, cm</button></div>
      <p>Weights are stored exactly, so you can switch any time.</p>
    </div>
    <div class="set"><h2>Angler</h2>
      <label>Name<input id="nm" value="${esc(settings.name)}" maxlength="30"></label>
    </div>
    <div class="set"><h2>Install on your phone</h2>
      <p>${standalone ? 'Installed. It opens from your home screen and works with no signal.' :
        ios ? 'In Safari, tap the Share button, then <b>Add to Home Screen</b>. It then opens like a normal app and keeps your catches safer.' :
        'In Chrome, tap the ⋮ menu, then <b>Install app</b> (or <b>Add to Home screen</b>).'}</p>
      <p>Storage: ${persisted ? 'protected, so the phone won’t clear it to free up space' : 'standard (install the app to protect it)'}${est ? ` · ${(est.usage / 1048576).toFixed(1)} MB used` : ''}.</p>
    </div>
    ${brandFoot('big')}
    <p class="hint center">Catch Log ${APP_VERSION} · data format ${DATA_VERSION} · weather by Open-Meteo · imagery © Esri</p>`;
  const st = $('#bst');
  $('#exp').onclick = () => exportBackup(st).catch(e => { st.textContent = 'Backup failed: ' + e.message; });
  $('#imp').onchange = e => { const f = e.target.files[0]; if (f) importBackup(f, st).catch(err => { st.textContent = err.message; }); };
  $('#units').onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    settings.units = b.dataset.u; await saveSettings(); settingsView();
  };
  $('#nm').onchange = async e => { settings.name = e.target.value.trim() || 'Harvey'; await saveSettings(); setName(); };
}
function setName() {
  const t = `${settings.name}'s Catch Log`;
  $('#appName').textContent = t; document.title = t;
}

/* ---------------- demo sample data ---------------- */
async function seedDemo() {
  const wx = (t, c, d, k, p, tr) => ({ tempC: t, conditions: c, windDir: d, windKph: k, gustKph: Math.round(k * 1.8), pressure: p, trend: tr, cloud: 60, rainMm: 0, source: 'auto', demo: true });
  const S = [
    ['Mirror carp', 8278, 640, 'Peg 6', '2026-11-22T07:40', '15mm pineapple pop-up', { rod: 'Nash Scope 10ft', reel: 'Shimano 5500', line: '15lb mono', hook: 'Size 6 curve', rig: 'Ronnie rig', method: 'Ledger' }, wx(9, 'Partly cloudy', 'SW', 22, 1009, 'Falling'), [690, 300]],
    ['Common carp', 6010, 590, 'Peg 4', '2026-10-30T18:20', 'Boilie', { rig: 'Hair rig', method: 'Ledger', hook: 'Size 8 wide gape' }, wx(12, 'Light rain', 'S', 16, 1012, 'Falling'), [520, 260]],
    ['Pike', 5300, 820, 'Peg 11', '2026-11-15T14:10', 'Sardine deadbait', { rig: 'Running ledger', method: 'Deadbait', line: '30lb braid' }, wx(7, 'Overcast', 'W', 29, 1004, 'Steady'), [560, 560]],
    ['Perch', 794, 300, 'Peg 13', '2026-10-12T10:05', 'Worms', { rig: 'Waggler', method: 'Float', hook: 'Size 12' }, wx(14, 'Clear', 'NE', 10, 1021, 'Rising'), [260, 420]],
    ['Tench', 2381, 450, 'Peg 12', '2026-06-08T05:30', 'Sweetcorn', { rig: 'Method feeder', method: 'Feeder' }, wx(15, 'Mainly clear', 'SE', 8, 1018, 'Steady'), [330, 520]]
  ];
  for (const [species, weightG, lengthMm, swim, caughtAt, bait, gear, weather, [x, y]] of S) {
    const c = { id: uid(), createdAt: caughtAt, species, weightG, lengthMm, venue: 'Willow Lake (demo)', swim, caughtAt, bait, gear, weather, released: true, photos: [], zoom: 17, moon: moon(caughtAt), ...lakeLL(x, y), accuracy: 6, notes: 'Sample catch for the demo.' };
    await updateSnapshot(c);
    await saveCatch(c);
  }
  settings.demoSeeded = true; settings.catchesAtBackup = 3; settings.lastBackup = '2026-11-01T10:00:00Z';
  await saveSettings();
}

/* ---------------- router ---------------- */
async function route() {
  maps.forEach(m => m.remove()); maps = [];
  $('#modal').hidden = true;
  $$('.spsheet').forEach(p => p.remove());
  $$('.party').forEach(p => p.remove());
  const h = location.hash.slice(1) || 'list';
  const i = h.indexOf('-');
  const name = i < 0 ? h : h.slice(0, i), id = i < 0 ? '' : h.slice(i + 1);
  $$('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === (name === 'catch' || name === 'edit' ? 'list' : name)));
  const fn = { list: listView, add: () => formView(null), edit: formView, catch: detailView, map: mapView, stats: statsView, settings: settingsView }[name] || listView;
  window.scrollTo(0, 0);
  try { await fn(id); } catch (e) { view.innerHTML = `<p class="empty">Something went wrong: ${esc(e.message)}</p>`; console.error(e); }
}
function net() {
  $('#netState').hidden = navigator.onLine;
  if (navigator.onLine) processPending().then(n => { if (n && /^#(list|catch)/.test(location.hash || '#list')) route(); });
}

async function boot() {
  if (DEMO) {
    try { await Promise.race([load(), new Promise((_, j) => setTimeout(() => j(new Error('slow')), 3000))]); }
    catch { mem = { catches: new Map(), blobs: new Map(), meta: new Map() }; await load(); }
    if (!catches.length && !settings.demoSeeded) await seedDemo();
    const b = document.createElement('div');
    b.className = 'demo';
    b.innerHTML = 'Demo. Map, GPS and weather are pretend here; the installed app uses the real ones. <button type="button" id="resetDemo">Reset</button>';
    document.querySelector('.top').after(b);
    $('#resetDemo').onclick = async () => {
      if (!await ask('Reset the demo?', 'Deletes everything you added and puts the sample catches back.', 'Reset')) return;
      for (const c of catches) await delOne('catches', c.id);
      for (const x of await getAll('blobs')) await delOne('blobs', x.id);
      catches = []; await seedDemo(); location.hash = '#list'; await route(); playIntro();
    };
  } else try { await load(); }
  catch (e) { view.innerHTML = `<p class="empty">This browser is blocking storage, so catches can’t be saved. If you’re in a private tab, open the app normally.</p>`; return; }
  setName();
  $('#hdcow').innerHTML = cowboySVG();
  playIntro();
  addEventListener('hashchange', route);
  addEventListener('online', net); addEventListener('offline', net);
  await route();
  net();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then(reg => {
      const ask = w => toast('New version ready', 'Update', () => w.postMessage('skipWaiting'));
      if (reg.waiting && navigator.serviceWorker.controller) ask(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) ask(w); });
      });
    }).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
  }
}
boot();
}
