'use strict';

const $ = (selector) => document.querySelector(selector);

const views = {
  auth: $('#auth-view'),
  console: $('#console-view')
};

const loginForm = $('#login-form');
const loginStatus = $('#login-status');
const loginSubmit = $('#login-submit');
const signOut = $('#sign-out');
const createForm = $('#create-form');
const createStatus = $('#create-status');
const createSubmit = $('#create-submit');
const recordsBody = $('#records-body');
const issuePanel = $('#issue-panel');
const issueCode = $('#issue-code');
const issueCopy = $('#issue-copy');
const issueOpen = $('#issue-open');
const issueDismiss = $('#issue-dismiss');

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      Accept: 'application/json',
      ...options.headers
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'The console could not complete that request.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showConsole(email) {
  views.auth.hidden = true;
  views.console.hidden = false;
  signOut.hidden = false;
  const signedIn = $('#signed-in');
  if (signedIn) signedIn.textContent = email ? `Signed in as ${email}` : '';
  if (email) signOut.dataset.email = email;
  loadRecords();
}

function showAuth() {
  views.console.hidden = true;
  views.auth.hidden = false;
  signOut.hidden = true;
}

function setStatus(element, message, isError = false) {
  element.textContent = message;
  if (isError) {
    element.dataset.state = 'error';
  } else {
    delete element.dataset.state;
  }
}

function copyLink(code, base = '/verify') {
  const link = `${location.origin}${base}/${encodeURIComponent(code)}`;
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(link);
  }
  const field = document.createElement('textarea');
  field.value = link;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  try {
    document.execCommand('copy');
  } finally {
    field.remove();
  }
  return Promise.resolve();
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

api('/api/admin/session')
  .then((session) => showConsole(session.email))
  .catch(() => showAuth());

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(loginForm));
  loginSubmit.disabled = true;
  loginSubmit.textContent = 'Signing in…';
  setStatus(loginStatus, '');
  try {
    const session = await api('/api/admin/login', { method: 'POST', body: JSON.stringify(values) });
    loginForm.reset();
    showConsole(session.email);
  } catch (error) {
    setStatus(loginStatus, error.message, true);
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = 'Sign in';
  }
});

signOut.addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST' });
  } catch {
    /* the local view still clears */
  }
  showAuth();
  setStatus(loginStatus, 'Signed out.');
});

/* ------------------------------------------------------------------ */
/* Records                                                             */
/* ------------------------------------------------------------------ */

const numberFields = [
  'altitudeFt', 'groundSpeedKts', 'mach', 'progress', 'base', 'carrierSurcharges', 'taxes'
];

function payloadFromForm() {
  const values = Object.fromEntries(new FormData(createForm));
  for (const field of numberFields) {
    if (values[field] !== undefined && values[field] !== '') values[field] = Number(values[field]);
  }
  return values;
}

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  createSubmit.disabled = true;
  createSubmit.textContent = 'Issuing…';
  setStatus(createStatus, '');
  try {
    const payload = payloadFromForm();
    const result = await api('/api/admin/bookings', { method: 'POST', body: JSON.stringify(payload) });
    setStatus(createStatus, `Record issued · ${result.code}`);
    issueCode.textContent = result.code;
    issueOpen.href = `/verify/${encodeURIComponent(result.code)}`;
    issuePanel.hidden = false;
    issuePanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await loadRecords();
  } catch (error) {
    setStatus(createStatus, error.message, true);
    if (error.status === 401) showAuth();
  } finally {
    createSubmit.disabled = false;
    createSubmit.textContent = 'Issue record & generate code';
  }
});

issueCopy.addEventListener('click', async () => {
  try {
    await copyLink(issueCode.textContent.trim());
    issueCopy.textContent = 'Link copied ✓';
    window.setTimeout(() => { issueCopy.textContent = 'Copy client link'; }, 2200);
  } catch {
    issueCopy.textContent = 'Copy failed';
  }
});

