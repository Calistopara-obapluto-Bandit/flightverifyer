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
    renderDossier(payload.booking, payload);
    history.replaceState(null, '', `#/verify/${encodeURIComponent(payload.booking.bookingReference)}`);
    els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    clearInterval(ticker);
    setStatus(error.message || 'The desk could not reach the ledger. Try again.', 'error');
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

  const html = `
    <article class="dossier">
      <header class="dossier-masthead">
        <div>
          <p class="eyebrow"><span>05</span> Verification dossier</p>
          <h2 class="dossier-title">${esc(booking.bookingReference)}</h2>
          <p class="dossier-sub">${esc(booking.airline)} ${esc(booking.flightNumber)} · ${esc(departure.iata)} → ${esc(arrival.iata)} · ${passengers.length} passenger${passengers.length === 1 ? '' : 's'}</p>
        </div>
        <div>
          <span class="status-pill"><span class="pulse" aria-hidden="true"></span>${esc(booking.status)}</span>
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
            <div><dt>True track</dt><dd>${number(telemetry.heading)}°</dd></div>
            <div><dt>Vertical rate</dt><dd>${number(telemetry.verticalRate)}<small>fpm</small></dd></div>
            <div><dt>GPS position</dt><dd>${hasPosition ? `${Number(telemetry.lat).toFixed(2)}N / ${Number(telemetry.lon).toFixed(2)}E` : 'Not transmitted'}</dd></div>
          </dl>
          <div style="margin-top:16px">
            <button type="button" class="btn btn-ghost btn-small" data-action="radar">Launch route console</button>
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

  els.result.innerHTML = html;
}

/* ------------------------------------------------------------------ */
/* Radar console                                                       */
/* ------------------------------------------------------------------ */

function projectPoint(lat, lon, bounds) {
  const x = 40 + ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * 680;
  const y = 320 - ((lat - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * 250;
  return { x, y };
}

function drawRadar(booking) {
  if (!booking) return;
  const map = $('#radar-map');
  const path = $('#radar-path');
  const points = $('#radar-points');
  const labels = $('#radar-labels');
  const plane = $('#radar-plane');
  const readout = $('#radar-readout');
  if (!map || !path) return;

  const { departure, arrival, telemetry } = booking;
  const hasCoords = [departure.lat, departure.lon, arrival.lat, arrival.lon, telemetry.lat, telemetry.lon]
    .every((value) => Number.isFinite(value));

  if (!hasCoords) {
    path.setAttribute('d', '');
    points.innerHTML = '';
    labels.innerHTML = '';
    plane.setAttribute('visibility', 'hidden');
    readout.innerHTML = `<div><dt>Flight</dt><dd>${esc(booking.flightNumber)}</dd></div><div><dt>Position</dt><dd>Not transmitted</dd></div>`;
    return;
  }
  plane.setAttribute('visibility', 'visible');
  const lats = [departure.lat, arrival.lat, telemetry.lat];
  const lons = [departure.lon, arrival.lon, telemetry.lon];
  const bounds = {
    minLat: Math.min(...lats) - 7,
    maxLat: Math.max(...lats) + 7,
    minLon: Math.min(...lons) - 7,
    maxLon: Math.max(...lons) + 7
  };

  const dep = projectPoint(departure.lat, departure.lon, bounds);
  const arr = projectPoint(arrival.lat, arrival.lon, bounds);
  const mid = { x: (dep.x + arr.x) / 2, y: (dep.y + arr.y) / 2 };
  const dx = arr.x - dep.x;
  const dy = arr.y - dep.y;
  const length = Math.hypot(dx, dy) || 1;
  const curve = 55;
  const control = { x: mid.x - (dy / length) * curve, y: mid.y + (dx / length) * curve };

  path.setAttribute('d', `M${dep.x} ${dep.y} Q${control.x} ${control.y} ${arr.x} ${arr.y}`);

  const circle = (point, fill) =>
    `<circle cx="${point.x}" cy="${point.y}" r="5" fill="${fill}" stroke="currentColor" stroke-width="1.4"/>`;

  points.innerHTML = `${circle(dep, '#0e5a4e')}${circle(arr, '#d9481f')}`;

  labels.innerHTML = `
    <text x="${dep.x + 10}" y="${dep.y + 4}" fill="currentColor">${esc(departure.iata)} · ${esc(departure.city.toUpperCase())}</text>
    <text x="${arr.x - 10}" y="${arr.y + 4}" text-anchor="end" fill="currentColor">${esc(arrival.iata)} · ${esc(arrival.city.toUpperCase())}</text>`;

  const total = path.getTotalLength();
  const t = Math.min(0.99, Math.max(0.01, Number(telemetry.progress) / 100));
  const current = path.getPointAtLength(total * t);
  plane.setAttribute('transform', `translate(${current.x} ${current.y}) rotate(${Number(telemetry.heading) || 0})`);

  readout.innerHTML = `
    <div><dt>Flight</dt><dd>${esc(booking.flightNumber)}</dd></div>
    <div><dt>Altitude</dt><dd>${number(telemetry.altitudeFt)} ft</dd></div>
    <div><dt>Ground speed</dt><dd>${number(telemetry.groundSpeedKts)} kts</dd></div>
    <div><dt>Mach</dt><dd>${esc(telemetry.mach)}</dd></div>
    <div><dt>Track</dt><dd>${number(telemetry.heading)}°</dd></div>
    <div><dt>Squawk</dt><dd>${esc(telemetry.squawk)}</dd></div>
    <div><dt>Position</dt><dd>${Number(telemetry.lat).toFixed(2)} / ${Number(telemetry.lon).toFixed(2)}</dd></div>
    <div><dt>Corridor</dt><dd>${esc(telemetry.progress)}%</dd></div>`;
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
  if (name === 'radar') drawRadar(state.booking);
  const focusTarget = modal.querySelector('[data-close]') || modal.querySelector('button');
  if (focusTarget) focusTarget.focus();
}

function closeModal() {
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
  }
});

const initial = decodeURIComponent((location.hash.match(/^#\/verify\/(.+)$/) || [])[1] || '');
if (initial) {
  els.input.value = initial;
  verify(initial);
}
