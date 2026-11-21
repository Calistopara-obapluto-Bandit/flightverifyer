const express = require('express');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT) || 3000;
const publicDirectory = path.join(__dirname, 'public');
const dataDirectory = path.join(__dirname, 'data');
const supportFile = path.join(dataDirectory, 'support-requests.json');
const connectionString = String(process.env.DATABASE_URL || '').trim();

/* ------------------------------------------------------------------ */
/* Neon Postgres storage                                               */
/* ------------------------------------------------------------------ */

const needsSsl = connectionString
  && !/^postgres(ql)?:\/\/[^/]*(localhost|127\.0\.0\.1)/i.test(connectionString);

const pool = connectionString
  ? new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined
  })
  : null;

if (pool && typeof pool.on === 'function') {
  pool.on('error', (error) => {
    console.error('[db] idle client error:', error.message);
  });
}

const parsePayload = (payload) => (typeof payload === 'string' ? JSON.parse(payload) : payload);

const seedBookings = require('./data/bookings.json');

async function initDatabase() {
  if (!pool) {
    console.error('[db] DATABASE_URL is not set. Add your Neon connection string to the environment; the desk will answer 503 until then.');
    return false;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      code TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipments (
      code TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_requests (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query('SELECT COUNT(*) AS count FROM bookings');
  if (Number(rows[0].count) === 0) {
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const seedTimelines = {
      'BX-H43TYYE': { dispatchedAt: now - 2 * hour, arrivesAt: now + 4 * hour, outcome: 'boarded' },
      'F4J5UZ': { dispatchedAt: now - 7 * hour, arrivesAt: now - 2 * hour, outcome: 'boarded' },
      'M7K9X2': { dispatchedAt: now + 30 * hour, arrivesAt: now + 38 * hour, outcome: 'pending' }
    };
    for (const [code, booking] of Object.entries(seedBookings)) {
      const seed = seedTimelines[code] || { dispatchedAt: now, arrivesAt: now + 6 * hour, outcome: 'pending' };
      const record = {
        ...booking,
        travelOutcome: seed.outcome,
        timeline: {
          dispatchedAt: new Date(seed.dispatchedAt).toISOString(),
          arrivesAt: new Date(seed.arrivesAt).toISOString()
        }
      };
      await pool.query(
        `INSERT INTO bookings (code, payload, created_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (code) DO NOTHING`,
        [code, JSON.stringify(record), booking.issuedAt || new Date().toISOString()]
      );
    }
    console.log(`[db] seeded ${Object.keys(seedBookings).length} verification records`);
  }

  const shipments = await pool.query('SELECT COUNT(*) AS count FROM shipments');
  if (Number(shipments.rows[0].count) === 0) {
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const sample = buildShipment({
      service: 'Shiparox Express',
      origin: 'Lagos, Nigeria',
      destination: 'London, United Kingdom',
      senderName: 'Adeola Ogun',
      senderPhone: '+234 803 555 0142',
      senderEmail: 'adeola.ogun@example.com',
      recipientName: 'Grace Whitfield',
      recipientPhone: '+44 7700 900 318',
      recipientEmail: 'grace.whitfield@example.com',
      contents: 'Documents and sample kit',
      reference: 'PO-4417',
      weightKg: 4.2,
      pieces: 2,
      status: 'in_transit',
      registeredAt: new Date(now - 26 * hour).toISOString(),
      etaAt: new Date(now + 22 * hour).toISOString()
    }, 'SHPX-HGV3MQ');
    await pool.query(
      'INSERT INTO shipments (code, payload, created_at) VALUES ($1, $2::jsonb, $3)',
      [sample.trackingNumber, JSON.stringify(sample), sample.createdAt]
    );
    console.log('[db] seeded tracking sample SHPX-HGV3MQ');
  }

  const backfilled = await backfillTimelines();
  if (backfilled) console.log(`[db] backfilled flight timelines for ${backfilled} record(s)`);
  return true;
}

// Records issued before timelines existed were seeded with local clock times only.
// Derive an absolute departure/arrival from the issue date so their phase can advance.
function timelineFromBooking(booking) {
  const issued = new Date(booking.issuedAt || booking.createdAt || Date.now());
  if (Number.isNaN(issued.getTime())) return null;
  const date = issued.toISOString().slice(0, 10);
  const departure = zonedToUtc(date, parseClock(booking.departure?.scheduled), booking.departure?.timezone);
  if (!departure) return null;
  let arrival = zonedToUtc(date, parseClock(booking.arrival?.scheduled), booking.arrival?.timezone);
  if (arrival && arrival.getTime() <= departure.getTime()) {
    arrival = new Date(arrival.getTime() + 24 * 60 * 60 * 1000);
  }
  return {
    dispatchedAt: departure.toISOString(),
    arrivesAt: arrival ? arrival.toISOString() : null
  };
}

async function backfillTimelines() {
  const { rows } = await pool.query("SELECT code, payload FROM bookings WHERE payload->>'timeline' IS NULL");
  let updated = 0;
  for (const row of rows) {
    const booking = parsePayload(row.payload);
    const timeline = timelineFromBooking(booking);
    if (!timeline) continue;
    const payload = {
      ...booking,
      timeline,
      travelOutcome: travelOutcomes.includes(booking.travelOutcome) ? booking.travelOutcome : 'pending'
    };
    await pool.query('UPDATE bookings SET payload = $2::jsonb WHERE code = $1', [row.code, JSON.stringify(payload)]);
    updated += 1;
  }
  return updated;
}

async function initWithRetry(attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await initDatabase();
    } catch (error) {
      console.error(`[db] initialisation attempt ${attempt} failed: ${error.message}`);
      if (attempt === attempts) return false;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  return false;
}

let databaseReady = false;

function requireDatabase(req, res, next) {
  if (!pool || !databaseReady) {
    return res.status(503).json({
      error: 'The verification ledger is not connected yet. Set DATABASE_URL to the Neon connection string and restart the desk.'
    });
  }
  next();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function readBookingRow(code) {
  if (!code) return null;
  const { rows } = await pool.query('SELECT payload FROM bookings WHERE code = $1', [code]);
  return rows[0]?.payload ? parsePayload(rows[0].payload) : null;
}

async function allBookings() {
  const { rows } = await pool.query('SELECT payload, created_at FROM bookings ORDER BY created_at DESC');
  return rows.map((row) => ({
    ...parsePayload(row.payload),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
  }));
}

const squash = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function findBooking(code) {
  if (!code) return null;
  const direct = await readBookingRow(code);
  if (direct) return direct;
  const normalised = squash(code);
  const bookings = await allBookings();
  return bookings.find((booking) => {
    const candidates = [
      booking.pnr,
      booking.bookingReference,
      booking.flightNumber,
      ...(booking.passengers || []).map((passenger) => passenger.ticketNumber)
    ];
    return candidates.filter(Boolean).some((value) => squash(value) === normalised);
  }) || null;
}

/* ------------------------------------------------------------------ */
/* Admin authentication                                                */
/* ------------------------------------------------------------------ */

const adminEmail = String(process.env.ADMIN_EMAIL || 'admin@verifymyflight.local').trim().toLowerCase();
const adminPassword = String(process.env.ADMIN_PASSWORD || 'verify-admin-2026');
const usingDefaultCredentials = !process.env.ADMIN_PASSWORD;
const sessions = new Map();
const loginAttempts = new Map();
const sessionLifetime = 1000 * 60 * 60 * 8;

function safeEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left)).digest();
  const b = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    return separator < 0 ? ['', ''] : [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

function requireAdmin(req, res, next) {
  const token = parseCookies(req.headers.cookie).vmf_admin;
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: 'Administrator sign-in required.' });
  }
  req.admin = session;
  next();
}