issueDismiss.addEventListener('click', () => {
  issuePanel.hidden = true;
  setStatus(createStatus, '');
  createForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

async function loadRecords() {
  try {
    const { bookings } = await api('/api/admin/bookings');
    renderRecords(bookings);
    renderStats(bookings);
  } catch (error) {
    if (error.status === 401) {
      showAuth();
      return;
    }
    recordsBody.innerHTML = `<tr><td colspan="8" class="table-empty">${esc(error.message)}</td></tr>`;
  }
}

function renderStats(bookings) {
  $('#stat-total').textContent = bookings.length;
  $('#stat-enroute').textContent = bookings.filter((booking) => booking.phase === 'dispatched').length;
  $('#stat-arrived').textContent = bookings.filter((booking) => booking.phase === 'arrived').length;
}

const outcomeOptions = { pending: 'Pending', boarded: 'Boarded', missed: 'Missed' };

function renderRecords(bookings) {
  if (!bookings.length) {
    recordsBody.innerHTML = '<tr><td colspan="8" class="table-empty">No records yet. Issue the first one above.</td></tr>';
    return;
  }
  recordsBody.innerHTML = bookings.map((booking) => {
    const issued = booking.createdAt ? new Date(booking.createdAt).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric'
    }) : '—';
    return `<tr>
      <td class="code">${esc(booking.code)}</td>
      <td>${esc(booking.flightNumber)}<br><span class="mono">${esc(booking.airline)}</span></td>
      <td class="mono">${esc(booking.route)}</td>
      <td>${esc(booking.passenger)}</td>
      <td class="mono status-cell status-cell--${esc(booking.phase || 'scheduled')}">${esc(booking.status)}</td>
      <td>
        <select class="outcome-select" data-outcome-code="${esc(booking.code)}" aria-label="Travel outcome for ${esc(booking.code)}">
          ${Object.entries(outcomeOptions).map(([value, label]) => `<option value="${value}"${booking.outcome === value ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
      </td>
      <td class="mono">${esc(issued)}</td>
      <td>
        <div class="row-actions">
          <button type="button" class="mini-button" data-copy="${esc(booking.code)}">Copy link</button>
          <a class="mini-button" href="/verify/${encodeURIComponent(booking.code)}" target="_blank" rel="noopener">Open</a>
          <button type="button" class="mini-button danger" data-delete="${esc(booking.code)}">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

recordsBody.addEventListener('change', async (event) => {
  const select = event.target.closest('[data-outcome-code]');
  if (!select) return;
  const code = select.dataset.outcomeCode;
  select.disabled = true;
  select.dataset.state = 'saving';
  try {
    await api(`/api/admin/bookings/${encodeURIComponent(code)}/outcome`, {
      method: 'PATCH',
      body: JSON.stringify({ outcome: select.value })
    });
    select.dataset.state = 'saved';
    window.setTimeout(() => { delete select.dataset.state; }, 1600);
  } catch (error) {
    window.alert(error.message);
  } finally {
    select.disabled = false;
  }
});

recordsBody.addEventListener('click', async (event) => {
  const copyButton = event.target.closest('[data-copy]');
  if (copyButton) {
    try {
      await copyLink(copyButton.dataset.copy);
      copyButton.textContent = 'Copied ✓';
      window.setTimeout(() => { copyButton.textContent = 'Copy link'; }, 2000);
    } catch {
      copyButton.textContent = 'Failed';
    }
    return;
  }

  const deleteButton = event.target.closest('[data-delete]');
  if (!deleteButton) return;
  const code = deleteButton.dataset.delete;
  if (!window.confirm(`Delete verification record ${code}? The client link will stop resolving.`)) return;
  deleteButton.disabled = true;
  try {
    await api(`/api/admin/bookings/${encodeURIComponent(code)}`, { method: 'DELETE' });
    await loadRecords();
    if (issueCode.textContent.trim() === code) issuePanel.hidden = true;
  } catch (error) {
    window.alert(error.message);
    deleteButton.disabled = false;
  }
});

$('#refresh-records').addEventListener('click', loadRecords);

/* Default the departure date to tomorrow, local time. */
const dateField = $('#dep-date');
if (dateField && !dateField.value) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  dateField.value = tomorrow.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Parcel desk                                                         */
/* ------------------------------------------------------------------ */

const shipmentForm = $('#shipment-form');
const shipmentStatus = $('#shipment-status');
const shipmentSubmit = $('#shipment-submit');
const shipmentsBody = $('#shipments-body');
const shipmentIssued = $('#shipment-issued');
const shipmentCode = $('#shipment-code');
const shipmentCopy = $('#shipment-copy');
const shipmentOpen = $('#shipment-open');
const etaField = $('#eta-date');

if (etaField && !etaField.value) {
  const inThreeDays = new Date();
  inThreeDays.setDate(inThreeDays.getDate() + 3);
  etaField.value = inThreeDays.toISOString().slice(0, 10);
}

async function loadShipments() {
  try {
    const { shipments } = await api('/api/admin/shipments');
    renderShipments(shipments);
  } catch (error) {
    if (error.status === 401) {
      showAuth();
      return;
    }
    shipmentsBody.innerHTML = `<tr><td colspan="6" class="table-empty">${esc(error.message)}</td></tr>`;
  }
}

const shipmentStatusOptions = {
  registered: 'Registered',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  on_hold: 'On hold'
};

function renderShipments(shipments) {
  if (!shipments.length) {
    shipmentsBody.innerHTML = '<tr><td colspan="6" class="table-empty">No parcels yet. Create the first tracking number above.</td></tr>';
    return;
  }
  shipmentsBody.innerHTML = shipments.map((shipment) => {
    const eta = shipment.eta ? new Date(shipment.eta).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric'
    }) : '—';
    return `<tr>
      <td class="code">${esc(shipment.code)}</td>
      <td>${esc(shipment.route)}<br><span class="mono">${esc(shipment.service)}</span></td>
      <td>${esc(shipment.recipient)}</td>
      <td class="mono status-cell status-cell--${esc(shipment.statusKey)}">${esc(shipment.status)}</td>
      <td class="mono">${esc(eta)}</td>
      <td>
        <div class="row-actions">
          <select class="outcome-select" data-shipment-code="${esc(shipment.code)}" aria-label="Parcel status for ${esc(shipment.code)}">
            ${Object.entries(shipmentStatusOptions).map(([value, label]) => `<option value="${value}"${shipment.statusKey === value ? ' selected' : ''}>${label}</option>`).join('')}
          </select>
          <button type="button" class="mini-button" data-copy-track="${esc(shipment.code)}">Copy link</button>
          <a class="mini-button" href="/track/${encodeURIComponent(shipment.code)}" target="_blank" rel="noopener">Open</a>
          <button type="button" class="mini-button danger" data-delete-shipment="${esc(shipment.code)}">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

if (shipmentForm) {
  shipmentForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    shipmentSubmit.disabled = true;
    shipmentSubmit.textContent = 'Creating…';
    setStatus(shipmentStatus, '');
    try {
      const values = Object.fromEntries(new FormData(shipmentForm));
      for (const field of ['pieces', 'weightKg', 'declaredValue']) {
        if (values[field] !== undefined && values[field] !== '') values[field] = Number(values[field]);
      }
      values.insured = shipmentForm.elements.insured?.checked === true;
      const result = await api('/api/admin/shipments', { method: 'POST', body: JSON.stringify(values) });
      setStatus(shipmentStatus, `Tracking number created · ${result.code}`);
      shipmentCode.textContent = result.code;
      shipmentOpen.href = `/track/${encodeURIComponent(result.code)}`;
      shipmentIssued.hidden = false;
      shipmentIssued.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await loadShipments();
    } catch (error) {
      setStatus(shipmentStatus, error.message, true);
      if (error.status === 401) showAuth();
    } finally {
      shipmentSubmit.disabled = false;
      shipmentSubmit.textContent = 'Create tracking number';
    }
  });
}

shipmentCopy.addEventListener('click', async () => {
  try {
    await copyLink(shipmentCode.textContent.trim(), '/track');
    shipmentCopy.textContent = 'Link copied ✓';
    window.setTimeout(() => { shipmentCopy.textContent = 'Copy tracking link'; }, 2200);
  } catch {
    shipmentCopy.textContent = 'Copy failed';
  }
});

shipmentsBody.addEventListener('change', async (event) => {
  const select = event.target.closest('[data-shipment-code]');
  if (!select) return;
  const code = select.dataset.shipmentCode;
  select.disabled = true;
  select.dataset.state = 'saving';
  try {
    await api(`/api/admin/shipments/${encodeURIComponent(code)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: select.value })
    });
    select.dataset.state = 'saved';
    window.setTimeout(() => { delete select.dataset.state; }, 1600);
  } catch (error) {
    window.alert(error.message);
  } finally {
    select.disabled = false;
  }
});

shipmentsBody.addEventListener('click', async (event) => {
  const copyButton = event.target.closest('[data-copy-track]');
  if (copyButton) {
    try {
      await copyLink(copyButton.dataset.copyTrack, '/track');
      copyButton.textContent = 'Copied ✓';
      window.setTimeout(() => { copyButton.textContent = 'Copy link'; }, 2000);
    } catch {
      copyButton.textContent = 'Failed';
    }
    return;
  }

  const deleteButton = event.target.closest('[data-delete-shipment]');
  if (!deleteButton) return;
  const code = deleteButton.dataset.deleteShipment;
  if (!window.confirm(`Delete parcel ${code}? The tracking link will stop resolving.`)) return;
  deleteButton.disabled = true;
  try {
    await api(`/api/admin/shipments/${encodeURIComponent(code)}`, { method: 'DELETE' });
    await loadShipments();
    if (shipmentCode.textContent.trim() === code) shipmentIssued.hidden = true;
  } catch (error) {
    window.alert(error.message);
    deleteButton.disabled = false;
  }
});

$('#refresh-shipments').addEventListener('click', loadShipments);
