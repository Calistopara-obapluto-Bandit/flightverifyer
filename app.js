const state = {
  user: null,
  overview: null,
  side: 'buy',
  fundingAction: 'deposit',
  view: 'overview'
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const quantityFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 });

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The service could not complete that request.');
  return data;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function notify(message, type = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast visible ${type}`;
  window.clearTimeout(notify.timeout);
  notify.timeout = window.setTimeout(() => toast.classList.remove('visible'), 3600);
}

function showAuth(message = '') {
  $('#authView').hidden = false;
  $('#appView').hidden = true;
  $('#authMessage').textContent = message;
}

function showApplication(user) {
  state.user = user;
  $('#authView').hidden = true;
  $('#appView').hidden = false;
  $('#userName').textContent = user.name;
  $('#userRole').textContent = user.role === 'admin' ? 'Administrator' : 'Client account';
  $('#userAvatar').textContent = user.name.slice(0, 1).toUpperCase();
  $('#topbarAvatar').textContent = user.name.slice(0, 1).toUpperCase();
  $('#topbarName').textContent = user.name;
  $('#greetingName').textContent = `${user.name.split(/\s+/)[0]}.`;
  $('#adminNav').hidden = user.role !== 'admin';
  setView('overview');
  loadOverview().catch((error) => notify(error.message, 'error'));
}

function setAuthMode(mode) {
  const isRegister = mode === 'register';
  $('#loginTab').classList.toggle('active', !isRegister);
  $('#registerTab').classList.toggle('active', isRegister);
  $('#loginTab').setAttribute('aria-selected', String(!isRegister));
  $('#registerTab').setAttribute('aria-selected', String(isRegister));
  $('#nameField').hidden = !isRegister;
  $('#authEyebrow').textContent = isRegister ? 'Start with a practice account' : 'Welcome back';
  $('#authTitle').textContent = isRegister ? 'Create your account' : 'Sign in to your account';
  $('#authIntro').textContent = isRegister ? 'Your demo portfolio is private to your account.' : 'Access your simulated portfolio and market tools.';
  $('#authSubmit').innerHTML = isRegister ? 'Create demo account <span aria-hidden="true">→</span>' : 'Sign in <span aria-hidden="true">→</span>';
  $('#passwordHint').textContent = isRegister ? 'Use at least 10 characters.' : 'Use your account password.';
  $('#authForm').dataset.mode = mode;
  $('#authMessage').textContent = '';
  $('#authForm').elements.password.autocomplete = isRegister ? 'new-password' : 'current-password';
}

async function submitAuth(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const mode = form.dataset.mode || 'login';
  const values = Object.fromEntries(new FormData(form));
  const message = $('#authMessage');
  const button = $('#authSubmit');
  button.disabled = true;
  message.textContent = '';
  try {
    const result = await api(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify(values) });
    form.reset();
    showApplication(result.user);
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function setView(view) {
  if (view === 'admin' && state.user?.role !== 'admin') return;
  state.view = view;
  const viewTitles = { overview: 'Overview', markets: 'Markets', funding: 'Funding requests', activity: 'Activity', admin: 'Admin review' };
  $$('.view').forEach((section) => { section.hidden = section.id !== `${view}View`; });
  $$('.side-link').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $('#currentSection').textContent = viewTitles[view] || 'Overview';
  $('#sidebar').classList.remove('mobile-open');
  $('#mobileNavButton').setAttribute('aria-expanded', 'false');
  if (view === 'overview' || view === 'markets') loadOverview().catch((error) => notify(error.message, 'error'));
  if (view === 'funding') loadFunding().catch((error) => notify(error.message, 'error'));
  if (view === 'activity') loadOverview().catch((error) => notify(error.message, 'error'));
  if (view === 'admin') loadAdmin().catch((error) => notify(error.message, 'error'));
}

function iconMarkup(asset) {
  return `<span class="asset-icon icon-${escapeHtml(asset.symbol.toLowerCase())}">${escapeHtml(asset.symbol.slice(0, 1))}</span>`;
}

function sparklineMarkup(seed, color) {
  const values = Array.from({ length: 14 }, (_, index) => {
    const wave = Math.sin((index + seed) * 0.81) * 9 + Math.cos((index + seed) * 0.31) * 7;
    return Math.max(12, Math.min(42, 27 + wave + (index * (seed % 2 ? 0.55 : -0.35))));
  });
  const points = values.map((value, index) => `${index * 8},${48 - value}`).join(' ');
  return `<svg class="sparkline" viewBox="0 0 104 48" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
}