/* ------------------------------------------------------------------ */
/* Booking builder                                                     */
/* ------------------------------------------------------------------ */

const AIRPORTS = {
  LOS: [6.5774, 3.3212], ABV: [9.0068, 7.2632], PHC: [5.0155, 6.9496], KAN: [12.0476, 8.5246],
  LHR: [51.47, -0.4543], LGW: [51.1537, -0.1821], MAN: [53.3537, -2.275], CDG: [49.0097, 2.5479],
  ORY: [48.7233, 2.3794], AMS: [52.3105, 4.7683], FRA: [50.0379, 8.5622], MUC: [48.3538, 11.7861],
  MAD: [40.4983, -3.5676], BCN: [41.2974, 2.0833], FCO: [41.8003, 12.2389], IST: [41.2753, 28.7519],
  DXB: [25.2532, 55.3657], DOH: [25.2731, 51.6081], JNB: [-26.1367, 28.2411], CPT: [-33.9689, 18.6017],
  NBO: [-1.3192, 36.9278], ADD: [8.9779, 38.7993], CAI: [30.1219, 31.4056], CMN: [33.3675, -7.5899],
  ACC: [5.6052, -0.1668], ABJ: [5.2615, -3.9263], JFK: [40.6413, -73.7781], EWR: [40.6895, -74.1745],
  LAX: [33.9416, -118.4085], SFO: [37.6213, -122.379], ORD: [41.9742, -87.9073], ATL: [33.6407, -84.4277],
  MIA: [25.7959, -80.287], BOS: [42.3656, -71.0096], IAD: [38.9531, -77.4565], YYZ: [43.6777, -79.6248],
  YVR: [49.1967, -123.1815], GRU: [-23.4356, -46.4731], EZE: [-34.8222, -58.5358], SIN: [1.3644, 103.9915],
  HKG: [22.308, 113.9185], NRT: [35.7719, 140.3929], HND: [35.5494, 139.7798], ICN: [37.4602, 126.4407],
  PEK: [40.0799, 116.6031], PVG: [31.1443, 121.8083], BKK: [13.69, 100.7501], KUL: [2.7456, 101.71],
  DEL: [28.5562, 77.1], BOM: [19.0896, 72.8656], SYD: [-33.9399, 151.1753], MEL: [-37.669, 144.841]
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomFrom(alphabet, length) {
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output += alphabet[crypto.randomInt(alphabet.length)];
  }
  return output;
}

async function uniqueCode() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = `BX-${randomFrom(CODE_ALPHABET, 6)}`;
    if (!(await readBookingRow(code))) return code;
  }
  throw new Error('Could not allocate a unique tracking code.');
}

const text = (value, max = 120) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const upper = (value, max = 12) => text(value, max).toUpperCase();

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function decimal(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : fallback;
}

function haversineKm(from, to) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const earth = 6371;
  const dLat = toRadians(to[0] - from[0]);
  const dLon = toRadians(to[1] - from[1]);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(from[0])) * Math.cos(toRadians(to[0])) * Math.sin(dLon / 2) ** 2;
  return Math.round(earth * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function bearing(from, to) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const dLon = toRadians(to[1] - from[1]);
  const y = Math.sin(dLon) * Math.cos(toRadians(to[0]));
  const x = Math.cos(toRadians(from[0])) * Math.sin(toRadians(to[0]))
    - Math.sin(toRadians(from[0])) * Math.cos(toRadians(to[0])) * Math.cos(dLon);
  return Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360);
}

// Position along the great-circle track, so stored coordinates agree with the
// map, the reported distance flown and the live radar.
function greatCirclePosition(from, to, fraction) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const toDegrees = (value) => (value * 180) / Math.PI;
  const f = Math.min(1, Math.max(0, fraction));
  const lat1 = toRadians(from[0]);
  const lon1 = toRadians(from[1]);
  const lat2 = toRadians(to[0]);
  const lon2 = toRadians(to[1]);
  const angle = 2 * Math.asin(Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
  ));
  if (!Number.isFinite(angle) || angle < 1e-9) {
    return [from[0], from[1]];
  }
  const a = Math.sin((1 - f) * angle) / Math.sin(angle);
  const b = Math.sin(f * angle) / Math.sin(angle);
  const x = a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2);
  const y = a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2);
  const z = a * Math.sin(lat1) + b * Math.sin(lat2);
  return [
    Math.round(toDegrees(Math.atan2(z, Math.hypot(x, y))) * 10000) / 10000,
    Math.round(toDegrees(Math.atan2(y, x)) * 10000) / 10000
  ];
}

function displayDate(value) {
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return text(value, 40);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  }).format(parsed);
}

function ticketName(fullName) {
  const parts = text(fullName, 80).split(' ').filter(Boolean);
  if (!parts.length) return 'PASSENGER';
  const last = parts[parts.length - 1].toUpperCase();
  const given = parts.slice(0, -1).map((part) => part[0].toUpperCase()).join(' ');
  return given ? `${last} / ${given}` : last;
}

const travelOutcomes = ['pending', 'boarded', 'missed'];

function parseClock(value) {
  const match = String(value || '').match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

// Turn a local wall-clock date/time in an IANA zone into an absolute instant.
function zonedToUtc(dateValue, clock, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ''));
  if (!match || !clock) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const naive = Date.UTC(year, month - 1, day, clock.hours, clock.minutes);
  let zone = timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format();
  } catch {
    zone = 'UTC';
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(new Date(naive));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const asUtc = Date.UTC(+values.year, +values.month - 1, +values.day, +values.hour, +values.minute, +values.second);
    return new Date(naive - (asUtc - naive));
  } catch {
    return new Date(naive);
  }
}

function isSameUtcDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

