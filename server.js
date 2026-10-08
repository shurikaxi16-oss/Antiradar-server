const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // hosting proxy ortida haqiqiy IP olish (rate limit uchun)
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- Sozlamalar ----------
const PORT = process.env.PORT || 3000;
// Hostingda doimiy disk (volume) yo'lini DATA_DIR bilan bering, aks holda deploy'da baza o'chadi
const DB_FILE = path.join(process.env.DATA_DIR || __dirname, 'radars.json');
const TEMP_TTL_MS = 2 * 60 * 60 * 1000; // vaqtinchalik radar 2 soat yashaydi
const DEFAULT_RADIUS = 5000;            // m
const MAX_RADIUS = 20000;               // m
const DEDUP_METERS = 100;               // shu masofada bir xil radar = takror
const MAX_ANGLE = 60;                   // yo'nalish filtri (gradus)
const RATE_LIMIT = { max: 10, windowMs: 10 * 60 * 1000 }; // IP boshiga 10 ta / 10 daqiqa

// ---------- Baza (JSON fayl, qayta ishga tushsa saqlanadi) ----------
const SEED = [
  { id: 1, lat: 41.311081, lng: 69.240562, type: 'Stasionar kamera', limit: 60, temporary: false },
  { id: 2, lat: 41.315, lng: 69.245, type: 'Nexia 3 Mobil radar', limit: 70, temporary: false },
  { id: 3, lat: 41.32, lng: 69.25, type: "Yo'l ta'mirlanishi", limit: 50, temporary: false },
];

let radars = [];
let nextId = 100;

function loadDb() {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    radars = data.radars || [];
    nextId = data.nextId || 100;
  } catch (_) {
    radars = SEED.slice();
    nextId = 100;
    saveDb();
  }
}

function saveDb() {
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ radars, nextId }));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('Bazani saqlashda xatolik:', e.message);
  }
}

function cleanupExpired() {
  const before = radars.length;
  const now = Date.now();
  radars = radars.filter((r) => !r.temporary || now - r.reportedAt < TEMP_TTL_MS);
  if (radars.length !== before) saveDb();
}

loadDb();
cleanupExpired();
setInterval(cleanupExpired, 10 * 60 * 1000);

// ---------- Geo funksiyalar ----------
const RAD = Math.PI / 180;

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x =
    Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) -
    Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

function angleDiff(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

// ---------- Spamdan himoya ----------
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  if (list.length >= RATE_LIMIT.max) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    const fresh = list.filter((t) => now - t < RATE_LIMIT.windowMs);
    if (fresh.length) hits.set(ip, fresh);
    else hits.delete(ip);
  }
}, 10 * 60 * 1000);

// ---------- 1. Yaqin radarlar ----------
// GET /api/radars?lat=..&lng=..[&radius=5000][&heading=90]
app.get('/api/radars', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'Lat va Lng talab qilinadi' });
  }

  let radius = parseFloat(req.query.radius);
  if (!Number.isFinite(radius) || radius <= 0) radius = DEFAULT_RADIUS;
  radius = Math.min(radius, MAX_RADIUS);

  const heading = parseFloat(req.query.heading);
  const useHeading = Number.isFinite(heading) && heading >= 0;

  cleanupExpired();

  const result = [];
  for (const r of radars) {
    const dist = distanceMeters(lat, lng, r.lat, r.lng);
    if (dist > radius) continue;
    const brg = bearing(lat, lng, r.lat, r.lng);
    if (useHeading && angleDiff(brg, heading) >= MAX_ANGLE) continue;
    result.push({
      id: r.id,
      lat: r.lat,
      lng: r.lng,
      type: r.type,
      limit: r.limit,
      distance: Math.round(dist),
      bearing: Math.round(brg),
    });
  }
  result.sort((a, b) => a.distance - b.distance);
  res.json(result);
});

// ---------- 2. Yangi radar qo'shish (crowdsourcing) ----------
app.post('/api/radars', (req, res) => {
  if (rateLimited(req.ip)) {
    return res.status(429).json({ error: "Juda ko'p so'rov. Keyinroq urinib ko'ring" });
  }

  const { lat, lng, type } = req.body || {};
  let { limit } = req.body || {};

  if (
    typeof lat !== 'number' || typeof lng !== 'number' ||
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    Math.abs(lat) > 90 || Math.abs(lng) > 180 ||
    typeof type !== 'string' || !type.trim() || type.length > 60
  ) {
    return res.status(400).json({ error: "Noto'g'ri ma'lumot" });
  }

  limit = Math.round(Number(limit));
  if (!Number.isFinite(limit) || limit < 5 || limit > 130) limit = 60;
  const cleanType = type.trim();

  // Takror: shu joyda shu turdagi vaqtinchalik radar bor bo'lsa, vaqtini yangilaymiz
  const dup = radars.find(
    (r) =>
      r.temporary &&
      r.type === cleanType &&
      distanceMeters(lat, lng, r.lat, r.lng) <= DEDUP_METERS
  );
  if (dup) {
    dup.reportedAt = Date.now();
    saveDb();
    return res.status(200).json({ message: 'Yangilandi', radar: dup });
  }

  const newRadar = {
    id: nextId++,
    lat,
    lng,
    type: cleanType,
    limit,
    reportedAt: Date.now(),
    temporary: true,
  };
  radars.push(newRadar);
  saveDb();
  res.status(201).json({ message: "Qo'shildi", radar: newRadar });
});

app.listen(PORT, '0.0.0.0', () =>
  console.log(`Antiradar server ${PORT}-portda ishlamoqda...`)
);
