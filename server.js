const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

// ── WUC April 2025 domestic tariffs ──────────────────────────────
const POTABLE_BLOCKS = [
  { min: 0,  max: 5,        rate: 2.45,  vatExempt: true  },
  { min: 5,  max: 10,       rate: 11.41, vatExempt: false },
  { min: 10, max: 15,       rate: 13.43, vatExempt: false },
  { min: 15, max: 20,       rate: 25.15, vatExempt: false },
  { min: 20, max: 40,       rate: 38.69, vatExempt: false },
  { min: 40, max: Infinity, rate: 48.38, vatExempt: false },
];
const WASTEWATER_BLOCKS = [
  { min: 0,  max: 5,        rate: 0.46, vatExempt: true  },
  { min: 5,  max: 10,       rate: 2.86, vatExempt: false },
  { min: 10, max: 15,       rate: 5.03, vatExempt: false },
  { min: 15, max: 20,       rate: 5.38, vatExempt: false },
  { min: 20, max: 40,       rate: 7.18, vatExempt: false },
  { min: 40, max: Infinity, rate: 8.98, vatExempt: false },
];

function calcBlocks(consumption, blocks) {
  let subtotal = 0;
  const breakdown = [];
  for (const block of blocks) {
    if (consumption <= block.min) break;
    const used = Math.min(consumption, block.max) - block.min;
    if (used <= 0) continue;
    const charge = +(used * block.rate).toFixed(2);
    const vatComponent = block.vatExempt ? 0 : +(charge * 14 / 114).toFixed(2);
    breakdown.push({
      label: `${block.min}–${block.max === Infinity ? 'above' : block.max} kL`,
      used, rate: block.rate, charge, vatExempt: block.vatExempt, vatComponent,
    });
    subtotal += charge;
  }
  return { subtotal: +subtotal.toFixed(2), breakdown };
}

function calculateBill(consumption) {
  const water      = calcBlocks(consumption, POTABLE_BLOCKS);
  const wastewater = calcBlocks(consumption, WASTEWATER_BLOCKS);
  const total      = +(water.subtotal + wastewater.subtotal).toFixed(2);
  const allRows    = [...water.breakdown, ...wastewater.breakdown];
  const vatExemptTotal = +allRows.filter(b =>  b.vatExempt).reduce((s, b) => s + b.charge, 0).toFixed(2);
  const taxableTotal   = +allRows.filter(b => !b.vatExempt).reduce((s, b) => s + b.charge, 0).toFixed(2);
  const vatAmount      = +(taxableTotal * 14 / 114).toFixed(2);
  return {
    total,
    waterBreakdown: water.breakdown,       waterSubtotal: water.subtotal,
    wastewaterBreakdown: wastewater.breakdown, wastewaterSubtotal: wastewater.subtotal,
    vatExemptTotal, taxableTotal, vatAmount,
  };
}

// ── Auth middleware ───────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

// Inject user into all views
app.use(async (req, res, next) => {
  if (req.session.userId) {
    const result = await pool.query('SELECT u.id, u.username, u.house_id, h.name AS house_name FROM users u JOIN houses h ON h.id = u.house_id WHERE u.id = $1', [req.session.userId]);
    if (result.rows.length) {
      req.user = result.rows[0];
      res.locals.user = result.rows[0];
    }
  } else {
    req.user = null;
    res.locals.user = null;
  }
  next();
});

// ── Routes ───────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.render('login', { error: 'Please enter both username and password.' });

  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  if (!result.rows.length) return res.render('login', { error: 'Invalid username or password.' });

  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.render('login', { error: 'Invalid username or password.' });

  req.session.userId = user.id;
  req.session.save(() => res.redirect('/'));
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/', requireAuth, async (req, res) => {
  const userHouseId = req.user.house_id;
  const username = req.user.username;

  // front user only sees front house; back user sees both
  let houses;
  if (username === 'back') {
    houses = (await pool.query('SELECT * FROM houses ORDER BY id')).rows;
  } else {
    houses = (await pool.query('SELECT * FROM houses WHERE id = $1', [userHouseId])).rows;
  }

  const lastReadings = {};
  for (const house of houses) {
    const rows = (await pool.query('SELECT meter_reading, reading_date, total_charge, consumption FROM readings WHERE house_id = $1 ORDER BY reading_date DESC LIMIT 1', [house.id])).rows;
    lastReadings[house.id] = rows[0] || null;
  }

  res.render('index', { houses, lastReadings });
});