function phaseFor(booking) {
  const timeline = booking.timeline || {};
  const dispatched = Date.parse(timeline.dispatchedAt);
  const arrives = Date.parse(timeline.arrivesAt);
  if (Number.isFinite(dispatched) && Number.isFinite(arrives)) {
    const now = Date.now();
    if (now >= arrives) return 'arrived';
    if (now >= dispatched) return 'dispatched';
    return 'scheduled';
  }
  const legacy = String(booking.status || '').toUpperCase();
  if (legacy.includes('ARRIV')) return 'arrived';
  if (legacy.includes('IN FLIGHT') || legacy.includes('EN ROUTE') || legacy.includes('DISPATCH')) return 'dispatched';
  return 'scheduled';
}

const phaseLabels = {
  scheduled: 'SCHEDULED',
  dispatched: 'DISPATCHED · EN ROUTE',
  arrived: 'DESTINATION REACHED'
};

function decorateBooking(booking) {
  const phase = phaseFor(booking);
  return {
    ...booking,
    phase,
    statusLabel: phaseLabels[phase],
    status: phaseLabels[phase],
    dispatchedToday: Boolean(booking.timeline?.dispatchedAt) && isSameUtcDay(booking.timeline.dispatchedAt),
    travelOutcome: travelOutcomes.includes(booking.travelOutcome) ? booking.travelOutcome : 'pending'
  };
}

async function buildBooking(input) {
  const code = await uniqueCode();
  const pnr = randomFrom('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
  const airline = text(input.airline, 60);
  const airlineIata = upper(input.airlineIata, 3) || 'BA';
  const flightNumber = upper(input.flightNumber, 12);
  const depIata = upper(input.depIata, 3);
  const arrIata = upper(input.arrIata, 3);
  const depPoint = AIRPORTS[depIata] || null;
  const arrPoint = AIRPORTS[arrIata] || null;
  const progress = integer(input.progress, 62, 1, 99);
  const cabin = text(input.cabin, 40) || 'Economy';
  const passengerName = text(input.passengerName, 80);
  const seat = upper(input.seat, 5);
  const ticketNumber = `125-${randomFrom('0123456789', 10)}`;
  const depDate = displayDate(text(input.depDate, 10));
  const arrTime = text(input.arrTime, 12);
  const depTime = text(input.depTime, 12);
  const duration = text(input.duration, 12) || '—';
  const base = decimal(input.base, 0);
  const carrierSurcharges = decimal(input.carrierSurcharges, 0);
  const taxes = decimal(input.taxes, 0);
  const total = Math.round((base + carrierSurcharges + taxes) * 100) / 100;
  const distanceTotalKm = depPoint && arrPoint ? haversineKm(depPoint, arrPoint) : 0;
  const heading = depPoint && arrPoint ? bearing(depPoint, arrPoint) : 0;
  const position = depPoint && arrPoint
    ? greatCirclePosition(depPoint, arrPoint, progress / 100)
    : [null, null];
  const issuedAt = new Date().toISOString();
  const departureClock = parseClock(depTime);
  const arrivalClock = parseClock(arrTime);
  const departureMoment = zonedToUtc(text(input.depDate, 10), departureClock, text(input.depTimezone, 50));
  let arrivalMoment = zonedToUtc(text(input.arrDate, 10) || text(input.depDate, 10), arrivalClock, text(input.arrTimezone, 50));
  if (departureMoment && arrivalMoment && arrivalMoment.getTime() <= departureMoment.getTime()) {
    arrivalMoment = new Date(arrivalMoment.getTime() + 24 * 60 * 60 * 1000);
  }
  const travelOutcome = travelOutcomes.includes(text(input.travelOutcome, 20)) ? text(input.travelOutcome, 20) : 'pending';
  const bookedOn = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  }).format(new Date());
  const sequence = `SEQ ${String(crypto.randomInt(1, 240)).padStart(3, '0')}`;
  const group = text(input.group, 20) || 'Group 3';

  return {
    bookingReference: code,
    pnr,
    status: 'SCHEDULED',
    timeline: {
      dispatchedAt: departureMoment ? departureMoment.toISOString() : null,
      arrivesAt: arrivalMoment ? arrivalMoment.toISOString() : null
    },
    travelOutcome,
    gds: text(input.gds, 70) || 'Amadeus Altea · carrier sync',
    issuedAt,
    bookedOn,
    tier: upper(input.tier, 20) || 'STANDARD',
    points: `${Math.round(total / 4).toLocaleString('en-US')} points`,
    airline,
    airlineIata,
    flightNumber,
    callsign: upper(input.callsign, 12) || `${airlineIata}${flightNumber.replace(/\D/g, '')}`,
    departure: {
      iata: depIata,
      icao: upper(input.depIcao, 4) || `X${depIata}`,
      city: text(input.depCity, 60),
      country: text(input.depCountry, 60),
      airport: text(input.depAirport, 90) || `${text(input.depCity, 60)} Airport`,
      terminal: text(input.depTerminal, 8),
      gate: upper(input.depGate, 8),
      scheduled: depTime,
      estimated: `${depTime} (On schedule)`,
      timezone: text(input.depTimezone, 50) || 'UTC',
      lat: depPoint ? depPoint[0] : null,
      lon: depPoint ? depPoint[1] : null,
      weather: text(input.depWeather, 70) || '—'
    },
    arrival: {
      iata: arrIata,
      icao: upper(input.arrIcao, 4) || `X${arrIata}`,
      city: text(input.arrCity, 60),
      country: text(input.arrCountry, 60),
      airport: text(input.arrAirport, 90) || `${text(input.arrCity, 60)} Airport`,
      terminal: text(input.arrTerminal, 8),
      gate: upper(input.arrGate, 8),
      baggage: text(input.arrBaggage, 30),
      scheduled: arrTime,
      estimated: `${arrTime} (On schedule)`,
      timezone: text(input.arrTimezone, 50) || 'UTC',
      lat: arrPoint ? arrPoint[0] : null,
      lon: arrPoint ? arrPoint[1] : null,
      weather: text(input.arrWeather, 70) || '—'
    },
    telemetry: {
      aircraftType: text(input.aircraftType, 60) || 'Airbus A320neo',
      icaoType: upper(input.icaoType, 6) || 'A20N',
      registration: upper(input.registration, 10) || `G-${randomFrom('ABCDEFGHJKLMNPQRSTUVWXYZ', 4)}`,
      icao24: upper(input.icao24, 8) || randomFrom('0123456789ABCDEF', 6),
      altitudeFt: integer(input.altitudeFt, 36000, 0, 60000),
      groundSpeedKts: integer(input.groundSpeedKts, 480, 0, 700),
      mach: decimal(input.mach, 0.82),
      heading: integer(input.heading, heading, 0, 359),
      verticalRate: 0,
      lat: position[0],
      lon: position[1],
      squawk: text(input.squawk, 4) || String(crypto.randomInt(1000, 7777)),
      progress,
      distanceTotalKm,
      distanceFlownKm: Math.round(distanceTotalKm * (progress / 100))
    },
    segments: [
      {
        id: `SEG-${depIata}-${arrIata}`,
        direction: 'Departing flight',
        airline,
        flightNumber,
        aircraft: text(input.aircraftType, 60) || 'Airbus A320neo',
        operatedBy: `Operated by ${airline}`,
        stops: 'Nonstop',
        cabin,
        date: depDate,
        depIata,
        depAirport: text(input.depAirport, 90) || `${text(input.depCity, 60)} Airport`,
        depTime,
        depTerminalGate: `Terminal ${text(input.depTerminal, 8) || '1'} · Gate ${upper(input.depGate, 8) || '—'}`,
        arrIata,
        arrAirport: text(input.arrAirport, 90) || `${text(input.arrCity, 60)} Airport`,
        arrTime,
        arrTerminalGate: `Terminal ${text(input.arrTerminal, 8) || '1'} · Gate ${upper(input.arrGate, 8) || '—'}`,
        duration
      }
    ],
    passengers: [
      {
        fullName: passengerName.toUpperCase() || 'PASSENGER',
        firstName: text(input.passengerName, 80).split(' ')[0] || '',
        middleName: text(input.passengerName, 80).split(' ').slice(1, -1).join(' '),
        lastName: text(input.passengerName, 80).split(' ').slice(-1)[0] || '',
        gender: text(input.gender, 20) || '—',
        ticketNumber,
        seat,
        cabin,
        baggage: text(input.baggage, 60) || '1 × 23 kg checked + 1 cabin bag',
        checkIn: 'BOOKED · CONFIRMED',
        frequentFlyer: text(input.frequentFlyer, 55) || '—',
        ssr: 'DOCS / VERIFIED',
        group,
        sequence,
        fastTrack: Boolean(input.fastTrack),
        requests: text(input.requests, 80) || 'None'
      }
    ],
    fare: {
      currency: upper(input.currency, 3) || 'USD',
      base,
      carrierSurcharges,
      taxes,
      total,
      formOfPayment: text(input.formOfPayment, 40) || 'CARD ···· 0000',
      fareBasis: upper(input.fareBasis, 10) || 'YLPXGB',
      endorsements: text(input.endorsements, 140) || 'NON-REFUNDABLE / CHANGES PERMITTED WITH CARRIER FEE',
      issuingOffice: text(input.issuingOffice, 60) || 'IATA #01492019 / AMADEUS GDS 1A'
    },
    boardingPass: {
      name: ticketName(passengerName),
      flightNumber,
      fromIata: depIata,
      fromCity: text(input.depCity, 60),
      toIata: arrIata,
      toCity: text(input.arrCity, 60),
      gate: upper(input.depGate, 8) || '—',
      terminal: text(input.depTerminal, 8) || '1',
      boardingTime: text(input.boardingTime, 12) || depTime,
      departureTime: depTime,
      seat,
      cabin,
      group,
      sequence,
      ticketNumber,
      pnr,
      baggageTag: `TAG: ${airlineIata} ${randomFrom('0123456789', 7)} (1 PCS / 23KG)`,
      barcode: `M1${ticketName(passengerName).replace(/[^A-Z0-9]/g, '')} E${pnr}${depIata}${arrIata}${airlineIata}${flightNumber.replace(/\D/g, '')} 021Y${seat.padStart(3, '0')} 100`
    },
    createdBy: 'admin'
  };
}

