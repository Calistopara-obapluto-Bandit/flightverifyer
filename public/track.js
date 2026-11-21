'use strict';

const form = document.getElementById('track-form');
const input = document.getElementById('track-code');
const button = document.getElementById('track-button');
const status = document.getElementById('track-status');

const normalise = (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, '');

function setStatus(message, isError = false) {
  status.textContent = message;
  if (isError) {
    status.dataset.state = 'error';
  } else {
    delete status.dataset.state;
  }
}

// The dossier has its own page, so tracking always navigates to /track/<code>.
function openDossier(rawCode) {
  const code = normalise(rawCode);
  if (!code) {
    setStatus('Enter the tracking number from the dispatch note.', true);
    input.focus();
    return;
  }
  if (!/^SHPX-[A-Z0-9]{4,10}$/.test(code)) {
    setStatus('Tracking numbers look like SHPX-HGV3MQ.', true);
    input.focus();
    return;
  }
  setStatus('Opening tracking dossier…');
  button.disabled = true;
  button.textContent = 'Opening…';
  location.assign(`/track/${encodeURIComponent(code)}`);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  openDossier(input.value);
});

document.querySelectorAll('[data-sample]').forEach((element) => {
  element.addEventListener('click', () => {
    input.value = element.dataset.sample;
    openDossier(element.dataset.sample);
  });
});

const prefill = new URLSearchParams(location.search).get('code');
if (prefill) {
  input.value = prefill;
  openDossier(prefill);
}