function renderOverview(data) {
  state.overview = data;
  const account = data.account;
  $('#totalBalance').textContent = money.format(account.totalUsd);
  $('#investedBalance').textContent = money.format(account.investedUsd);
  $('#cashBalance').textContent = money.format(account.cashUsd);
  const updatedLabel = data.marketSource === 'live' ? 'Market data · live provider' : 'Market data · sample fallback';
  $('#marketUpdated').textContent = updatedLabel;
  $('#marketUpdatedAlt').textContent = updatedLabel;

  const assetSelect = $('#tradeAsset');
  const selected = assetSelect.value;
  assetSelect.innerHTML = data.markets.map((asset) => `<option value="${escapeHtml(asset.symbol)}">${escapeHtml(asset.symbol)} · ${escapeHtml(asset.name)}</option>`).join('');
  if (data.markets.some((asset) => asset.symbol === selected)) assetSelect.value = selected;

  const positions = data.markets.map((asset) => ({
    ...asset,
    quantity: account.holdings[asset.symbol] || 0,
    value: (account.holdings[asset.symbol] || 0) * asset.price
  }));
  $('#holdingsTable').innerHTML = positions.map((asset) => `<tr>
    <td><span class="asset-cell">${iconMarkup(asset)}<span><strong>${escapeHtml(asset.name)}</strong><small>${escapeHtml(asset.symbol)}</small></span></span></td>
    <td>${money.format(asset.price)}</td>
    <td><span class="change ${asset.change24h >= 0 ? 'positive' : 'negative'}">${asset.change24h >= 0 ? '+' : ''}${Number(asset.change24h).toFixed(2)}%</span></td>
    <td>${quantityFormat.format(asset.quantity)} ${escapeHtml(asset.symbol)}</td>
    <td class="table-value">${money.format(asset.value)}</td>
  </tr>`).join('');

  $('#marketCards').innerHTML = data.markets.map((asset, index) => `<article class="market-card">
    <div class="market-card-top">${iconMarkup(asset)}<span class="change ${asset.change24h >= 0 ? 'positive' : 'negative'}">${asset.change24h >= 0 ? '+' : ''}${Number(asset.change24h).toFixed(2)}%</span></div>
    <div class="market-card-name"><strong>${escapeHtml(asset.name)}</strong><span>${escapeHtml(asset.symbol)}</span></div>
    <div class="market-card-bottom"><strong>${money.format(asset.price)}</strong>${sparklineMarkup(index + 1, asset.change24h >= 0 ? '#2a9d8f' : '#c16b57')}</div>
  </article>`).join('');

  $('#marketsTable').innerHTML = positions.map((asset) => `<tr>
    <td><span class="asset-cell">${iconMarkup(asset)}<span><strong>${escapeHtml(asset.name)}</strong><small>${escapeHtml(asset.symbol)}</small></span></span></td>
    <td class="table-value">${money.format(asset.price)}</td>
    <td><span class="change ${asset.change24h >= 0 ? 'positive' : 'negative'}">${asset.change24h >= 0 ? '+' : ''}${Number(asset.change24h).toFixed(2)}%</span></td>
    <td>${escapeHtml(asset.volume || '—')}</td>
    <td>${quantityFormat.format(asset.quantity)} ${escapeHtml(asset.symbol)}</td>
    <td><button type="button" class="small-button" data-buy-symbol="${escapeHtml(asset.symbol)}">Practice trade</button></td>
  </tr>`).join('');

  renderActivity(account.ledger || []);
}

