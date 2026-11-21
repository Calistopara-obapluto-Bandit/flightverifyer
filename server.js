const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const app = express();
const port = Number(process.env.PORT) || 3000;
const dataDirectory = path.join(__dirname, 'data');
const usersFile = path.join(dataDirectory, 'users.json');
const requestsFile = path.join(dataDirectory, 'funding-requests.json');
const sessions = new Map();
const sessionLifetime = 1000 * 60 * 60 * 24 * 7;
const allowedAssets = ['BTC', 'ETH', 'SOL'];
const marketIds = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana' };
const fallbackMarkets = [
  { symbol: 'BTC', name: 'Bitcoin', price: 68420.55, change24h: 2.48, volume: '28.4B', color: '#f7931a' },
  { symbol: 'ETH', name: 'Ethereum', price: 3528.2, change24h: 1.16, volume: '14.2B', color: '#627eea' },
  { symbol: 'SOL', name: 'Solana', price: 162.84, change24h: -0.82, volume: '3.8B', color: '#7c67f7' }
];

const initialAccount = () => ({
  cashUsd: 25000,
  holdings: { BTC: 0, ETH: 0, SOL: 0 },
  ledger: [],
  createdAt: new Date().toISOString()
});

let marketCache = { updatedAt: 0, assets: fallbackMarkets, source: 'demo' };

app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

async function writeAccount(account, userId) {
  if (!userId) throw new Error('Account owner is required.');
  await fs.mkdir(dataDirectory, { recursive: true });
  const accountFile = path.join(dataDirectory, `account-${userId}.json`);
  const temporaryFile = `${accountFile}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(account, null, 2));
  await fs.rename(temporaryFile, accountFile);
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(dataDirectory, { recursive: true });
  const temporaryFile = `${file}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(value, null, 2));
  await fs.rename(temporaryFile, file);
}

async function readUsers() {
  return readJsonFile(usersFile, []);
}

async function readFundingRequests() {
  return readJsonFile(requestsFile, []);
}

