'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  booking: null,
  verifying: false,
  lastFocus: null
};

const els = {
  form: $('#verify-form'),
  input: $('#code'),
  button: $('#verify-button'),
  status: $('#verify-status'),
  result: $('#result')
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[character]));

const money = (value, currency = 'USD') => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency,
  maximumFractionDigits: 2
}).format(Number(value) || 0);

const number = (value) => new Intl.NumberFormat('en-US').format(Number(value) || 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setStatus(message, mode = 'info') {
  els.status.textContent = message;
  if (mode === 'error') {
    els.status.dataset.state = 'error';
  } else {
    delete els.status.dataset.state;
  }
}

function setBusy(busy) {
  state.verifying = busy;
  els.button.disabled = busy;
  els.button.textContent = busy ? 'Checking…' : 'Check record';
  els.input.disabled = busy;
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

const steps = [
  'Normalising reference',
  'Querying reservation ledger',
  'Reconciling carrier record',
  'Attaching manifest & telemetry'
];

async function verify(rawCode) {
  if (state.verifying) return;
  const code = String(rawCode || '').trim().toUpperCase();
  if (code.length < 4) {
    setStatus('Enter at least four characters of a booking reference, e-ticket or PNR.', 'error');
    els.input.focus();
    return;
  }

  setBusy(true);
  let step = 0;
  setStatus(`${steps[0]}…`);
  const ticker = setInterval(() => {
    step = Math.min(step + 1, steps.length - 1);
    setStatus(`${steps[step]}…`);
  }, 340);

  try {
    const [response] = await Promise.all([
      fetch(`/api/verify/${encodeURIComponent(code)}`, {
        headers: { Accept: 'application/json' }
      }),
      sleep(1100)
    ]);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'That reference could not be verified.');

    clearInterval(ticker);
    setStatus(`Record verified · ${payload.booking.bookingReference}`);
    state.booking = payload.booking;
    const dossierPath = `/verify/${encodeURIComponent(payload.booking.bookingReference)}`;
    if (location.pathname !== dossierPath) {
      history.pushState({ code: payload.booking.bookingReference }, '', dossierPath);
    }
    document.body.classList.add('verify-page');
    document.title = `Dossier ${payload.booking.bookingReference} · VerifyMyFlight`;
    renderDossier(payload.booking, payload);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    clearInterval(ticker);
    const message = error.message || 'The desk could not reach the ledger. Try again.';
    setStatus(message, 'error');
    if (document.body.classList.contains('verify-page')) renderVerifyError(message, code);
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ */
/* Dossier rendering                                                   */
/* ------------------------------------------------------------------ */

function endpointMarkup(endpoint, kind, flight) {
  const labels = kind === 'departure'
    ? `<div>Terminal ${esc(endpoint.terminal)} · Gate ${esc(endpoint.gate)}</div><div>${esc(endpoint.scheduled)}</div>`
    : `<div>Terminal ${esc(endpoint.terminal)} · Gate ${esc(endpoint.gate)}</div><div>${esc(endpoint.scheduled)}</div><div>Baggage ${esc(endpoint.baggage)}</div>`;

  return `
    <div class="endpoint endpoint--${kind}">
      <p class="endpoint-code">${esc(endpoint.iata)}</p>
      <p class="endpoint-city">${esc(endpoint.city)}, ${esc(endpoint.country)}</p>
      <p class="endpoint-airport">${esc(endpoint.airport)}</p>
      <div class="endpoint-meta">
        ${labels}
        <div>${esc(endpoint.estimated)}</div>
        <div>${esc(endpoint.weather)}</div>
      </div>
    </div>`;
}

function barcodeMarkup(value) {
  const codes = Array.from(String(value)).map((character) => character.charCodeAt(0));
  const bars = Array.from({ length: 68 }, (_, index) => {
    const code = codes[index % codes.length];
    const width = 1 + ((code + index * 5) % 3);
    const short = (code + index) % 6 === 0;
    return `<i${short ? ' class="short"' : ''} style="width:${width}px"></i>`;
  });
  return bars.join('');
}

function renderDossier(booking, payload) {
  const { departure, arrival, telemetry, fare, boardingPass } = booking;
  const passengers = booking.passengers || [];
  const lead = passengers[0] || {};
  const hasPosition = Number.isFinite(telemetry.lat) && Number.isFinite(telemetry.lon);
  const phase = booking.phase || 'scheduled';
  const timeline = booking.timeline || {};
  const statusText = booking.statusLabel || booking.status || 'SCHEDULED';
  const statusClass = phase === 'arrived'
    ? 'status-pill--arrived'
    : phase === 'dispatched' ? 'status-pill--live' : 'status-pill--scheduled';
  const stamp = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
    })} UTC`;
  };
  const phaseIndex = phase === 'arrived' ? 2 : phase === 'dispatched' ? 1 : 0;
  const phaseSteps = [
    ['Scheduled', `Ticket issued · ${booking.bookedOn || '—'}`],
    ['Dispatched', timeline.dispatchedAt ? `Departed ${stamp(timeline.dispatchedAt)}` : (phase === 'dispatched' ? 'In progress · time not recorded' : 'Awaiting departure')],
    ['Destination reached', timeline.arrivesAt ? `${phase === 'arrived' ? 'Arrived' : 'Due'} ${stamp(timeline.arrivesAt)}` : (phase === 'arrived' ? 'Reached · time not recorded' : 'On arrival')]
  ];
  const phaseMarkup = `<ol class="phase-track">${phaseSteps.map(([label, detail], index) => `
    <li class="phase ${index <= phaseIndex ? 'is-reached' : ''} ${index === phaseIndex ? 'is-current' : ''}">
      <span class="phase-node" aria-hidden="true"></span>
      <b>${label}</b>
      <small>${esc(detail)}</small>
    </li>`).join('')}</ol>`;
  const outcome = booking.travelOutcome || 'pending';
  const outcomeCopy = {
    pending: ['Awaiting confirmation', 'The desk has not recorded a travel outcome for this passenger yet.'],
    boarded: ['Boarded · travelled', 'The airline record shows this passenger checked in and boarded this flight.'],
    missed: ['Flight missed', 'The record shows this passenger did not travel on this flight. Contact the support desk if that is incorrect.']
  }[outcome] || ['Awaiting confirmation', 'The desk has not recorded a travel outcome yet.'];
  const verifiedAt = new Date(payload.verifiedAt || Date.now());
  const verifiedLabel = verifiedAt.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
  });

  const sectorMarkup = (booking.segments || []).map((segment) => `
    <div class="sector">
      <div>
        <p class="sector-direction">${esc(segment.direction)}</p>
        <p class="sector-flight">${esc(segment.airline)} ${esc(segment.flightNumber)}</p>
        <p class="sector-aircraft">${esc(segment.aircraft)} · ${esc(segment.operatedBy)}</p>
        <div class="sector-tags">
          <span class="tag">${esc(segment.cabin)}</span>
          <span class="tag">${esc(segment.stops)}</span>
          <span class="tag">${esc(segment.duration)}</span>
        </div>
      </div>
      <div class="sector-times">
        <div class="sector-leg"><b>${esc(segment.depIata)}</b><span>${esc(segment.depAirport)}<br>${esc(segment.depTerminalGate)}</span><em>${esc(segment.depTime)}</em></div>
        <div class="sector-leg"><b>${esc(segment.arrIata)}</b><span>${esc(segment.arrAirport)}<br>${esc(segment.arrTerminalGate)}</span><em>${esc(segment.arrTime)}</em></div>
        <div class="sector-leg"><b>${esc(segment.date)}</b><span>Local departure date</span><em>${esc(segment.duration)}</em></div>
      </div>
    </div>`).join('');

  const passengerMarkup = passengers.map((passenger, index) => `
    <article class="passenger">
      <div class="passenger-head">
        <div>
          <p class="passenger-role">${index === 0 ? 'Primary passenger' : `Passenger ${index + 1}`}</p>
          <p class="passenger-name">${esc(passenger.fullName)}</p>
        </div>
        <span class="tag">${esc(passenger.checkIn)}</span>
      </div>
      <dl class="passenger-grid">
        <div><dt>Seat</dt><dd>${esc(passenger.seat)}</dd></div>
        <div><dt>Cabin</dt><dd>${esc(passenger.cabin)}</dd></div>
        <div><dt>E-ticket</dt><dd>${esc(passenger.ticketNumber)}</dd></div>
        <div><dt>Gender</dt><dd>${esc(passenger.gender)}</dd></div>
        <div><dt>Baggage</dt><dd>${esc(passenger.baggage)}</dd></div>
        <div><dt>Frequent flyer</dt><dd>${esc(passenger.frequentFlyer)}</dd></div>
        <div><dt>Service request</dt><dd>${esc(passenger.ssr)}</dd></div>
        <div><dt>Boarding</dt><dd>${esc(passenger.group)} · ${esc(passenger.sequence)}</dd></div>
      </dl>
    </article>`).join('');

  const fareMarkup = `
    <div class="fare">
      <div class="fare-row"><span>Base fare</span><span>${money(fare.base, fare.currency)}</span></div>
      <div class="fare-row"><span>Carrier-imposed surcharges (YQ / YR)</span><span>${money(fare.carrierSurcharges, fare.currency)}</span></div>
      <div class="fare-row"><span>Government taxes & airport fees</span><span>${money(fare.taxes, fare.currency)}</span></div>
      <div class="fare-total"><span>Total confirmed amount paid</span><span>${money(fare.total, fare.currency)}</span></div>
    </div>
    <div class="fare-notes">
      <span>Fare basis · ${esc(fare.fareBasis)}</span>
      <span>Form of payment · ${esc(fare.formOfPayment)}</span>
      <span>Endorsements · ${esc(fare.endorsements)}</span>
      <span>Issuing office · ${esc(fare.issuingOffice)}</span>
    </div>`;

  const boardingMarkup = `
    <div class="boarding-pass">
      <div class="bp-main">
        <div class="bp-airline">
          <span>${esc(booking.airline)} · Electronic boarding pass</span>
          <span>${esc(boardingPass.flightNumber)}</span>
        </div>
        <p class="bp-route">${esc(boardingPass.fromIata)} <span>→</span> ${esc(boardingPass.toIata)}</p>
        <p class="bp-name">${esc(boardingPass.name)}</p>
        <dl class="bp-grid">
          <div><dt>Boarding</dt><dd>${esc(boardingPass.boardingTime)}</dd></div>
          <div><dt>Departs</dt><dd>${esc(boardingPass.departureTime)}</dd></div>
          <div><dt>Terminal</dt><dd>${esc(boardingPass.terminal)}</dd></div>
          <div><dt>Gate</dt><dd>${esc(boardingPass.gate)}</dd></div>
          <div><dt>Cabin</dt><dd>${esc(boardingPass.cabin)}</dd></div>
          <div><dt>PNR</dt><dd>${esc(boardingPass.pnr)}</dd></div>
        </dl>
      </div>
      <div class="bp-stub">
        <div>
          <p class="mono">Seat</p>
          <strong style="font-family:var(--serif);font-size:40px;line-height:1">${esc(boardingPass.seat)}</strong>
        </div>
        <div>
          <p class="mono">Gate ${esc(boardingPass.gate)} · ${esc(boardingPass.group)}</p>
          <strong>${esc(boardingPass.sequence)}</strong>
        </div>
        <div class="barcode" aria-hidden="true">${barcodeMarkup(boardingPass.barcode)}</div>
      </div>
    </div>`;

  const watermark = `
    <div class="print-watermark" aria-hidden="true">
      ${Array.from({ length: 24 }, () => '<span>flightverifyer</span>').join('')}
    </div>`;

  const toolbar = `
    <div class="dossier-toolbar">
      <button type="button" class="back-link" data-action="home"><span aria-hidden="true">←</span> Verification desk</button>
      <span class="mono">Public dossier · live</span>
    </div>`;

  const html = `
    <article class="dossier">
      <header class="dossier-masthead">
        <div>
          <p class="print-brand">flightverifyer</p>
          <p class="eyebrow"><span>05</span> Verification dossier</p>
          <h2 class="dossier-title">${esc(booking.bookingReference)}</h2>
          <p class="dossier-sub">${esc(booking.airline)} ${esc(booking.flightNumber)} · ${esc(departure.iata)} → ${esc(arrival.iata)} · ${passengers.length} passenger${passengers.length === 1 ? '' : 's'}</p>
        </div>
        <div>
          <span class="status-pill ${statusClass}"><span class="pulse" aria-hidden="true"></span>${esc(statusText)}</span>
          ${booking.dispatchedToday && phase === 'dispatched' ? '<p class="today-chip">Dispatched today</p>' : ''}
          <div class="dossier-actions" style="margin-top:12px">
            <button type="button" class="btn btn-ghost btn-small" data-action="print">Print dossier</button>
            <button type="button" class="btn btn-ghost btn-small" data-action="radar">Open radar</button>
            <button type="button" class="btn btn-ghost btn-small" data-action="support">Support</button>
          </div>
        </div>
      </header>

      <dl class="meta-strip">
        <div><dt>Booking reference</dt><dd>${esc(booking.bookingReference)}</dd></div>
        <div><dt>Airline PNR</dt><dd>${esc(booking.pnr)}</dd></div>
        <div><dt>E-ticket</dt><dd>${esc(lead.ticketNumber || '—')}</dd></div>
        <div><dt>Issued</dt><dd>${esc(booking.bookedOn)}</dd></div>
        <div><dt>Tier</dt><dd>${esc(booking.tier)} · ${esc(booking.points)}</dd></div>
        <div><dt>Reservation system</dt><dd>${esc(booking.gds)}</dd></div>
      </dl>

      <section class="block">
        <p class="block-label"><b>01</b>Route<br>Departure & arrival</p>
        <div>
          <h2>${esc(departure.city)} to ${esc(arrival.city)}</h2>
          <p class="block-intro">${esc(departure.airport)} → ${esc(arrival.airport)}</p>
          <div class="route">
            <div class="route-top">
              <span>${esc(booking.airline)} · ${esc(booking.flightNumber)} · ${esc(booking.callsign)}</span>
              <span>${esc(telemetry.aircraftType)}</span>
            </div>
            <div class="route-main">
              ${endpointMarkup(departure, 'departure', booking)}
              <div class="route-mid" aria-hidden="true">
                <svg viewBox="0 0 104 26" fill="none"><path d="M3 21C26 4 76 4 101 17" stroke="currentColor" stroke-width="1.7" stroke-dasharray="5 4"/><circle cx="3" cy="21" r="3" fill="currentColor"/><circle cx="101" cy="17" r="3" fill="currentColor"/><path d="m54 3 7 2-4 7z" fill="currentColor"/></svg>
                <span class="route-duration">${esc((booking.segments?.[0]?.duration) || 'Nonstop')}</span>
                <span class="route-duration">${esc(booking.segments?.[0]?.stops || '')}</span>
              </div>
              ${endpointMarkup(arrival, 'arrival', booking)}
            </div>
            <div class="route-progress">
              <div class="progress-bar"><span style="width:${Math.min(100, Math.max(0, Number(telemetry.progress) || 0))}%"></span></div>
              <div class="progress-meta">
                <span>Corridor completed · ${esc(telemetry.progress)}%</span>
                <span>${number(telemetry.distanceFlownKm)} / ${number(telemetry.distanceTotalKm)} km</span>
              </div>
            </div>
          </div>
          ${phaseMarkup}
        </div>
      </section>

      <section class="block">
        <p class="block-label"><b>02</b>Telemetry<br>Live aircraft</p>
        <div>
          <h2>${esc(telemetry.aircraftType)}</h2>
          <p class="block-intro">Transponder ${esc(telemetry.icao24)} · registration ${esc(telemetry.registration)} · squawk ${esc(telemetry.squawk)}</p>
          <dl class="telemetry">
            <div><dt>Calibrated altitude</dt><dd>${number(telemetry.altitudeFt)}<small>ft</small></dd></div>
            <div><dt>Ground speed</dt><dd>${number(telemetry.groundSpeedKts)}<small>kts</small></dd></div>
            <div><dt>Mach</dt><dd>${esc(telemetry.mach)}</dd></div>
            <div><dt>Initial track</dt><dd>${number(telemetry.heading)}°</dd></div>
            <div><dt>Vertical rate</dt><dd>${number(telemetry.verticalRate)}<small>fpm</small></dd></div>
            <div><dt>GPS position</dt><dd>${hasPosition ? `${Number(telemetry.lat).toFixed(2)}N / ${Number(telemetry.lon).toFixed(2)}E` : 'Not transmitted'}</dd></div>
          </dl>
          <div class="live-map">
            <div class="live-map-head">
              <span class="live-badge"><span class="pulse" aria-hidden="true"></span>Live corridor</span>
              <span class="mono">ADS-B feed · 60× playback</span>
            </div>
            <div class="radar-canvas radar-canvas--inline" id="live-map-canvas"></div>
            <div class="radar-readout" id="live-map-readout"></div>
          </div>
          <div style="margin-top:16px">
            <button type="button" class="btn btn-ghost btn-small" data-action="radar">Launch full radar console</button>
          </div>
        </div>
      </section>

      <section class="block">
        <p class="block-label"><b>03</b>Itinerary<br>Booked sectors</p>
        <div>
          <h2>Flight itinerary</h2>
          <p class="block-intro">All sectors attached to this reservation, in local departure time.</p>
          <div class="sectors">${sectorMarkup}</div>
        </div>
      </section>

      <section class="block">
        <p class="block-label"><b>04</b>Manifest<br>Passengers</p>
        <div>
          <h2>Passenger manifest</h2>
          <p class="block-intro">${passengers.length} passenger${passengers.length === 1 ? '' : 's'} reconciled against the ticket record.</p>
          <div class="manifest">${passengerMarkup}</div>
          <div class="outcome-card outcome-card--${esc(outcome)}">
            <div>
              <p class="mono">Travel status</p>
              <p class="outcome-label">${esc(outcomeCopy[0])}</p>
            </div>
            <p class="outcome-note">${esc(outcomeCopy[1])}</p>
          </div>
        </div>
      </section>

      <section class="block">
        <p class="block-label"><b>05</b>Boarding<br>Pass</p>
        <div>
          <h2>Electronic boarding pass</h2>
          <p class="block-intro">Present with a valid travel document at the gate.</p>
          ${boardingMarkup}
        </div>
      </section>

      <section class="block" style="border-bottom:0">
        <p class="block-label"><b>06</b>Receipt<br>Fare & taxes</p>
        <div>
          <h2>Fare receipt</h2>
          <p class="block-intro">Ticketed total reconciled against the issuing office record.</p>
          ${fareMarkup}
        </div>
      </section>

      <footer class="dossier-foot">
        <span>Verified ${esc(verifiedLabel)} UTC · ${esc(payload.source || 'Verification ledger')}</span>
        <span class="mono">Dossier ${esc(booking.bookingReference)} · <b>valid for travel</b></span>
      </footer>
    </article>`;

  stopAllRadars();
  radarClocks.clear();
  els.result.innerHTML = toolbar + watermark + html;
  mountRadar({
    canvas: $('#live-map-canvas'),
    readout: $('#live-map-readout'),
    booking,
    compact: true
  });
}

/* ------------------------------------------------------------------ */
/* Radar console                                                       */
/* ------------------------------------------------------------------ */

const radarStops = new Map();
const radarClocks = new Map();
let radarCounter = 0;

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const toDegrees = (radians) => (radians * 180) / Math.PI;

function greatCirclePoint(from, to, fraction) {
  const f = Math.min(1, Math.max(0, fraction));
  const lat1 = toRadians(from.lat);
  const lon1 = toRadians(from.lon);
  const lat2 = toRadians(to.lat);
  const lon2 = toRadians(to.lon);
  const angle = 2 * Math.asin(Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
  ));
  if (!Number.isFinite(angle) || angle < 1e-9) {
    return {
      lat: from.lat + (to.lat - from.lat) * f,
      lon: from.lon + (to.lon - from.lon) * f
    };
  }
  const a = Math.sin((1 - f) * angle) / Math.sin(angle);
  const b = Math.sin(f * angle) / Math.sin(angle);
  const x = a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2);
  const y = a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2);
  const z = a * Math.sin(lat1) + b * Math.sin(lat2);
  return {
    lat: toDegrees(Math.atan2(z, Math.hypot(x, y))),
    lon: toDegrees(Math.atan2(y, x))
  };
}

function greatCircleKm(from, to) {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const dLat = lat2 - lat1;
  const dLon = toRadians(to.lon - from.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingBetween(from, to) {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const dLon = toRadians(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

// Uniform equirectangular fit: one scale for both axes so distances stay honest.
function radarProjection(samples) {
  const midLat = (Math.min(...samples.map((point) => point.lat)) + Math.max(...samples.map((point) => point.lat))) / 2;
  const lonScale = Math.max(0.2, Math.cos(toRadians(midLat)));
  const raw = samples.map((point) => ({ x: point.lon * lonScale, y: -point.lat }));
  const minX = Math.min(...raw.map((point) => point.x));
  const maxX = Math.max(...raw.map((point) => point.x));
  const minY = Math.min(...raw.map((point) => point.y));
  const maxY = Math.max(...raw.map((point) => point.y));
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = Math.min((760 - 160) / spanX, (360 - 126) / spanY);
  const offsetX = (760 - spanX * scale) / 2 - minX * scale;
  const offsetY = (360 - spanY * scale) / 2 - minY * scale;
  return (point) => ({
    x: point.lon * lonScale * scale + offsetX,
    y: -point.lat * scale + offsetY
  });
}

function formatDistance(km) {
  return `${number(Math.round(km))} km`;
}

function formatDuration(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return '—';
  const totalMinutes = Math.max(1, Math.round(hours * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function clockLabel() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'UTC' });
}

function stopRadar(canvas) {
  const stop = canvas ? radarStops.get(canvas) : null;
  if (stop) {
    stop();
    radarStops.delete(canvas);
  }
}

function stopAllRadars() {
  for (const stop of radarStops.values()) stop();
  radarStops.clear();
}

function mountRadar({ canvas, readout, booking, compact = false }) {
  if (!canvas) return;
  stopRadar(canvas);

  if (!booking) {
    canvas.innerHTML = '<div class="radar-empty"><p>No record loaded</p><p class="mono">Verify a tracking code to open the live corridor.</p></div>';
    if (readout) readout.innerHTML = '';
    return;
  }

  const { departure, arrival, telemetry } = booking;
  const hasCoords = [departure.lat, departure.lon, arrival.lat, arrival.lon, telemetry.lat, telemetry.lon]
    .every((value) => Number.isFinite(value));

  if (!hasCoords) {
    canvas.innerHTML = '<div class="radar-empty"><p>Position not transmitted</p><p class="mono">This record has schedule data only.</p></div>';
    if (readout) readout.innerHTML = `<div><dt>Flight</dt><dd>${esc(booking.flightNumber)}</dd></div><div><dt>Status</dt><dd>Schedule only</dd></div>`;
    return;
  }

  const from = { lat: Number(departure.lat), lon: Number(departure.lon) };
  const to = { lat: Number(arrival.lat), lon: Number(arrival.lon) };
  const samples = Array.from({ length: 73 }, (_, index) => greatCirclePoint(from, to, index / 72));
  const project = radarProjection(samples);
  const projected = samples.map(project);
  const dep = projected[0];
  const arr = projected[projected.length - 1];

  const route = projected
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');

  const totalKm = Math.max(1, Number(telemetry.distanceTotalKm) || greatCircleKm(from, to));
  const speedKmh = Math.max(120, (Number(telemetry.groundSpeedKts) || 450) * 1.852);
  const pixelLength = projected.reduce((sum, point, index) => (
    index === 0 ? 0 : sum + Math.hypot(point.x - projected[index - 1].x, point.y - projected[index - 1].y)
  ), 0);
  const kmPerPixel = totalKm / Math.max(1, pixelLength);
  const niceScaleKm = [2500, 2000, 1000, 500, 250, 100, 50]
    .find((km) => km / kmPerPixel >= 70 && km / kmPerPixel <= 160) || 1000;
  const scaleBarKm = niceScaleKm;
  const scaleBarPx = Math.max(60, Math.min(170, scaleBarKm / kmPerPixel));
  const distanceMarkers = [0.25, 0.5, 0.75].map((fraction) => {
    const point = project(greatCirclePoint(from, to, fraction));
    return `<g>
      <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.4" fill="currentColor" fill-opacity=".45"/>
      <text x="${(point.x - 8).toFixed(1)}" y="${(point.y - 5).toFixed(1)}" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="9" fill="currentColor" fill-opacity=".5">${number(Math.round(totalKm * fraction))} km</text>
    </g>`;
  }).join('');

  const startFraction = Math.min(0.96, Math.max(0.02, (Number(telemetry.progress) || 2) / 100));
  const playback = 60;
  const fractionPerSecond = ((speedKmh / 3600) / totalKm) * playback;
  const uid = `radar${radarCounter += 1}`;

  canvas.innerHTML = `<svg viewBox="0 0 760 360" role="img" aria-label="Live route corridor for ${esc(booking.flightNumber)}">
    <defs>
      <pattern id="${uid}-grid" width="38" height="38" patternUnits="userSpaceOnUse">
        <path d="M38 0H0v38" fill="none" stroke="currentColor" stroke-opacity=".13" stroke-width="1"/>
      </pattern>
      <radialGradient id="${uid}-glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#7fd8c4" stop-opacity=".16"/>
        <stop offset="100%" stop-color="#7fd8c4" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="760" height="360" fill="url(#${uid}-grid)"/>
    <circle cx="380" cy="180" r="170" fill="url(#${uid}-glow)"/>
    <g fill="none" stroke="currentColor" stroke-opacity=".14">
      <circle cx="380" cy="180" r="80"/><circle cx="380" cy="180" r="150"/><circle cx="380" cy="180" r="220"/>
    </g>
    <path d="${route}" fill="none" stroke="currentColor" stroke-opacity=".4" stroke-width="1.5" stroke-dasharray="3 6"/>
    <polyline class="radar-trail" points="" fill="none" stroke="#7fd8c4" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${dep.x}" cy="${dep.y}" r="4.5" fill="#0e5a4e" stroke="#f2ece1" stroke-width="1.3"/>
    <circle cx="${arr.x}" cy="${arr.y}" r="4.5" fill="#d9481f" stroke="#f2ece1" stroke-width="1.3"/>
    <g font-family="IBM Plex Mono, monospace" font-size="11" fill="currentColor">
      <text x="${Math.min(600, dep.x + 10)}" y="${Math.min(330, dep.y + 4)}">${esc(departure.iata)} · ${esc(String(departure.city).toUpperCase())}</text>
      <text x="${Math.max(160, arr.x - 10)}" y="${Math.min(330, arr.y + 4)}" text-anchor="end">${esc(arrival.iata)} · ${esc(String(arrival.city).toUpperCase())}</text>
    </g>
    ${distanceMarkers}
    <rect x="32" y="310" width="146" height="32" fill="#0f1816" fill-opacity=".72"/>
    <g stroke="currentColor" stroke-opacity=".8" stroke-width="1.2">
      <line x1="40" y1="333" x2="${40 + scaleBarPx}" y2="333"/>
      <line x1="40" y1="327" x2="40" y2="339"/>
      <line x1="${40 + scaleBarPx}" y1="327" x2="${40 + scaleBarPx}" y2="339"/>
    </g>
    <text x="40" y="321" font-family="IBM Plex Mono, monospace" font-size="10" fill="currentColor" fill-opacity=".8">${number(scaleBarKm)} km</text>
    <g class="radar-plane" visibility="hidden">
      <circle r="17" fill="#7fd8c4" fill-opacity=".14"/>
      <circle r="26" fill="none" stroke="#7fd8c4" stroke-opacity=".35">
        <animate attributeName="r" values="14;30" dur="3.4s" repeatCount="indefinite"/>
        <animate attributeName="stroke-opacity" values=".5;0" dur="3.4s" repeatCount="indefinite"/>
      </circle>
      <path d="M0 -13 4.6 -3 13 1.4 13 4 4.6 3 3.6 12 0 13.8 -3.6 12 -4.6 3 -13 4 -13 1.4 -4.6 -3Z" fill="#7fd8c4"/>
    </g>
  </svg>`;

  const svg = canvas.querySelector('svg');
  const trail = svg.querySelector('.radar-trail');
  const plane = svg.querySelector('.radar-plane');

  // One shared clock per record so the inline map and full console stay in step.
  const clockKey = booking.bookingReference || booking.pnr || booking.flightNumber || 'record';
  let clock = radarClocks.get(clockKey);
  if (!clock) {
    clock = { startedAt: performance.now(), startFraction, fractionPerSecond };
    radarClocks.set(clockKey, clock);
  }

  let lastFraction = -1;
  let lastReadout = 0;
  let frame = 0;

  const currentFraction = () => {
    const elapsed = (performance.now() - clock.startedAt) / 1000;
    return Math.min(0.995, clock.startFraction + elapsed * clock.fractionPerSecond);
  };

  const paint = () => {
    const fraction = currentFraction();
    const point = greatCirclePoint(from, to, fraction);
    const position = project(point);
    const ahead = project(greatCirclePoint(from, to, Math.min(1, fraction + 0.002)));
    const angle = (Math.atan2(ahead.y - position.y, ahead.x - position.x) * 180) / Math.PI + 90;

    plane.setAttribute('visibility', 'visible');
    plane.setAttribute('transform', `translate(${position.x.toFixed(2)} ${position.y.toFixed(2)}) rotate(${angle.toFixed(2)})`);

    const trailPoints = projected
      .filter((_, index) => index / 72 <= fraction)
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    trailPoints.push(`${position.x.toFixed(1)},${position.y.toFixed(1)}`);
    trail.setAttribute('points', trailPoints.join(' '));
  };

  const paintReadout = () => {
    const fraction = currentFraction();
    const point = greatCirclePoint(from, to, fraction);
    const ahead = greatCirclePoint(from, to, Math.min(1, fraction + 0.002));
    const track = bearingBetween(point, ahead);
    const distanceFlown = totalKm * fraction;
    const remainingKm = Math.max(0, totalKm - distanceFlown);
    const wobble = Math.sin(performance.now() / 4200);
    const altitude = Math.max(0, Math.round((Number(telemetry.altitudeFt) || 0) + wobble * 25));
    const speed = Math.max(0, Math.round((Number(telemetry.groundSpeedKts) || 0) + Math.cos(performance.now() / 5200) * 2));

    const cells = [
      ['Flight', esc(booking.flightNumber)],
      ['Altitude', `${number(altitude)} ft`],
      ['Ground speed', `${number(speed)} kts`],
      ['Position', `${point.lat.toFixed(2)} / ${point.lon.toFixed(2)}`],
      ['Distance flown', formatDistance(distanceFlown)],
      ['Remaining', `${formatDistance(remainingKm)} · ${formatDuration(remainingKm / speedKmh)}`],
      ['Corridor', `${(fraction * 100).toFixed(1)}%`],
      ['Playback', '60× (1 min = 1 h)'],
      ['True track', `${number(Math.round(track))}°`],
      ['Squawk', esc(telemetry.squawk)],
      ['Last ping', `${clockLabel()} UTC`]
    ];

    if (readout) {
      readout.innerHTML = (compact ? cells.slice(0, 6) : cells)
        .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
        .join('');
    }
  };

  const tick = () => {
    paint();
    const now = performance.now();
    if (now - lastReadout > 700) {
      paintReadout();
      lastReadout = now;
    }
    const fraction = currentFraction();
    if (Math.abs(fraction - lastFraction) > 0.00001 || fraction < 0.995) {
      lastFraction = fraction;
      frame = window.requestAnimationFrame(tick);
    }
  };

  paint();
  paintReadout();
  frame = window.requestAnimationFrame(tick);
  radarStops.set(canvas, () => window.cancelAnimationFrame(frame));
}

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */

const modalIds = { how: 'modal-how', radar: 'modal-radar', support: 'modal-support' };
let openModalId = null;

function openModal(name) {
  const modal = document.getElementById(modalIds[name]);
  if (!modal) return;
  state.lastFocus = document.activeElement;
  Object.values(modalIds).forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.hidden = true;
  });
  modal.hidden = false;
  openModalId = modal.id;
  document.body.style.overflow = 'hidden';
  if (name === 'radar') {
    mountRadar({
      canvas: $('#radar-canvas'),
      readout: $('#radar-readout'),
      booking: state.booking
    });
  }
  const focusTarget = modal.querySelector('[data-close]') || modal.querySelector('button');
  if (focusTarget) focusTarget.focus();
}

function closeModal() {
  stopRadar($('#radar-canvas'));
  Object.values(modalIds).forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.hidden = true;
  });
  const hadModal = Boolean(openModalId);
  openModalId = null;
  document.body.style.overflow = '';
  if (hadModal && state.lastFocus instanceof HTMLElement) state.lastFocus.focus();
}

document.addEventListener('click', (event) => {
  const opener = event.target.closest('[data-modal]');
  if (opener) {
    openModal(opener.dataset.modal);
    return;
  }
  if (event.target.closest('[data-close]')) {
    closeModal();
    return;
  }
  if (event.target.classList.contains('modal')) closeModal();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openModalId) closeModal();
});

/* ------------------------------------------------------------------ */
/* Support desk                                                        */
/* ------------------------------------------------------------------ */

const supportForm = $('#support-form');
const supportStatus = $('#support-status');
const supportSubmit = $('#support-submit');

supportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(supportForm));
  supportStatus.dataset.state = '';
  supportStatus.textContent = '';
  supportSubmit.disabled = true;
  supportSubmit.textContent = 'Sending…';

  try {
    const response = await fetch('/api/support', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(values)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'The desk could not accept that request.');
    supportForm.reset();
    supportStatus.textContent = `Received. Quote reference ${payload.reference} when following up.`;
  } catch (error) {
    supportStatus.dataset.state = 'error';
    supportStatus.textContent = error.message || 'The desk could not accept that request.';
  } finally {
    supportSubmit.disabled = false;
    supportSubmit.textContent = 'Send to support desk';
  }
});

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  verify(els.input.value);
});

document.addEventListener('click', (event) => {
  const sample = event.target.closest('[data-sample]');
  if (sample) {
    els.input.value = sample.dataset.sample;
    verify(sample.dataset.sample);
  }

  const action = event.target.closest('[data-action]');
  if (action) {
    if (action.dataset.action === 'print') window.print();
    if (action.dataset.action === 'radar') openModal('radar');
    if (action.dataset.action === 'support') openModal('support');
    if (action.dataset.action === 'home') {
      history.pushState({}, '', '/');
      showHome();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }
});

function codeFromLocation() {
  const pathMatch = location.pathname.match(/^\/verify\/([^/]+)\/?$/);
  if (pathMatch) return decodeURIComponent(pathMatch[1]);
  const hashMatch = location.hash.match(/^#\/verify\/(.+)$/);
  return hashMatch ? decodeURIComponent(hashMatch[1]) : '';
}

function showHome() {
  document.body.classList.remove('verify-page');
  stopAllRadars();
  radarClocks.clear();
  state.booking = null;
  els.result.innerHTML = '';
  setStatus('');
  document.title = 'VerifyMyFlight — Booking verification desk';
}

function renderVerifyError(message, code) {
  const toolbar = `
    <div class="dossier-toolbar">
      <button type="button" class="back-link" data-action="home"><span aria-hidden="true">←</span> Verification desk</button>
      <span class="mono">Public dossier</span>
    </div>`;
  els.result.innerHTML = `${toolbar}
    <div class="verify-error">
      <p class="eyebrow"><span>!</span> Verification result</p>
      <h2>No record for ${esc(code)}</h2>
      <p>${esc(message)}</p>
      <button type="button" class="btn btn-primary" data-action="home">Return to the verification desk</button>
    </div>`;
}

window.addEventListener('popstate', () => {
  const code = codeFromLocation();
  if (code) {
    document.body.classList.add('verify-page');
    els.input.value = code;
    verify(code);
  } else {
    showHome();
  }
});

const initialCode = codeFromLocation();
if (initialCode) {
  document.body.classList.add('verify-page');
  els.input.value = initialCode;
  verify(initialCode);
}