function formatDate(value) {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function renderActivity(ledger) {
  if (!ledger.length) {
    $('#activityTable').innerHTML = '<tr><td colspan="6" class="table-empty">No account activity yet. Place a paper order to get started.</td></tr>';
    return;
  }
  $('#activityTable').innerHTML = ledger.map((entry) => `<tr>
    <td class="capitalize">${escapeHtml(entry.side)}</td><td>${escapeHtml(entry.symbol)}</td>
    <td>${entry.quantity ? quantityFormat.format(entry.quantity) : '—'}</td>
    <td>${money.format(entry.amountUsd || 0)}</td><td>${entry.feeUsd ? money.format(entry.feeUsd) : '—'}</td>
    <td>${formatDate(entry.createdAt)}</td>
  </tr>`).join('');
}

async function loadOverview() {
  const data = await api('/api/overview');
  renderOverview(data);
}

async function submitTrade(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#tradeSubmit');
  button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ ...values, side: state.side, amountUsd: Number(values.amountUsd) })
    });
    notify(`${state.side === 'buy' ? 'Buy' : 'Sell'} order completed in paper mode.`);
    await loadOverview();
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function submitFunding(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/funding-requests', {
      method: 'POST',
      body: JSON.stringify({ ...values, action: state.fundingAction, amountUsd: Number(values.amountUsd) })
    });
    form.reset();
    notify('Simulated funding request submitted for review.');
    await loadFunding();
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function loadFunding() {
  const { requests } = await api('/api/funding-requests');
  if (!requests.length) {
    $('#fundingTable').innerHTML = '<tr><td colspan="5" class="table-empty">No funding requests yet.</td></tr>';
    return;
  }
  $('#fundingTable').innerHTML = requests.map((request) => `<tr>
    <td class="capitalize">${escapeHtml(request.action)}</td><td>${money.format(request.amountUsd)}</td>
    <td>${escapeHtml(request.reference || '—')}</td><td><span class="status-pill ${escapeHtml(request.status)}">${escapeHtml(request.status)}</span></td>
    <td>${formatDate(request.createdAt)}</td>
  </tr>`).join('');
}

async function loadAdmin() {
  const [summary, userData] = await Promise.all([api('/api/admin/summary'), api('/api/admin/users')]);
  $('#adminClientCount').textContent = summary.clients;
  $('#adminPendingCount').textContent = summary.pendingRequests;
  const usersById = new Map(userData.users.map((user) => [user.id, user]));
  if (!summary.requests.length) {
    $('#adminFundingTable').innerHTML = '<tr><td colspan="7" class="table-empty">No funding requests to review.</td></tr>';
  } else {
    $('#adminFundingTable').innerHTML = summary.requests.map((request) => {
      const client = usersById.get(request.userId);
      const actions = request.status === 'pending'
        ? `<div class="review-actions"><button class="small-button approve-button" data-review-id="${escapeHtml(request.id)}" data-review-status="approved">Approve</button><button class="small-button reject-button" data-review-id="${escapeHtml(request.id)}" data-review-status="rejected">Reject</button></div>`
        : '—';
      return `<tr><td><span class="client-cell"><strong>${escapeHtml(client?.name || 'Client')}</strong><small>${escapeHtml(client?.email || '')}</small></span></td>
        <td class="capitalize">${escapeHtml(request.action)}</td><td>${money.format(request.amountUsd)}</td><td>${escapeHtml(request.reference || '—')}</td>
        <td>${formatDate(request.createdAt)}</td><td><span class="status-pill ${escapeHtml(request.status)}">${escapeHtml(request.status)}</span></td><td>${actions}</td></tr>`;
    }).join('');
  }
  if (!userData.users.length) {
    $('#adminUsersTable').innerHTML = '<tr><td colspan="6" class="table-empty">No registered clients yet.</td></tr>';
  } else {
    $('#adminUsersTable').innerHTML = userData.users.map((user) => `<tr>
      <td><strong>${escapeHtml(user.name)}</strong></td><td>${escapeHtml(user.email)}</td><td>${formatDate(user.createdAt)}</td>
      <td>${money.format(user.cashUsd)}</td><td>${user.ledgerCount}</td>
      <td><button class="small-button ${user.status === 'active' ? 'reject-button' : 'approve-button'}" data-user-id="${escapeHtml(user.id)}" data-user-status="${user.status === 'active' ? 'suspended' : 'active'}">${user.status === 'active' ? 'Suspend' : 'Reactivate'}</button></td>
    </tr>`).join('');
  }
}