/* ------------------------------------------------------------------ */
/* Parcel tracking                                                     */
/* ------------------------------------------------------------------ */

const shipmentStatuses = ['registered', 'in_transit', 'out_for_delivery', 'delivered', 'on_hold'];

const shipmentStatusLabels = {
  registered: 'REGISTERED',
  in_transit: 'IN TRANSIT',
  out_for_delivery: 'OUT FOR DELIVERY',
  delivered: 'DELIVERED',
  on_hold: 'ON HOLD'
};

const shipmentProgress = {
  registered: 8,
  in_transit: 48,
  out_for_delivery: 84,
  delivered: 100,
  on_hold: 48
};

async function readShipmentRow(code) {
  if (!code) return null;
  const { rows } = await pool.query('SELECT payload FROM shipments WHERE code = $1', [code]);
  return rows[0]?.payload ? parsePayload(rows[0].payload) : null;
}

async function allShipments() {
  const { rows } = await pool.query('SELECT payload, created_at FROM shipments ORDER BY created_at DESC');
  return rows.map((row) => ({
    ...parsePayload(row.payload),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
  }));
}

async function uniqueShipmentCode() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = `SHPX-${randomFrom(CODE_ALPHABET, 6)}`;
    if (!(await readShipmentRow(code))) return code;
  }
  throw new Error('Could not allocate a unique tracking number.');
}

function isoOr(value, fallback) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