app.get('/house/:id', requireAuth, async (req, res) => {
  const houseId = Number(req.params.id);
  const username = req.user.username;
  const userHouseId = req.user.house_id;

  // front user cannot access back house
  if (username === 'front' && houseId !== userHouseId) return res.redirect('/');

  const houses = (await pool.query('SELECT * FROM houses WHERE id = $1', [houseId])).rows;
  if (!houses.length) return res.redirect('/');

  const lastReading = (await pool.query('SELECT * FROM readings WHERE house_id = $1 ORDER BY reading_date DESC LIMIT 1', [houseId])).rows[0] || null;

  res.render('house', { house: houses[0], lastReading, error: req.query.error || null });
});

app.post('/house/:id/reading', requireAuth, async (req, res) => {
  const houseId = Number(req.params.id);
  const username = req.user.username;
  const userHouseId = req.user.house_id;

  // back user can only add readings to back house; front user only to front house
  if (username === 'front' && houseId !== userHouseId) return res.redirect('/');
  if (username === 'back' && houseId !== userHouseId) return res.redirect('/');

  const houses = (await pool.query('SELECT * FROM houses WHERE id = $1', [houseId])).rows;
  if (!houses.length) return res.redirect('/');
  const house = houses[0];

  const currentReading = parseFloat(req.body.meter_reading);
  if (isNaN(currentReading) || currentReading < 0) {
    return res.redirect(`/house/${houseId}?error=invalid`);
  }

  const lastRows = (await pool.query('SELECT meter_reading FROM readings WHERE house_id = $1 ORDER BY reading_date DESC LIMIT 1', [houseId])).rows;
  const lastReading = lastRows[0] || null;

  if (lastReading && currentReading < lastReading.meter_reading) {
    return res.redirect(`/house/${houseId}?error=negative`);
  }

  const previousReading = lastReading ? lastReading.meter_reading : 0;
  const consumption = +(currentReading - previousReading).toFixed(3);
  const {
    total, waterBreakdown, waterSubtotal, wastewaterBreakdown, wastewaterSubtotal,
    vatExemptTotal, taxableTotal, vatAmount,
  } = calculateBill(consumption);

  const blockBreakdownJson = JSON.stringify({ water: waterBreakdown, wastewater: wastewaterBreakdown });
  await pool.query(
    'INSERT INTO readings (house_id, meter_reading, consumption, block_breakdown, total_charge) VALUES ($1, $2, $3, $4, $5)',
    [houseId, currentReading, consumption, blockBreakdownJson, total]
  );

  res.render('result', {
    house, currentReading, previousReading, consumption,
    waterBreakdown, waterSubtotal, wastewaterBreakdown, wastewaterSubtotal,
    totalCharge: total, vatExemptTotal, taxableTotal, vatAmount,
    readingDate: new Date().toISOString().split('T')[0],
  });
});

app.get('/house/:id/history', requireAuth, async (req, res) => {
  const houseId = Number(req.params.id);
  const username = req.user.username;
  const userHouseId = req.user.house_id;

  // front user cannot see back house history
  if (username === 'front' && houseId !== userHouseId) return res.redirect('/');
  // back user CAN see front house history (bills)
  // no restriction needed for back user

  const houses = (await pool.query('SELECT * FROM houses WHERE id = $1', [houseId])).rows;
  if (!houses.length) return res.redirect('/');

  const readings = (await pool.query('SELECT * FROM readings WHERE house_id = $1 ORDER BY reading_date DESC', [houseId])).rows;

  res.render('history', { house: houses[0], readings });
});

app.listen(PORT, () => console.log(`Water Meter app running on http://localhost:${PORT}`));
