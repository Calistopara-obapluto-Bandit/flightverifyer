'use strict';

const form = document.getElementById('track-form');
const input = document.getElementById('track-code');
const button = document.getElementById('track-button');
const status = document.getElementById('track-status');
const result = document.getElementById('track-result');

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

const normalise = (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, '');

const steps = [
  { key: 'registered', label: 'Registered' },
  { key: 'in_transit', label: 'In transit' },
  { key: 'out_for_delivery', label: 'Out for delivery' },
  { key: 'delivered', label: 'Delivered' }
];

const stepIndex = { registered: 0, in_transit: 1, out_for_delivery: 2, delivered: 3, on_hold: 1 };

function setStatus(message, isError = false) {
  status.textContent = message;
  if (isError) {
    status.dataset.state = 'error';
  } else {
    delete status.dataset.state;
  }
}

function formatMoment(value, withTime = true) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    timeZone: 'UTC'
  }).format(date);
}

function renderTrack(shipment, checkedAt) {
  const current = stepIndex[shipment.status] ?? 0;
  const held = shipment.status === 'on_hold';

  const stepsHtml = steps.map((step, index) => {
    const state = index < current ? 'done' : index === current ? (held ? 'held' : 'current') : 'todo';
    return `<li class="parcel-step parcel-step--${state}">
      <span class="parcel-step__dot" aria-hidden="true"></span>
      <span class="parcel-step__label">${esc(step.label)}</span>
    </li>`;
  }).join('');

  const scans = shipment.events.map((event, index) => `
    <li class="scan${index === 0 ? ' scan--latest' : ''}">
      <p class="scan__time mono">${esc(formatMoment(event.at))}</p>
      <div>
        <p class="scan__label">${esc(event.label)}</p>
        <p class="scan__place mono">${esc(event.location)}</p>
        ${event.note ? `<p class="scan__note">${esc(event.note)}</p>` : ''}
      </div>
    </li>`).join('');

  const delivered = shipment.status === 'delivered';

  result.innerHTML = `
    <article class="parcel">
      <header class="parcel-head">
        <div>
          <p class="eyebrow"><span>✓</span> Tracking dossier</p>
          <h2 class="parcel-code">${esc(shipment.trackingNumber)}</h2>
          <p class="parcel-meta mono">${esc(shipment.service)} · ${shipment.pieces} piece${shipment.pieces === 1 ? '' : 's'} · ${shipment.weightKg} kg</p>
        </div>
        <div class="parcel-state">
          <span class="parcel-chip parcel-chip--${esc(shipment.status)}">${esc(shipment.statusLabel)}</span>
          <p class="mono">${delivered ? 'Delivered' : 'Estimated delivery'} <b>${esc(formatMoment(delivered ? (shipment.deliveredAt || shipment.etaAt) : shipment.etaAt, false))}</b></p>
        </div>
      </header>

      <ol class="parcel-steps" aria-label="Delivery progress">
        ${stepsHtml}
      </ol>
      <div class="parcel-progress"><span style="width:${Number(shipment.progress) || 0}%"></span></div>

      <div class="parcel-grid">
        <section class="parcel-card">
          <h3>Routing</h3>
          <dl class="parcel-facts">
            <div><dt>From</dt><dd>${esc(shipment.origin)}</dd></div>
            <div><dt>To</dt><dd>${esc(shipment.destination)}</dd></div>
            <div><dt>Service</dt><dd>${esc(shipment.service)}</dd></div>
            <div><dt>Customer reference</dt><dd class="mono">${esc(shipment.reference || '—')}</dd></div>
          </dl>
        </section>
        <section class="parcel-card">
          <h3>Parties</h3>
          <dl class="parcel-facts">
            <div><dt>Sender</dt><dd>${esc(shipment.senderName || '—')}</dd></div>
            <div><dt>Recipient</dt><dd>${esc(shipment.recipientName)}</dd></div>
            <div><dt>Registered</dt><dd class="mono">${esc(formatMoment(shipment.registeredAt, false))}</dd></div>
            <div><dt>Last scan</dt><dd>${esc(shipment.lastEvent?.label || '—')}</dd></div>
          </dl>
        </section>
        <section class="parcel-card">
          <h3>Parcel</h3>
          <dl class="parcel-facts">
            <div><dt>Contents</dt><dd>${esc(shipment.contents)}</dd></div>
            <div><dt>Pieces</dt><dd>${shipment.pieces}</dd></div>
            <div><dt>Weight</dt><dd>${shipment.weightKg} kg</dd></div>
            <div><dt>Status</dt><dd>${esc(shipment.statusLabel)}</dd></div>
          </dl>
        </section>
      </div>

      ${held && shipment.holdReason ? `<p class="parcel-alert"><b>On hold.</b> ${esc(shipment.holdReason)}</p>` : ''}

      <section class="parcel-scans">
        <div class="parcel-scans__head">
          <h3>Scan history</h3>
          <p class="mono">${shipment.events.length} scan${shipment.events.length === 1 ? '' : 's'}</p>
        </div>
        <ol class="scan-list">${scans}</ol>
      </section>

      <p class="parcel-foot mono">Checked ${esc(formatMoment(checkedAt))} UTC · VerifyMyFlight parcel desk</p>
    </article>`;
}

async function lookup(rawCode, { push = true } = {}) {
  const code = normalise(rawCode);
  if (!code) {
    setStatus('Enter the tracking number from the dispatch note.', true);
    return;
  }
  if (!/^SHPX-[A-Z0-9]{4,10}$/.test(code)) {
    setStatus('Tracking numbers look like SHPX-HGV3MQ.', true);
    return;
  }

  button.disabled = true;
  button.textContent = 'Checking…';
  setStatus('Reading the parcel ledger…');
  try {
    const response = await fetch(`/api/track/${encodeURIComponent(code)}`, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'That parcel could not be read just now.');
    renderTrack(payload.shipment, payload.checkedAt || new Date().toISOString());
    setStatus('');
    if (push && location.pathname !== `/track/${code}`) {
      history.pushState({ code }, '', `/track/${code}`);
    }
  } catch (error) {
    result.innerHTML = '';
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Track parcel';
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  lookup(input.value);
});

result.addEventListener('click', (event) => {
  const sample = event.target.closest('[data-sample]');
  if (sample) {
    input.value = sample.dataset.sample;
    lookup(sample.dataset.sample);
  }
});

document.querySelectorAll('[data-sample]').forEach((element) => {
  element.addEventListener('click', () => {
    input.value = element.dataset.sample;
    lookup(element.dataset.sample);
  });
});

window.addEventListener('popstate', () => {
  const match = location.pathname.match(/^\/track\/(.+)$/);
  if (match) {
    input.value = decodeURIComponent(match[1]);
    lookup(match[1], { push: false });
  } else {
    result.innerHTML = '';
    setStatus('');
  }
});

const initial = location.pathname.match(/^\/track\/(.+)$/);
if (initial) {
  const code = decodeURIComponent(initial[1]);
  input.value = code;
  lookup(code, { push: false });
}