// The scan history is derived from the parcel's stage, so the desk only ever
// moves a shipment between stages instead of editing individual scans.
function shipmentEvents(shipment) {
  const registered = Date.parse(shipment.registeredAt) || Date.now();
  const eta = Date.parse(shipment.etaAt) || registered + 72 * 60 * 60 * 1000;
  const deliveredAt = Date.parse(shipment.deliveredAt);
  // Scans never run ahead of the clock, and a delivered parcel's history stops
  // at the moment it was signed for.
  const horizon = shipment.status === 'delivered' && Number.isFinite(deliveredAt)
    ? deliveredAt
    : Math.min(eta, Date.now());
  // Scans are spread backwards from the horizon so a parcel dispatched and
  // delivered minutes later still shows a believable sequence.
  const span = Math.max(horizon - registered, 6 * 60 * 60 * 1000);
  const at = (fraction) => new Date(Math.max(registered, horizon - (1 - fraction) * span)).toISOString();
  const pieceLine = `${shipment.pieces} piece${shipment.pieces === 1 ? '' : 's'} · ${shipment.weightKg} kg`;
  const events = [
    { at: new Date(Math.min(registered, horizon)).toISOString(), label: 'Shipment information received', location: shipment.origin, note: 'Label created and data transmitted to the network.' },
    { at: at(0.16), label: 'Picked up from sender', location: shipment.origin, note: pieceLine },
    { at: at(0.38), label: 'Departed origin facility', location: shipment.origin, note: 'Loaded for linehaul to the destination country.' }
  ];

  if (shipment.status !== 'registered') {
    events.push({ at: at(0.58), label: 'Arrived at transit hub', location: shipment.hub, note: 'Scanned in and sorted for onward carriage.' });
  }
  if (shipment.status === 'out_for_delivery' || shipment.status === 'delivered') {
    events.push({ at: at(0.9), label: 'Out for delivery', location: shipment.destination, note: 'With the delivery courier for the final leg.' });
  }
  if (shipment.status === 'delivered') {
    events.push({
      at: new Date(horizon).toISOString(),
      label: 'Delivered · signed for',
      location: shipment.destination,
      note: `Received by ${shipment.recipientName}.`
    });
  }
  if (shipment.status === 'on_hold') {
    events.push({
      at: new Date(Math.min(Date.parse(shipment.updatedAt) || Date.now(), Date.now())).toISOString(),
      label: 'Held at facility',
      location: shipment.destination,
      note: shipment.holdReason || 'Awaiting clearance or recipient instruction.'
    });
  }

  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const shipmentDefaults = {
  serviceLevel: 'Express · door to door',
  courier: 'Shiparox Air',
  agent: 'Unassigned',
  vehicle: '—',
  window: '09:00–13:00',
  declaredValue: 0,
  currency: 'USD',
  insured: false,
  customs: 'cleared',
  holdReason: ''
};

const customsStates = {
  cleared: 'CLEARED',
  pending: 'AWAITING CLEARANCE',
  not_required: 'NOT REQUIRED'
};

function decorateShipment(shipment) {
  const merged = { ...shipmentDefaults, ...shipment };
  const status = shipmentStatuses.includes(merged.status) ? merged.status : 'registered';
  const events = shipmentEvents({ ...merged, status });
  const registered = Date.parse(merged.registeredAt);
  const eta = Date.parse(merged.etaAt);
  const barcodeDigits = squash(merged.trackingNumber).slice(-6).padEnd(6, '0');
  return {
    ...merged,
    status,
    statusLabel: shipmentStatusLabels[status],
    progress: shipmentProgress[status],
    signedBy: merged.signedBy || merged.recipientName,
    customsLabel: customsStates[merged.customs] || customsStates.cleared,
    transitHours: Number.isFinite(registered) && Number.isFinite(eta)
      ? Math.max(1, Math.round((eta - registered) / (60 * 60 * 1000)))
      : null,
    barcode: `SHPX ${barcodeDigits.replace(/(\d{3})(\d{3})/, '$1 $2')} ${squash(merged.trackingNumber).slice(0, 2)}`,
    events: events.slice().reverse(),
    lastEvent: events[events.length - 1] || null
  };
}

const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_SHIPMENT_IMAGES = 6;
const MAX_IMAGE_CHARS = 700_000;

// Parcel photos travel inside the shipment payload as data URLs: Render's disk
// is ephemeral, so keeping them in the Neon record is what survives a restart.
function shipmentImages(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((value) => typeof value === 'string'
      && value.length <= MAX_IMAGE_CHARS
      && IMAGE_DATA_URL.test(value))
    .slice(0, MAX_SHIPMENT_IMAGES);
}

function buildShipment(input, code) {
  const now = new Date().toISOString();
  const status = shipmentStatuses.includes(text(input.status, 20)) ? text(input.status, 20) : 'registered';
  const registeredAt = isoOr(input.registeredAt, now);
  const etaAt = isoOr(input.etaAt, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString());
  const shipment = {
    trackingNumber: code || `SHPX-${randomFrom(CODE_ALPHABET, 6)}`,
    status,
    service: text(input.service, 60) || 'Shiparox Express',
    reference: text(input.reference, 40),
    origin: text(input.origin, 90),
    destination: text(input.destination, 90),
    hub: text(input.hub, 90) || 'Regional transit hub',
    senderName: text(input.senderName, 80),
    senderPhone: text(input.senderPhone, 32),
    senderEmail: text(input.senderEmail, 120).toLowerCase(),
    recipientName: text(input.recipientName, 80),
    recipientPhone: text(input.recipientPhone, 32),
    recipientEmail: text(input.recipientEmail, 120).toLowerCase(),
    contents: text(input.contents, 120),
    pieces: integer(input.pieces, 1, 1, 999),
    weightKg: decimal(input.weightKg, 1),
    serviceLevel: text(input.serviceLevel, 40) || shipmentDefaults.serviceLevel,
    courier: text(input.courier, 80) || shipmentDefaults.courier,
    agent: text(input.agent, 60) || shipmentDefaults.agent,
    vehicle: text(input.vehicle, 60) || shipmentDefaults.vehicle,
    window: text(input.window, 40) || shipmentDefaults.window,
    declaredValue: decimal(input.declaredValue, 0),
    currency: (upper(input.currency, 3) || shipmentDefaults.currency),
    insured: input.insured === true || input.insured === 'true' || input.insured === 'on',
    customs: Object.hasOwn(customsStates, text(input.customs, 20)) ? text(input.customs, 20) : shipmentDefaults.customs,
    signedBy: text(input.signedBy, 80),
    images: shipmentImages(input.images),
    registeredAt,
    etaAt,
    deliveredAt: status === 'delivered' ? isoOr(input.deliveredAt, now) : null,
    holdReason: text(input.holdReason, 120),
    createdAt: now,
    updatedAt: now
  };
  return { ...shipment, events: shipmentEvents(shipment) };
}

/* ------------------------------------------------------------------ */
/* App setup                                                           */
/* ------------------------------------------------------------------ */

app.disable('x-powered-by');
// Parcel photos arrive as data URLs, so that one route gets a larger body.
app.use('/api/admin/shipments', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (req.path === '/admin' || req.path === '/admin.html' || req.path.startsWith('/admin/')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  next();
});

const supportCategories = [
  'Booking & ticket verification',
  'Passenger manifest correction',
  'Flight delay / schedule change',
  'Baggage & seat assignment',
  'Urgent dispatch escalation'
];

function readJsonFile(file, fallback) {
  return fs.readFile(file, 'utf8')
    .then((content) => JSON.parse(content))
    .catch((error) => {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    });
}

/* ------------------------------------------------------------------ */
/* Support email delivery                                              */
/* Resend API key → HTTPS mail relay (no account) → logged only        */
/* ------------------------------------------------------------------ */

// SUPPORT_EMAIL accepts a comma-separated list, so a second inbox can be added
// without a code change.
const supportRecipients = String(process.env.SUPPORT_EMAIL || 'support.sbiamautos@gmail.com')
  .split(',')
  .map((address) => address.trim())
  .filter(Boolean);
const supportRecipient = supportRecipients[0];
const supportSender = String(process.env.SUPPORT_FROM || 'airopack desk <onboarding@resend.dev>').trim();
const resendApiKey = String(process.env.RESEND_API_KEY || '').trim();

// Brevo only needs a single-click sender verification, so it can deliver to a
// normal inbox without owning a domain. It is the preferred transport.
const brevoApiKey = String(process.env.BREVO_API_KEY || '').trim();
const brevoApiUrl = String(process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email').trim();
const brevoSenderEmail = String(process.env.BREVO_SENDER || supportRecipient).trim();
const brevoSenderName = String(process.env.BREVO_SENDER_NAME || 'AiroPack desk').trim();

// Render's free tier blocks outbound SMTP, so without a Resend key the request
// goes out over HTTPS through a no-account mail relay (formsubmit.co) instead.
const supportFormEndpoint = (() => {
  const configured = String(process.env.SUPPORT_FORM_ENDPOINT || '').trim();
  if (configured) return /^(off|none|disabled|false)$/i.test(configured) ? '' : configured;
  return 'https://formsubmit.co/ajax/';
})();

const relayEndpointFor = (recipient) => (supportFormEndpoint.endsWith('/')
  ? `${supportFormEndpoint}${recipient}`
  : supportFormEndpoint);

// The relay only accepts browser-shaped posts, so present one.
const supportFormOrigin = String(process.env.SUPPORT_FORM_ORIGIN || 'https://flightverifyer.onrender.com').replace(/\/$/, '');
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[char]));

