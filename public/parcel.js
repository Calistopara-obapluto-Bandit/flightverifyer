'use strict';

const root = document.getElementById('parcel-root');
const printButton = document.getElementById('print-dossier');

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

const steps = [
  { key: 'registered', label: 'Registered' },
  { key: 'in_transit', label: 'In transit' },
  { key: 'out_for_delivery', label: 'Out for delivery' },
  { key: 'delivered', label: 'Delivered' }
];

const stepIndex = { registered: 0, in_transit: 1, out_for_delivery: 2, delivered: 3, on_hold: 1 };

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

function money(value, currency) {
  const amount = Number(value) || 0;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency || 'USD'}`;
  }
}

function phoneMarkup(value) {
  const phone = String(value || '').trim();
  if (!phone) return '—';
  const dial = phone.replace(/[^\d+]/g, '');
  return `<a class="parcel-contact" href="tel:${esc(dial)}">${esc(phone)}</a>`;
}

function emailMarkup(value) {
  const email = String(value || '').trim();
  if (!email) return '—';
  return `<a class="parcel-contact" href="mailto:${esc(email)}">${esc(email)}</a>`;
}

function partyMarkup(title, name, phone, email) {
  return `<section class="parcel-party__col">
          <h3>${esc(title)}</h3>
          <p class="parcel-party__name">${esc(name || '—')}</p>
          <dl class="parcel-facts">
            <div><dt>Phone</dt><dd class="mono">${phoneMarkup(phone)}</dd></div>
            <div><dt>Email</dt><dd>${emailMarkup(email)}</dd></div>
          </dl>
        </section>`;
}

function watermarkMarkup() {
  const marks = Array.from({ length: 15 }, () => `
    <div class="print-watermark__mark">
      <span class="print-watermark__rule"></span>
      <span class="print-watermark__word">flightverifyer</span>
      <span class="print-watermark__tag">VERIFICATION LEDGER</span>
    </div>`).join('');
  return `<div class="print-watermark" aria-hidden="true">${marks}</div>`;
}

function barcodeMarkup(code) {
  const seed = Array.from(String(code)).map((character) => character.charCodeAt(0));
  const bars = Array.from({ length: 46 }, (_, index) => {
    const weight = seed[index % seed.length] + index * 7;
    return `<span style="width:${1 + (weight % 3)}px;height:${22 + (weight % 16)}px"></span>`;
  }).join('');
  return `<div class="parcel-barcode"><div class="parcel-barcode__bars" aria-hidden="true">${bars}</div><p class="mono">${esc(code)} · CHECK 0${(seed.reduce((a, b) => a + b, 0) % 9) + 1}</p></div>`;
}

function renderTrack(shipment, checkedAt) {
  const current = stepIndex[shipment.status] ?? 0;
  const held = shipment.status === 'on_hold';
  const delivered = shipment.status === 'delivered';
  const progress = Math.min(100, Math.max(4, Number(shipment.progress) || 0));

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

  const photos = Array.isArray(shipment.images) ? shipment.images : [];
  const photoSection = photos.length ? `
      <section class="parcel-photos">
        <div class="parcel-photos__head">
          <h3>Parcel photos</h3>
          <p class="mono">${photos.length} image${photos.length === 1 ? '' : 's'} · contents as dispatched</p>
        </div>
        <ul class="photo-grid">
          ${photos.map((source, index) => `<li><figure>
            <img src="${esc(source)}" alt="Parcel ${esc(shipment.trackingNumber)} photo ${index + 1}">
            <figcaption class="mono">IMG-0${index + 1}</figcaption>
          </figure></li>`).join('')}
        </ul>
      </section>` : '';

  const etaLine = delivered
    ? `Delivered ${formatMoment(shipment.deliveredAt || shipment.etaAt)}`
    : `Estimated ${formatMoment(shipment.etaAt, false)} · ${shipment.window}`;

  const pod = delivered ? `
    <section class="pod">
      <div class="pod-head">
        <h3>Proof of delivery</h3>
        <span class="pod-stamp">DELIVERED</span>
      </div>
      <div class="pod-body">
        <div><dt>Signed by</dt><dd class="pod-signature">${esc(shipment.signedBy)}</dd></div>
        <div><dt>Delivered at</dt><dd class="mono">${esc(formatMoment(shipment.deliveredAt || shipment.etaAt))}</dd></div>
        <div><dt>Scan location</dt><dd>${esc(shipment.destination)}</dd></div>
        <div><dt>POD reference</dt><dd class="mono">POD-${esc(String(shipment.trackingNumber).replace(/[^A-Z0-9]/g, '').slice(-6))}</dd></div>
      </div>
    </section>` : `
    <section class="pod pod--pending">
      <div class="pod-head">
        <h3>Scheduled delivery</h3>
        <span class="pod-stamp pod-stamp--pending">${esc(shipment.statusLabel)}</span>
      </div>
      <div class="pod-body">
        <div><dt>Expected</dt><dd>${esc(formatMoment(shipment.etaAt, false))}</dd></div>
        <div><dt>Window</dt><dd class="mono">${esc(shipment.window)}</dd></div>
        <div><dt>Transit time</dt><dd>${shipment.transitHours ? `${shipment.transitHours} h` : '—'}</dd></div>
        <div><dt>Last scan</dt><dd>${esc(shipment.lastEvent?.label || '—')}</dd></div>
      </div>
    </section>`;

  root.innerHTML = `
    ${watermarkMarkup()}
    <article class="parcel">
      <header class="parcel-head">
        <div>
          <p class="eyebrow"><span>✓</span> Parcel tracking dossier</p>
          <h1 class="parcel-code">${esc(shipment.trackingNumber)}</h1>
          <p class="parcel-meta mono">${esc(shipment.service)} · ${esc(shipment.serviceLevel)}</p>
        </div>
        <div class="parcel-state">
          <span class="parcel-chip parcel-chip--${esc(shipment.status)}">${esc(shipment.statusLabel)}</span>
          <p class="mono">${delivered ? 'Delivered' : 'Estimated delivery'} <b>${esc(formatMoment(delivered ? (shipment.deliveredAt || shipment.etaAt) : shipment.etaAt, false))}</b></p>
        </div>
      </header>

      <div class="parcel-journey">
        <div class="journey-rail">
          <span class="journey-fill" style="width:${progress}%"></span>
          <span class="journey-pin" style="left:${progress}%"></span>
        </div>
        <div class="journey-stops">
          <div><b>${esc(shipment.origin)}</b><span class="mono">Origin</span></div>
          <div class="journey-hub"><b>${esc(shipment.hub)}</b><span class="mono">Transit hub</span></div>
          <div><b>${esc(shipment.destination)}</b><span class="mono">Destination</span></div>
        </div>
      </div>

      <ol class="parcel-steps" aria-label="Delivery progress">${stepsHtml}</ol>
      <div class="parcel-progress"><span style="width:${progress}%"></span></div>
      <p class="parcel-window mono">${esc(etaLine)}</p>

      <div class="parcel-grid">
        <section class="parcel-card">
          <h3>Routing</h3>
          <dl class="parcel-facts">
            <div><dt>From</dt><dd>${esc(shipment.origin)}</dd></div>
            <div><dt>To</dt><dd>${esc(shipment.destination)}</dd></div>
            <div><dt>Service</dt><dd>${esc(shipment.service)}</dd></div>
            <div><dt>Service level</dt><dd>${esc(shipment.serviceLevel)}</dd></div>
            <div><dt>Customer reference</dt><dd class="mono">${esc(shipment.reference || '—')}</dd></div>
          </dl>
        </section>
        <section class="parcel-card">
          <h3>Courier &amp; delivery</h3>
          <dl class="parcel-facts">
            <div><dt>Carrier</dt><dd>${esc(shipment.courier)}</dd></div>
            <div><dt>Delivery agent</dt><dd>${esc(shipment.agent)}</dd></div>
            <div><dt>Vehicle</dt><dd class="mono">${esc(shipment.vehicle)}</dd></div>
            <div><dt>Delivery window</dt><dd class="mono">${esc(shipment.window)}</dd></div>
          </dl>
        </section>
        <section class="parcel-card">
          <h3>Parcel &amp; customs</h3>
          <dl class="parcel-facts">
            <div><dt>Contents</dt><dd>${esc(shipment.contents)}</dd></div>
            <div><dt>Pieces / weight</dt><dd>${shipment.pieces} × ${shipment.weightKg} kg</dd></div>
            <div><dt>Declared value</dt><dd>${esc(money(shipment.declaredValue, shipment.currency))}${shipment.insured ? ' · insured' : ''}</dd></div>
            <div><dt>Customs</dt><dd class="mono">${esc(shipment.customsLabel)}</dd></div>
          </dl>
        </section>
      </div>

      <section class="parcel-party">
        ${partyMarkup('Sender', shipment.senderName, shipment.senderPhone, shipment.senderEmail)}
        ${partyMarkup('Recipient', shipment.recipientName, shipment.recipientPhone, shipment.recipientEmail)}
      </section>

      ${photoSection}

      ${held && shipment.holdReason ? `<p class="parcel-alert"><b>On hold.</b> ${esc(shipment.holdReason)}</p>` : ''}

      ${pod}

      <section class="parcel-scans">
        <div class="parcel-scans__head">
          <h3>Scan history</h3>
          <p class="mono">${shipment.events.length} scan${shipment.events.length === 1 ? '' : 's'}</p>
        </div>
        <ol class="scan-list">${scans}</ol>
      </section>

      <footer class="parcel-foot">
        ${barcodeMarkup(shipment.trackingNumber)}
        <p class="mono">Checked ${esc(formatMoment(checkedAt))} UTC · VerifyMyFlight parcel desk</p>
      </footer>
    </article>`;
}

function renderError(message) {
  root.innerHTML = `
    <div class="verify-error">
      <p class="eyebrow"><span>!</span> No dossier</p>
      <h1>That parcel<br><em>could not be read.</em></h1>
      <p>${esc(message)}</p>
      <a class="btn btn-primary" href="/track">Try another tracking number</a>
    </div>`;
}

async function load() {
  const match = location.pathname.match(/^\/track\/([^/]+)\/?$/);
  const code = match ? decodeURIComponent(match[1]).trim().toUpperCase().replace(/\s+/g, '') : '';
  if (!/^SHPX-[A-Z0-9]{4,10}$/.test(code)) {
    renderError('Tracking numbers look like SHPX-HGV3MQ. Enter the number printed on the dispatch note.');
    return;
  }

  try {
    const response = await fetch(`/api/track/${encodeURIComponent(code)}`, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      renderError(payload.error || 'The parcel ledger did not answer just now. Try again in a moment.');
      return;
    }
    renderTrack(payload.shipment, payload.checkedAt || new Date().toISOString());
    document.title = `${payload.shipment.trackingNumber} — parcel tracking dossier`;
  } catch {
    renderError('The parcel ledger could not be reached. Check your connection and try again.');
  }
}

printButton.addEventListener('click', () => window.print());
load();