async function readUserAccount(userId) {
  const accountFile = path.join(dataDirectory, `account-${userId}.json`);
  try {
    return JSON.parse(await fs.readFile(accountFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const account = initialAccount();
    await writeAccount(account, userId);
    return account;
  }
}

function safeUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status, createdAt: user.createdAt };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  const [saltHex, hashHex] = String(storedHash || '').split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    return separator < 0 ? ['', ''] : [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `clearwave_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionLifetime / 1000}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'clearwave_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

async function requireUser(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie).clearwave_session;
    const session = sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      if (token) sessions.delete(token);
      return res.status(401).json({ error: 'Sign in to continue.' });
    }
    const users = await readUsers();
    const user = users.find((entry) => entry.id === session.userId);
    if (!user || user.status !== 'active') return res.status(401).json({ error: 'This account is unavailable.' });
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
  next();
}

async function seedAdmin() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) return;
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
  const users = await readUsers();
  const existing = users.find((user) => user.email === email);
  if (existing) {
    existing.role = 'admin';
    existing.status = 'active';
  } else {
    users.push({
      id: crypto.randomUUID(),
      name: 'Administrator',
      email,
      passwordHash: await hashPassword(password),
      role: 'admin',
      status: 'active',
      createdAt: new Date().toISOString()
    });
  }
  await writeJsonFile(usersFile, users);
}

async function getMarkets() {
  if (Date.now() - marketCache.updatedAt < 30_000) return marketCache;

  try {
    const url = new URL('https://api.coingecko.com/api/v3/simple/price');
    url.searchParams.set('ids', Object.values(marketIds).join(','));
    url.searchParams.set('vs_currencies', 'usd');
    url.searchParams.set('include_24hr_change', 'true');
    const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error(`Market provider returned ${response.status}`);
    const data = await response.json();
    const assets = fallbackMarkets.map((asset) => {
      const quote = data[marketIds[asset.symbol]];
      if (!quote || !Number.isFinite(quote.usd)) throw new Error('Market provider response was incomplete');
      return {
        ...asset,
        price: quote.usd,
        change24h: Number.isFinite(quote.usd_24h_change) ? quote.usd_24h_change : 0
      };
    });
    marketCache = { updatedAt: Date.now(), assets, source: 'live' };
  } catch {
    marketCache = { ...marketCache, updatedAt: Date.now(), source: 'demo' };
  }

  return marketCache;
}

function round(value, places = 8) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function getAsset(symbol, markets) {
  return markets.assets.find((asset) => asset.symbol === symbol);
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/app.css', (req, res) => res.sendFile(path.join(__dirname, 'app.css')));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js')));
app.use('/images', express.static(path.join(__dirname, 'images'), { fallthrough: false }));

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (name.length < 2 || name.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10 || password.length > 200) {
      return res.status(400).json({ error: 'Enter your name, a valid email, and a password of at least 10 characters.' });
    }
    const users = await readUsers();
    if (users.some((user) => user.email === email)) return res.status(409).json({ error: 'An account with that email already exists.' });
    const user = {
      id: crypto.randomUUID(),
      name,
      email,
      passwordHash: await hashPassword(password),
      role: 'client',
      status: 'active',
      createdAt: new Date().toISOString()
    };
    users.push(user);
    await writeJsonFile(usersFile, users);
    await writeAccount(initialAccount(), user.id);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + sessionLifetime });
    setSessionCookie(res, token);
    res.status(201).json({ user: safeUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const users = await readUsers();
    const user = users.find((entry) => entry.email === email);
    if (!user || user.status !== 'active' || !(await verifyPassword(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + sessionLifetime });
    setSessionCookie(res, token);
    res.json({ user: safeUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).clearwave_session;
  if (token) sessions.delete(token);
  clearSessionCookie(res);
  res.json({ signedOut: true });
});

app.get('/api/auth/me', requireUser, (req, res) => res.json({ user: safeUser(req.user) }));

app.get('/api/overview', requireUser, async (req, res, next) => {
  try {
    const [account, markets] = await Promise.all([readUserAccount(req.user.id), getMarkets()]);
    const positions = markets.assets.map((asset) => ({
      ...asset,
      quantity: account.holdings[asset.symbol] || 0,
      value: round((account.holdings[asset.symbol] || 0) * asset.price, 2)
    }));
    const investedUsd = positions.reduce((total, asset) => total + asset.value, 0);
    res.json({
      account: { ...account, investedUsd: round(investedUsd, 2), totalUsd: round(account.cashUsd + investedUsd, 2) },
      markets: markets.assets,
      marketSource: markets.source,
      marketUpdatedAt: markets.updatedAt
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/orders', requireUser, async (req, res, next) => {
  try {
    const { side, symbol, amountUsd } = req.body || {};
    const amount = Number(amountUsd);
    if (!['buy', 'sell'].includes(side) || !allowedAssets.includes(symbol) || !Number.isFinite(amount) || amount < 5 || amount > 1_000_000) {
      return res.status(400).json({ error: 'Choose a supported asset and enter an amount between $5 and $1,000,000.' });
    }

    const markets = await getMarkets();
    const asset = getAsset(symbol, markets);
    const fee = round(amount * 0.001, 2);
    const quantity = round(amount / asset.price);
    const account = await readUserAccount(req.user.id);

    if (side === 'buy') {
      if (amount + fee > account.cashUsd) return res.status(400).json({ error: 'Not enough demo cash for this order, including the 0.10% paper fee.' });
      account.cashUsd = round(account.cashUsd - amount - fee, 2);
      account.holdings[symbol] = round((account.holdings[symbol] || 0) + quantity);
    } else {
      if (quantity > (account.holdings[symbol] || 0)) return res.status(400).json({ error: `Not enough ${symbol} in this demo portfolio to sell that amount.` });
      account.cashUsd = round(account.cashUsd + amount - fee, 2);
      account.holdings[symbol] = round(account.holdings[symbol] - quantity);
    }

    const order = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      side,
      symbol,
      quantity,
      price: asset.price,
      amountUsd: amount,
      feeUsd: fee,
      createdAt: new Date().toISOString()
    };
    account.ledger.unshift(order);
    account.ledger = account.ledger.slice(0, 100);
    await writeAccount(account, req.user.id);
    res.status(201).json({ order });
  } catch (error) {
    next(error);
  }
});

app.post('/api/funding-requests', requireUser, async (req, res, next) => {
  try {
    const { action, amountUsd, reference } = req.body || {};
    const amount = Number(amountUsd);
    if (!['deposit', 'withdrawal'].includes(action) || !Number.isFinite(amount) || amount < 10 || amount > 100_000) {
      return res.status(400).json({ error: 'Enter a simulated deposit or withdrawal between $10 and $100,000.' });
    }
    const account = await readUserAccount(req.user.id);
    const requests = await readFundingRequests();
    const pendingWithdrawals = requests
      .filter((request) => request.userId === req.user.id && request.action === 'withdrawal' && request.status === 'pending')
      .reduce((sum, request) => sum + request.amountUsd, 0);
    if (action === 'withdrawal' && amount > account.cashUsd - pendingWithdrawals) {
      return res.status(400).json({ error: 'That exceeds available demo cash after pending withdrawal requests.' });
    }
    const fundingRequest = {
      id: crypto.randomUUID(),
      userId: req.user.id,
      action,
      amountUsd: round(amount, 2),
      reference: String(reference || '').trim().slice(0, 100),
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    requests.unshift(fundingRequest);
    await writeJsonFile(requestsFile, requests);
    res.status(201).json({ request: fundingRequest });
  } catch (error) {
    next(error);
  }
});

app.get('/api/funding-requests', requireUser, async (req, res, next) => {
  try {
    const requests = await readFundingRequests();
    const visible = req.user.role === 'admin'
      ? requests
      : requests.filter((request) => request.userId === req.user.id);
    res.json({ requests: visible });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/summary', requireUser, requireAdmin, async (req, res, next) => {
  try {
    const [users, requests] = await Promise.all([readUsers(), readFundingRequests()]);
    res.json({
      clients: users.filter((user) => user.role === 'client').length,
      pendingRequests: requests.filter((request) => request.status === 'pending').length,
      requests
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/users', requireUser, requireAdmin, async (req, res, next) => {
  try {
    const users = await readUsers();
    const clients = users.filter((user) => user.role === 'client');
    const summaries = await Promise.all(clients.map(async (user) => {
      const account = await readUserAccount(user.id);
      return { ...safeUser(user), cashUsd: account.cashUsd, ledgerCount: account.ledger.length };
    }));
    res.json({ users: summaries });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/admin/funding-requests/:id', requireUser, requireAdmin, async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Choose approved or rejected.' });
    const requests = await readFundingRequests();
    const request = requests.find((entry) => entry.id === req.params.id);
    if (!request) return res.status(404).json({ error: 'Funding request not found.' });
    if (request.status !== 'pending') return res.status(409).json({ error: 'This request has already been reviewed.' });
    if (status === 'approved') {
      const account = await readUserAccount(request.userId);
      if (request.action === 'withdrawal' && request.amountUsd > account.cashUsd) {
        return res.status(409).json({ error: 'The client no longer has enough demo cash for this request.' });
      }
      account.cashUsd = round(account.cashUsd + (request.action === 'deposit' ? request.amountUsd : -request.amountUsd), 2);
      account.ledger.unshift({
        id: crypto.randomUUID(),
        side: request.action === 'deposit' ? 'demo deposit approved' : 'demo withdrawal approved',
        symbol: 'USD',
        amountUsd: request.amountUsd,
        createdAt: new Date().toISOString()
      });
      account.ledger = account.ledger.slice(0, 100);
      await writeAccount(account, request.userId);
    }
    request.status = status;
    request.reviewedAt = new Date().toISOString();
    request.reviewedBy = req.user.id;
    await writeJsonFile(requestsFile, requests);
    res.json({ request });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/admin/users/:id/status', requireUser, requireAdmin, async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Choose active or suspended.' });
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own account status.' });
    const users = await readUsers();
    const user = users.find((entry) => entry.id === req.params.id && entry.role === 'client');
    if (!user) return res.status(404).json({ error: 'Client not found.' });
    user.status = status;
    await writeJsonFile(usersFile, users);
    res.json({ user: safeUser(user) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, mode: 'paper-trading' }));

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error(error);
  res.status(500).json({ error: 'The service could not complete that request.' });
});

seedAdmin().then(() => {
  app.listen(port, () => {
    console.log(`Clearwave paper investing service listening on http://localhost:${port}`);
  });
}).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