async function sendViaFormRelay(request, subject, endpoint) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: supportFormOrigin,
      Referer: `${supportFormOrigin}/`,
      'User-Agent': BROWSER_UA
    },
    body: JSON.stringify({
      _subject: subject,
      _template: 'table',
      _captcha: 'false',
      _replyto: request.email,
      Reference: request.reference,
      Name: request.name,
      Email: request.email,
      Category: request.category,
      Priority: request.priority,
      Received: request.createdAt,
      Message: request.message
    }),
    signal: AbortSignal.timeout(10_000)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || String(payload.success) === 'false') {
    const message = String(payload.message || `Mail relay responded ${response.status}`);
    if (/activation/i.test(message)) {
      throw new Error(`${message} — open the confirmation email sent to ${supportRecipient} and activate the form once.`);
    }
    throw new Error(message);
  }

  return true;
}

async function emailSupportRequest(request) {
  if (!brevoApiKey && !resendApiKey && !supportFormEndpoint) {
    console.warn('[support] No mail transport configured (BREVO_API_KEY, RESEND_API_KEY or SUPPORT_FORM_ENDPOINT); the request was saved but not emailed.');
    return false;
  }

  const subject = `[${request.reference}] ${request.category} — ${request.priority}`;

  const fields = [
    ['Reference', request.reference],
    ['Name', request.name],
    ['Email', request.email],
    ['Category', request.category],
    ['Priority', request.priority],
    ['Received', request.createdAt]
  ];

  const text = [
    `New support request ${request.reference}`,
    '',
    ...fields.map(([label, value]) => `${label}: ${value}`),
    '',
    'Message:',
    request.message
  ].join('\n');

  const rows = fields
    .map(([label, value]) => `<tr><td style="padding:5px 16px 5px 0;font:600 10px/1.5 Helvetica,Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#7b7466;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:5px 0;font:14px/1.5 Helvetica,Arial,sans-serif;color:#16211f">${escapeHtml(value)}</td></tr>`)
    .join('');

  const html = `<!doctype html><html><body style="margin:0;padding:28px;background:#f7f2e8">
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:620px;margin:0 auto;background:#fffdf8;border:1px solid #e3dbca;border-top:3px solid #d9481f">
    <tr><td style="padding:22px 24px;border-bottom:1px solid #efe7d7">
      <p style="margin:0;font:11px/1.4 Helvetica,Arial,sans-serif;letter-spacing:.22em;text-transform:uppercase;color:#7b7466">airopack · support desk</p>
      <h1 style="margin:8px 0 0;font:400 25px/1.2 Georgia,'Times New Roman',serif;color:#16211f">New support request</h1>
      <p style="margin:6px 0 0;font:13px/1.5 Helvetica,Arial,sans-serif;color:#5b665f">Ticket <b>${escapeHtml(request.reference)}</b> · ${escapeHtml(request.category)}</p>
    </td></tr>
    <tr><td style="padding:20px 24px">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%">${rows}</table>
      <p style="margin:20px 0 6px;font:600 10px/1.5 Helvetica,Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#7b7466">Message</p>
      <div style="padding:16px;background:#faf6ec;border-left:2px solid #d9481f;font:14px/1.65 Helvetica,Arial,sans-serif;color:#16211f;white-space:pre-wrap">${escapeHtml(request.message)}</div>
      <p style="margin:20px 0 0;font:12px/1.6 Helvetica,Arial,sans-serif;color:#5b665f">Reply directly to this email to answer <b>${escapeHtml(request.name)}</b> at ${escapeHtml(request.email)}.</p>
    </td></tr>
    <tr><td style="padding:14px 24px;border-top:1px solid #efe7d7;font:10px/1.6 Helvetica,Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#9a9285">airopack · verification ledger</td></tr>
  </table>
</body></html>`;

  const failures = [];

  if (brevoApiKey) {
    try {
      const response = await fetch(brevoApiUrl, {
        method: 'POST',
        headers: {
          'api-key': brevoApiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          sender: { name: brevoSenderName, email: brevoSenderEmail },
          to: supportRecipients.map((address) => ({ email: address })),
          replyTo: { email: request.email, name: request.name },
          subject,
          htmlContent: html,
          textContent: text
        }),
        signal: AbortSignal.timeout(10_000)
      });

      if (response.ok) {
        console.log(`[support] ${request.reference} emailed to ${supportRecipients.join(', ')} via Brevo`);
        return true;
      }

      const detail = await response.text().catch(() => '');
      throw new Error(`Brevo responded ${response.status}: ${detail.slice(0, 300)}`);
    } catch (error) {
      failures.push(`Brevo: ${error.message}`);
    }
  }

  // Every keyed transport gets a turn, and the relay still gets a chance, so one
  // broken transport never swallows a request.
  if (resendApiKey) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: supportSender,
          to: supportRecipients,
          reply_to: request.email,
          subject,
          text,
          html
        }),
        signal: AbortSignal.timeout(10_000)
      });

      if (response.ok) {
        console.log(`[support] ${request.reference} emailed to ${supportRecipients.join(', ')} via Resend`);
        return true;
      }

      const detail = await response.text().catch(() => '');
      throw new Error(`Resend responded ${response.status}: ${detail.slice(0, 300)}`);
    } catch (error) {
      failures.push(`Resend: ${error.message}`);
    }
  }

  if (supportFormEndpoint) {
    let delivered = 0;
    for (const recipient of supportRecipients) {
      try {
        await sendViaFormRelay(request, subject, relayEndpointFor(recipient));
        console.log(`[support] ${request.reference} emailed to ${recipient} via the HTTPS relay`);
        delivered += 1;
      } catch (error) {
        failures.push(`relay → ${recipient}: ${error.message}`);
      }
    }
    if (delivered > 0) return true;
  }

  throw new Error(failures.join(' · ') || 'No mail transport is configured.');
}