async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* local view still clears */ }
  state.user = null;
  state.overview = null;
  showAuth('You have signed out.');
  setAuthMode('login');
}

$('#loginTab').addEventListener('click', () => setAuthMode('login'));
$('#registerTab').addEventListener('click', () => setAuthMode('register'));
$('#authForm').addEventListener('submit', submitAuth);
$('#tradeForm').addEventListener('submit', submitTrade);
$('#fundingForm').addEventListener('submit', submitFunding);
$('#signOut').addEventListener('click', signOut);

$$('.side-link').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$$('[data-view]').filter((element) => !element.classList.contains('side-link')).forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));

$$('[data-side]').forEach((button) => button.addEventListener('click', () => {
  state.side = button.dataset.side;
  $$('[data-side]').forEach((item) => item.classList.toggle('active', item === button));
  $('#tradeSubmit').innerHTML = `${state.side === 'buy' ? 'Buy' : 'Sell'} asset <span aria-hidden="true">→</span>`;
}));

$$('[data-funding-action]').forEach((button) => button.addEventListener('click', () => {
  state.fundingAction = button.dataset.fundingAction;
  $$('[data-funding-action]').forEach((item) => item.classList.toggle('active', item === button));
}));

$('#marketsTable').addEventListener('click', (event) => {
  const button = event.target.closest('[data-buy-symbol]');
  if (!button) return;
  $('#tradeAsset').value = button.dataset.buySymbol;
  state.side = 'buy';
  $$('[data-side]').forEach((item) => item.classList.toggle('active', item.dataset.side === 'buy'));
  $('#tradeSubmit').innerHTML = 'Buy asset <span aria-hidden="true">→</span>';
  setView('overview');
});

$('#adminFundingTable').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-review-id]');
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/api/admin/funding-requests/${encodeURIComponent(button.dataset.reviewId)}`, {
      method: 'PATCH', body: JSON.stringify({ status: button.dataset.reviewStatus })
    });
    notify(`Request ${button.dataset.reviewStatus}.`);
    await loadAdmin();
  } catch (error) {
    notify(error.message, 'error');
    button.disabled = false;
  }
});

$('#adminUsersTable').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-user-id]');
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/api/admin/users/${encodeURIComponent(button.dataset.userId)}/status`, {
      method: 'PATCH', body: JSON.stringify({ status: button.dataset.userStatus })
    });
    notify(button.dataset.userStatus === 'active' ? 'Client access restored.' : 'Client access suspended.');
    await loadAdmin();
  } catch (error) {
    notify(error.message, 'error');
    button.disabled = false;
  }
});

$('#mobileNavButton').addEventListener('click', () => {
  const expanded = $('#mobileNavButton').getAttribute('aria-expanded') === 'true';
  $('#mobileNavButton').setAttribute('aria-expanded', String(!expanded));
  $('#sidebar').classList.toggle('mobile-open', !expanded);
});

$('#topbarUser').addEventListener('click', () => setView('activity'));

api('/api/auth/me')
  .then(({ user }) => showApplication(user))
  .catch(() => showAuth());