// Support requests are kept in Neon as well as in the local JSON file: Render's
// disk is ephemeral, and the admin console has to be able to read every ticket
// even when no mail transport is configured.
async function saveSupportRequest(request) {
  if (!pool) return false;
  try {
    await pool.query(
      'INSERT INTO support_requests (id, payload, created_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload',
      [request.id, JSON.stringify(request), request.createdAt]
    );
    return true;
  } catch (error) {
    console.error(`[support] could not store ${request.reference} in Postgres:`, error.message);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Admin routes (before static so it stays unlinked and noindexed)      */
/* ------------------------------------------------------------------ */

app.get(['/admin', '/admin/'], (req, res) => {
  res.sendFile(path.join(publicDirectory, 'admin.html'));
});

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.resetAt > Date.now() && attempt.count >= 8) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!safeEqual(email, adminEmail) || !safeEqual(password, adminPassword)) {
    const current = attempt && attempt.resetAt > Date.now()
      ? { count: attempt.count + 1, resetAt: attempt.resetAt }
      : { count: 1, resetAt: Date.now() + 1000 * 60 * 10 };
    loginAttempts.set(ip, current);
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }

  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { email: adminEmail, expiresAt: Date.now() + sessionLifetime });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `vmf_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}${secure}`);
  res.json({ email: adminEmail });
});

app.post('/api/admin/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).vmf_admin;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'vmf_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ signedOut: true });
});

app.get('/api/admin/session', requireAdmin, (req, res) => {
  res.json({ email: req.admin.email });
});

app.get('/api/admin/bookings', requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
  const rows = (await allBookings()).map((raw) => {
    const booking = decorateBooking(raw);
    return {
      code: booking.bookingReference,
      pnr: booking.pnr,
      airline: booking.airline,
      flightNumber: booking.flightNumber,
      route: `${booking.departure?.iata || '—'} → ${booking.arrival?.iata || '—'}`,
      passenger: booking.passengers?.[0]?.fullName || '—',
      status: booking.statusLabel,
      phase: booking.phase,
      outcome: booking.travelOutcome,
      createdAt: booking.createdAt || booking.issuedAt
    };
  });
  res.json({ bookings: rows });
}));

app.post('/api/admin/bookings', requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
  const input = req.body || {};
  const required = {
    airline: 'airline',
    flightNumber: 'flight number',
    depIata: 'departure airport code',
    depCity: 'departure city',
    arrIata: 'arrival airport code',
    arrCity: 'arrival city',
    depDate: 'departure date',
    depTime: 'departure time',
    arrTime: 'arrival time',
    passengerName: 'passenger name',
    seat: 'seat',
    cabin: 'cabin'
  };
  const missing = Object.entries(required)
    .filter(([key]) => text(input[key]).length === 0)
    .map(([, label]) => label);
  if (missing.length) {
    return res.status(400).json({ error: `Complete these fields: ${missing.join(', ')}.` });
  }
  if (!/^[A-Za-z]{3}$/.test(text(input.depIata)) || !/^[A-Za-z]{3}$/.test(text(input.arrIata))) {
    return res.status(400).json({ error: 'Airport codes must be three letters (IATA).' });
  }
  if (text(input.depIata).toUpperCase() === text(input.arrIata).toUpperCase()) {
    return res.status(400).json({ error: 'Departure and arrival airports must be different.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(input.depDate))) {
    return res.status(400).json({ error: 'Departure date must use the date picker.' });
  }
  if (decimal(input.base) < 0 || decimal(input.taxes) < 0 || decimal(input.carrierSurcharges) < 0) {
    return res.status(400).json({ error: 'Fare amounts cannot be negative.' });
  }

  const booking = await buildBooking(input);
  await pool.query(
    `INSERT INTO bookings (code, payload, created_at) VALUES ($1, $2::jsonb, $3)`,
    [booking.bookingReference, JSON.stringify(booking), booking.issuedAt]
  );
  res.status(201).json({ code: booking.bookingReference, booking: decorateBooking(booking) });
}));

app.patch('/api/admin/bookings/:code/outcome', requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const outcome = String(req.body?.outcome || '').toLowerCase();
  if (!travelOutcomes.includes(outcome)) {
    return res.status(400).json({ error: 'Choose pending, boarded or missed.' });
  }
  const booking = await findBooking(code);
  if (!booking) return res.status(404).json({ error: 'Record not found.' });
  const updated = { ...booking, travelOutcome: outcome, outcomeUpdatedAt: new Date().toISOString() };
  await pool.query(
    `UPDATE bookings SET payload = $2::jsonb
     WHERE code = $1 OR payload->>'bookingReference' = $1 OR payload->>'pnr' = $1`,
    [code, JSON.stringify(updated)]
  );
  res.json({ code: booking.bookingReference, travelOutcome: outcome });
}));

app.delete('/api/admin/bookings/:code', requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const result = await pool.query(
    `DELETE FROM bookings
     WHERE code = $1 OR payload->>'bookingReference' = $1 OR payload->>'pnr' = $1`,
    [code]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Record not found.' });
  res.json({ deleted: code });
}));

app.get('/api/admin/shipments', requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
  const rows = (await allShipments()).map((raw) => {
    const shipment = decorateShipment(raw);
    return {
      code: shipment.trackingNumber,
      service: shipment.service,
      route: `${shipment.origin} → ${shipment.destination}`,
      recipient: shipment.recipientName,
      recipientPhone: shipment.recipientPhone,
      status: shipment.statusLabel,
      statusKey: shipment.status,
      eta: shipment.etaAt,
      createdAt: shipment.createdAt || shipment.registeredAt
    };
  });
  res.json({ shipments: rows });
}));

app.post('/api/admin/shipments', requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
  const input = req.body || {};
  const required = {
    origin: 'origin',
    destination: 'destination',
    recipientName: 'recipient name',
    contents: 'contents'
  };
  const missing = Object.entries(required)
    .filter(([key]) => text(input[key]).length === 0)
    .map(([, label]) => label);
  if (missing.length) {
    return res.status(400).json({ error: `Complete these fields: ${missing.join(', ')}.` });
  }
  if (text(input.etaAt) && !Number.isFinite(Date.parse(text(input.etaAt)))) {
    return res.status(400).json({ error: 'Estimated delivery must use the date picker.' });
  }

  const code = await uniqueShipmentCode();
  const shipment = buildShipment(input, code);
  await pool.query(
    'INSERT INTO shipments (code, payload, created_at) VALUES ($1, $2::jsonb, $3)',
    [code, JSON.stringify(shipment), shipment.createdAt]
  );
  res.status(201).json({ code, shipment: decorateShipment(shipment) });
}));

app.patch('/api/admin/shipments/:code', requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const status = String(req.body?.status || '');
  if (!shipmentStatuses.includes(status)) {
    return res.status(400).json({ error: 'Choose registered, in transit, out for delivery, delivered or on hold.' });
  }
  const shipment = await readShipmentRow(code);
  if (!shipment) return res.status(404).json({ error: 'Shipment not found.' });
  const updated = {
    ...shipment,
    status,
    updatedAt: new Date().toISOString(),
    deliveredAt: status === 'delivered' ? (shipment.deliveredAt || new Date().toISOString()) : null,
    holdReason: status === 'on_hold' ? (text(req.body?.holdReason, 120) || shipment.holdReason) : ''
  };
  updated.events = shipmentEvents(updated);
  await pool.query('UPDATE shipments SET payload = $2::jsonb WHERE code = $1', [code, JSON.stringify(updated)]);
  res.json({ code, shipment: decorateShipment(updated) });
}));

app.delete('/api/admin/shipments/:code', requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const result = await pool.query('DELETE FROM shipments WHERE code = $1', [code]);
  if (!result.rowCount) return res.status(404).json({ error: 'Shipment not found.' });
  res.json({ deleted: code });
}));

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

app.use(express.static(publicDirectory, { extensions: ['html'] }));

// Dedicated verification page; the client app renders the dossier for this path.
app.get('/verify/:code', (req, res) => {
  res.sendFile(path.join(publicDirectory, 'index.html'));
});

// Parcel tracking: /track looks a parcel up, /track/:code is its own dossier page.
app.get('/track/:code', (req, res) => {
  res.sendFile(path.join(publicDirectory, 'parcel.html'));
});

const normaliseCode = (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, '');

/* Lightweight liveness probe for uptime monitors and Render's health check.
   Deliberately does not query Postgres so keep-alive pings do not consume
   Neon free-tier compute hours. */
app.get('/api/ping', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, service: 'airopack', uptime: Math.round(process.uptime()) });
});

app.get('/api/health', asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).json({ ok: false, database: 'not configured' });
  const { rows } = await pool.query('SELECT COUNT(*) AS count FROM bookings');
  res.json({ ok: true, database: 'neon', records: Number(rows[0].count) });
}));

app.get('/api/verify/:code', requireDatabase, asyncRoute(async (req, res) => {
  const code = normaliseCode(req.params.code);
  if (!code || code.length < 4 || code.length > 40) {
    return res.status(400).json({ error: 'Enter a booking reference, ticket number or six-character PNR.' });
  }
  const booking = await findBooking(code);
  if (!booking) {
    return res.status(404).json({
      error: `No active record matches ${code}. Check the reference and try again, or contact the support desk.`
    });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    booking: decorateBooking(booking),
    verifiedAt: new Date().toISOString(),
    source: 'AiroPack verification ledger'
  });
}));

app.get('/api/track/:code', requireDatabase, asyncRoute(async (req, res) => {
  const code = normaliseCode(req.params.code);
  if (!/^SHPX-[A-Z0-9]{4,10}$/.test(code)) {
    return res.status(400).json({ error: 'Enter a tracking number in the form SHPX-XXXXXX.' });
  }
  const shipment = await readShipmentRow(code);
  if (!shipment) {
    return res.status(404).json({ error: `No parcel matches ${code}. Check the number and try again, or contact the support desk.` });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    shipment: decorateShipment(shipment),
    checkedAt: new Date().toISOString(),
    source: 'AiroPack parcel desk'
  });
}));

app.post('/api/support', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const category = String(req.body?.category || '').trim();
    const priority = String(req.body?.priority || 'Standard').trim();
    const message = String(req.body?.message || '').trim();

    if (name.length < 2 || name.length > 90) {
      return res.status(400).json({ error: 'Enter the passenger name for this request.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
      return res.status(400).json({ error: 'Enter a valid email address so the desk can reply.' });
    }
    if (!supportCategories.includes(category)) {
      return res.status(400).json({ error: 'Choose a support category.' });
    }
    if (!['Standard', 'High — flying within 24h', 'Urgent — at airport'].includes(priority)) {
      return res.status(400).json({ error: 'Choose a priority level.' });
    }
    if (message.length < 12 || message.length > 2000) {
      return res.status(400).json({ error: 'Describe the request in at least 12 characters.' });
    }

    const request = {
      id: crypto.randomUUID(),
      reference: `SUP-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      name,
      email,
      category,
      priority,
      message,
      status: 'received',
      createdAt: new Date().toISOString()
    };

    const existing = await readJsonFile(supportFile, []);
    existing.unshift(request);
    await fs.mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${supportFile}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(existing.slice(0, 500), null, 2));
    await fs.rename(temporaryFile, supportFile);

    let emailed = false;
    try {
      emailed = await emailSupportRequest(request);
    } catch (error) {
      console.error(`[support] email delivery failed for ${request.reference}:`, error.message);
    }

    await saveSupportRequest({ ...request, emailed });

    res.status(201).json({ reference: request.reference, receivedAt: request.createdAt, emailed });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/support', requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT payload FROM support_requests ORDER BY created_at DESC LIMIT 100');
  res.json({ requests: rows.map((row) => parsePayload(row.payload)) });
}));

// Delivery can be retried from the console once a mail key is in place, so a
// ticket that arrived while mail was broken is not stranded.
app.post('/api/admin/support/:id/email', requireAdmin, requireDatabase, asyncRoute(async (req, res) => {
  const { rows } = await pool.query('SELECT payload FROM support_requests WHERE id = $1', [String(req.params.id)]);
  if (!rows.length) {
    return res.status(404).json({ error: 'That support request is no longer stored.' });
  }

  const request = parsePayload(rows[0].payload);
  if (!brevoApiKey && !resendApiKey && !supportFormEndpoint) {
    return res.status(409).json({ error: 'No mail transport is configured yet. Add BREVO_API_KEY in Render, then try again.' });
  }

  try {
    await emailSupportRequest(request);
  } catch (error) {
    console.error(`[support] retry failed for ${request.reference}:`, error.message);
    return res.status(502).json({ error: `Mail could not be sent. ${error.message}` });
  }

  await saveSupportRequest({ ...request, emailed: true });
  console.log(`[support] ${request.reference} re-sent from the console`);
  res.json({ emailed: true });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(publicDirectory, 'index.html'));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That upload is too large. Send fewer or smaller photos.' });
  }
  console.error(error);
  res.status(500).json({ error: 'The verification desk could not complete that request.' });
});

initWithRetry().then((ready) => {
  databaseReady = ready;
  app.listen(port, () => {
    console.log(`AiroPack desk listening on http://localhost:${port}`);
    console.log(`[db] Neon Postgres ${ready ? 'connected' : 'NOT connected'}`);
    console.log(`[support] requests email to ${supportRecipients.join(', ')} via ${brevoApiKey ? 'Brevo' : resendApiKey ? 'Resend' : supportFormEndpoint ? 'the FormSubmit relay' : 'no transport (not emailed)'}`);
    if (usingDefaultCredentials) {
      console.warn('[admin] Using default sign-in admin@verifymyflight.local / verify-admin-2026 — set ADMIN_EMAIL and ADMIN_PASSWORD before deploying.');
    }
  });
});
