/**
 * NexaPay Backend Server
 * ─────────────────────
 * Serves the frontend static files and all API routes.
 * Connects to Supabase for DB + Auth.
 *
 * REMOVE the hardcoded keys below before making this repository public.
 * Replace with environment variables on your hosting platform (Railway etc.).
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 5000;

const SUPABASE_URL = 'https://qfrvdhgltqvifkiffjjc.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_SERVICE_KEY environment variable is not set.');
const ADMIN_SECRET_KEY = '3462Abel';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/* ── Rate limiting ── */
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

/* ── Multer (file uploads, stored in Supabase Storage) ── */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/* The user-facing flow contains four document categories. Identity is stored
   as two internal rows so the representative's front and back can be reviewed
   independently without creating a fifth upload category for the user. */
const KYC_DOCUMENT_TYPES = new Set(['business_cert', 'id_front', 'id_back', 'utility_bill', 'tax_id']);
const KYC_REQUIRED_DOCUMENT_TYPES = ['business_cert', 'id_front', 'id_back', 'utility_bill', 'tax_id'];

/* ── CORS — allow all origins ── */
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['*']
}));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(limiter);


/* ── Auth middleware for protected routes ── */
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

/* ── Admin middleware ── */
function adminMiddleware(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== ADMIN_SECRET_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
}

/* ════════════════════════════════════════════
   AUTH ROUTES
════════════════════════════════════════════ */

/* Save business profile after signup — no authMiddleware, uses user_id from body */
app.post('/api/auth/profile', async (req, res) => {
  const { user_id, email, full_name, username, business_name, business_sector, country, phone,
          is_operated, business_type, account_type } = req.body;

  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const currencyMap = { Zambia: 'ZMW', Zimbabwe: 'USD', Namibia: 'NAD', Botswana: 'BWP' };
  const primaryCurrency = currencyMap[country] || 'USD';

  const { error } = await supabase.from('profiles').upsert({
    id: user_id,
    full_name,
    username: username || null,
    business_name,
    business_sector,
    country,
    email,
    phone,
    is_operated,
    business_type,
    currency: primaryCurrency,
    account_type: account_type || 'business',
    verification_status: 'not_started',
    is_disabled: false,
    created_at: new Date().toISOString()
  }, { onConflict: 'id' });

  if (error) return res.status(400).json({ error: error.message });

  /* Create wallet(s) for user — Zimbabwe gets USD + ZiG */
  const walletsToCreate = country === 'Zimbabwe'
    ? [
        { user_id, currency: 'USD', country, balance: 0, locked_balance: 0, available_balance: 0 },
        { user_id, currency: 'ZiG', country, balance: 0, locked_balance: 0, available_balance: 0 }
      ]
    : [{ user_id, currency: primaryCurrency, country, balance: 0, locked_balance: 0, available_balance: 0 }];

  for (const w of walletsToCreate) {
    await supabase.from('wallets').upsert(w, { onConflict: 'user_id,currency' });
  }

  /* Generate API keys */
  const testPublishable = 'npay_test_pub_' + uuidv4().replace(/-/g, '');
  const testSecret = 'npay_test_sec_' + uuidv4().replace(/-/g, '');
  const livePublishable = 'npay_live_pub_' + uuidv4().replace(/-/g, '');
  const liveSecret = 'npay_live_sec_' + uuidv4().replace(/-/g, '');
  await supabase.from('api_keys').upsert({
    user_id,
    test_publishable_key: testPublishable,
    test_secret_key: testSecret,
    live_publishable_key: livePublishable,
    live_secret_key: liveSecret,
    is_live: false
  }, { onConflict: 'user_id' });

  /* Create welcome notification */
  await supabase.from('notifications').insert({
    user_id,
    title: 'Welcome to NexaPay!',
    message: 'Your business account has been created. Complete account verification to access all features.',
    type: 'info',
    is_read: false
  });

  res.json({ success: true, currency: primaryCurrency });
});

/* Wallet initialisation (called from auth.html separately) */
app.post('/api/wallets/init', async (req, res) => {
  const { user_id, country, currency } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  const countryName = country || '';
  const walletsToCreate = countryName === 'Zimbabwe'
    ? [
        { user_id, currency: 'USD', country: countryName, balance: 0, locked_balance: 0, available_balance: 0 },
        { user_id, currency: 'ZiG', country: countryName, balance: 0, locked_balance: 0, available_balance: 0 }
      ]
    : [{ user_id, currency: currency || 'ZMW', country: countryName, balance: 0, locked_balance: 0, available_balance: 0 }];

  for (const w of walletsToCreate) {
    await supabase.from('wallets').upsert(w, { onConflict: 'user_id,currency' });
  }

  res.json({ success: true });
});

/* Get profile */
app.get('/api/profile', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', req.user.id).single();
  if (error || !data) return res.status(404).json({ error: 'Profile not found' });

  /* Auto-heal missing fields that should always be set */
  const patch = {};
  if (!data.verification_status) patch.verification_status = 'not_started';
  if (!data.created_at)          patch.created_at = new Date().toISOString();
  if (!data.updated_at)          patch.updated_at = new Date().toISOString();
  if (Object.keys(patch).length) {
    await supabase.from('profiles').update(patch).eq('id', req.user.id);
    Object.assign(data, patch);
  }

  res.json(data);
});

/* GET /api/auth/profile — alias used by dashboard populateUI */
app.get('/api/auth/profile', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', req.user.id).single();
  if (error || !data) return res.status(404).json({ error: 'Profile not found' });

  /* Auto-heal missing fields that should always be set */
  const patch = {};
  if (!data.verification_status) patch.verification_status = 'not_started';
  if (!data.created_at)          patch.created_at = new Date().toISOString();
  if (!data.updated_at)          patch.updated_at = new Date().toISOString();
  if (Object.keys(patch).length) {
    await supabase.from('profiles').update(patch).eq('id', req.user.id);
    Object.assign(data, patch);
  }

  res.json(data);
});

/* Update profile — PUT and PATCH aliases */
async function handleProfileUpdate(req, res) {
  const allowed = ['full_name', 'phone', 'business_name', 'business_sector', 'id_number', 'tax_id'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updatable fields provided' });
  updates.updated_at = new Date().toISOString();
  const { error } = await supabase.from('profiles').update(updates).eq('id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
}
app.put('/api/profile', authMiddleware, handleProfileUpdate);
app.patch('/api/profile', authMiddleware, handleProfileUpdate);
app.patch('/api/profile/update', authMiddleware, handleProfileUpdate);

/* ════════════════════════════════════════════
   DASHBOARD STATS (HOME)
════════════════════════════════════════════ */
app.get('/api/stats/home', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const today = new Date(); today.setHours(0,0,0,0);
  const todayISO = today.toISOString();

  const [payinRes, payoutRes, pendingRes, settlementRes] = await Promise.all([
    supabase.from('transactions').select('amount').eq('user_id', uid).eq('type', 'payin').eq('status', 'success').gte('created_at', todayISO),
    supabase.from('transactions').select('amount').eq('user_id', uid).eq('type', 'payout').eq('status', 'success').gte('created_at', todayISO),
    supabase.from('transactions').select('id').eq('user_id', uid).eq('status', 'pending'),
    supabase.from('settlements').select('amount').eq('user_id', uid).eq('status', 'pending')
  ]);

  const payinTotal = (payinRes.data || []).reduce((s, r) => s + Number(r.amount), 0);
  const payoutTotal = (payoutRes.data || []).reduce((s, r) => s + Number(r.amount), 0);
  const pendingCount = (pendingRes.data || []).length;
  const settlementTotal = (settlementRes.data || []).reduce((s, r) => s + Number(r.amount), 0);

  res.json({
    payin_today: payinTotal, payin_total: payinTotal, payin_count: (payinRes.data || []).length,
    payout_today: payoutTotal, payout_total: payoutTotal, payout_count: (payoutRes.data || []).length,
    pending_transactions: pendingCount, pending_count: pendingCount,
    pending_settlement: settlementTotal, settlement_pending: settlementTotal
  });
});

/* Latest transactions */
app.get('/api/stats/latest-transactions', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const today = new Date(); today.setHours(0,0,0,0);
  const { data, error } = await supabase.from('transactions').select('*').eq('user_id', uid).eq('type', 'payin').gte('created_at', today.toISOString()).order('created_at', { ascending: false }).limit(10);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

/* ════════════════════════════════════════════
   WALLETS
════════════════════════════════════════════ */
app.get('/api/wallets', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('wallets').select('*').eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

/* ════════════════════════════════════════════
   TRANSACTIONS
════════════════════════════════════════════ */
app.get('/api/transactions', authMiddleware, async (req, res) => {
  const { type, status, page = 1, limit: lim = 50 } = req.query;
  let query = supabase.from('transactions').select('*', { count: 'exact' }).eq('user_id', req.user.id).order('created_at', { ascending: false }).range((page-1)*lim, page*lim - 1);
  if (type) query = query.eq('type', type);
  if (status) query = query.eq('status', status);
  const { data, count, error } = await query;
  if (error) return res.status(400).json({ error: error.message });
  /* Return flat array for compatibility */
  res.json(data || []);
});

/* ════════════════════════════════════════════
   SETTLEMENTS
════════════════════════════════════════════ */
app.get('/api/settlements', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('settlements').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/settlements', authMiddleware, async (req, res) => {
  const { amount, currency, method, beneficiary_name, beneficiary_phone, beneficiary_account, notes } = req.body;
  if (!amount || !method) return res.status(400).json({ error: 'Amount and method are required' });

  /* Check available balance */
  const walletCurrency = currency || 'ZMW';
  const { data: wallet } = await supabase.from('wallets').select('available_balance').eq('user_id', req.user.id).eq('currency', walletCurrency).single();
  if (!wallet || Number(wallet.available_balance) < Number(amount)) {
    return res.status(400).json({ error: 'Insufficient available balance' });
  }

  const { error } = await supabase.from('settlements').insert({
    user_id: req.user.id,
    amount: Number(amount),
    currency: walletCurrency,
    method,
    beneficiary_name: beneficiary_name || null,
    beneficiary_phone: beneficiary_phone || null,
    beneficiary_account: beneficiary_account || null,
    notes,
    status: 'pending',
    reference: 'STL-' + uuidv4().split('-')[0].toUpperCase()
  });
  if (error) return res.status(400).json({ error: error.message });

  res.json({ success: true });
});

/* ════════════════════════════════════════════
   PAYMENT LINKS
════════════════════════════════════════════ */
app.get('/api/payment-links', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('payment_links').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/payment-links', authMiddleware, async (req, res) => {
  const { name, title, amount, currency, description, expires_at, amount_type, max_uses } = req.body;
  if (!name && !title) return res.status(400).json({ error: 'Name is required' });

  const slug = uuidv4().split('-')[0].toLowerCase();
  const link = `https://pay.nexapay.com/l/${slug}`;

  const { data, error } = await supabase.from('payment_links').insert({
    user_id: req.user.id,
    name: name || title,
    title: title || name,
    amount: amount ? Number(amount) : null,
    currency: currency || 'ZMW',
    description,
    slug,
    link_id: slug,
    url: link,
    status: 'active',
    expires_at: expires_at || null,
    amount_type: amount_type || 'fixed',
    max_uses: max_uses || null,
    usage_count: 0,
    clicks: 0,
    payments: 0
  }).select().single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, link: data });
});

app.delete('/api/payment-links/:id', authMiddleware, async (req, res) => {
  const { error } = await supabase.from('payment_links').update({ status: 'inactive' }).eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

/* ════════════════════════════════════════════
   DISBURSEMENT REQUESTS
════════════════════════════════════════════ */
app.get('/api/disbursements', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('disbursements').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/disbursements', authMiddleware, async (req, res) => {
  const { beneficiary_id, amount, currency, notes } = req.body;
  if (!beneficiary_id || !amount) return res.status(400).json({ error: 'Beneficiary and amount are required' });

  const { data: benef } = await supabase.from('beneficiaries').select('*').eq('id', beneficiary_id).eq('user_id', req.user.id).single();
  if (!benef) return res.status(404).json({ error: 'Beneficiary not found' });

  /* Check wallet balance for the given currency */
  const walletCurrency = currency || benef.currency || 'ZMW';
  const { data: wallet } = await supabase.from('wallets').select('available_balance').eq('user_id', req.user.id).eq('currency', walletCurrency).single();
  const available = wallet ? Number(wallet.available_balance) : 0;
  if (available < Number(amount)) {
    return res.status(400).json({ error: `Insufficient ${walletCurrency} balance. Available: ${available.toFixed(2)}` });
  }

  const { error } = await supabase.from('disbursements').insert({
    user_id: req.user.id,
    beneficiary_id,
    beneficiary_name: benef.name,
    beneficiary_phone: benef.phone,
    amount: Number(amount),
    currency: walletCurrency,
    method: benef.method,
    notes,
    status: 'pending',
    reference: 'DIS-' + uuidv4().split('-')[0].toUpperCase()
  });
  if (error) return res.status(400).json({ error: error.message });

  /* Send notification */
  await supabase.from('notifications').insert({
    user_id: req.user.id,
    title: 'Disbursement Request Submitted',
    message: `Disbursement of ${walletCurrency} ${Number(amount).toFixed(2)} to ${benef.name} is pending approval.`,
    type: 'info',
    is_read: false
  });

  res.json({ success: true });
});

/* ── Beneficiaries ── */
app.get('/api/beneficiaries', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('beneficiaries').select('*').eq('user_id', req.user.id).order('name');
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/beneficiaries', authMiddleware, async (req, res) => {
  const { name, currency, method, phone, country, network } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });
  const { error } = await supabase.from('beneficiaries').insert({
    user_id: req.user.id,
    name,
    currency: currency || 'ZMW',
    method: method || 'mobile_money',
    phone,
    country,
    network: network || null
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/api/beneficiaries/:id', authMiddleware, async (req, res) => {
  const { error } = await supabase.from('beneficiaries').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

/* ════════════════════════════════════════════
   WEBHOOK HISTORY
════════════════════════════════════════════ */
app.get('/api/webhooks', authMiddleware, async (req, res) => {
  const { from, to } = req.query;
  let query = supabase.from('webhook_history').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);
  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/webhooks/config', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('webhook_configs').select('*').eq('user_id', req.user.id).single();
  res.json(data || { webhook_url: '', events: [] });
});

app.get('/api/webhooks/:id', authMiddleware, async (req, res) => {
  if (req.params.id === 'config') {
    const { data } = await supabase.from('webhook_configs').select('*').eq('user_id', req.user.id).single();
    return res.json(data || { webhook_url: '', events: [] });
  }
  const { data, error } = await supabase.from('webhook_history').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
  if (error) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

/* Webhook configuration */
app.post('/api/webhook-config', authMiddleware, async (req, res) => {
  const { webhook_url, events } = req.body;
  if (!webhook_url) return res.status(400).json({ error: 'Webhook URL required' });

  const { error } = await supabase.from('webhook_configs').upsert({
    user_id: req.user.id,
    webhook_url,
    url: webhook_url,
    events: events || ['payin.success', 'payin.failed', 'payout.success', 'payout.failed'],
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });

  if (error) return res.status(400).json({ error: error.message });

  await supabase.from('webhook_history').insert({
    user_id: req.user.id,
    url: webhook_url,
    event: 'webhook.configured',
    status: 'SUCCESS',
    attempts: 1,
    request_payload: JSON.stringify({ event: 'webhook.configured', timestamp: Date.now(), url: webhook_url }),
    response_status: 200
  });

  res.json({ success: true });
});

/* ════════════════════════════════════════════
   API KEYS
════════════════════════════════════════════ */
app.get('/api/api-keys', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('api_keys').select('*').eq('user_id', req.user.id).single();
  if (error) return res.status(404).json({ error: 'Not found' });
  /* Map field names */
  res.json({
    live_secret: data.live_secret_key || data.live_secret,
    live_publishable: data.live_publishable_key || data.live_publishable,
    test_secret: data.test_secret_key || data.test_secret,
    test_publishable: data.test_publishable_key || data.test_publishable
  });
});

app.post('/api/api-keys/regenerate', authMiddleware, async (req, res) => {
  const { key_type } = req.body;
  const validTypes = ['test_secret_key', 'test_publishable_key', 'live_publishable_key', 'live_secret_key'];
  if (!validTypes.includes(key_type)) return res.status(400).json({ error: 'Invalid key type' });

  const prefix = key_type.includes('test') ? 'npay_test_' : 'npay_live_';
  const kind = key_type.includes('pub') ? 'pub_' : 'sec_';
  const newKey = prefix + kind + uuidv4().replace(/-/g,'');

  const { error } = await supabase.from('api_keys').update({ [key_type]: newKey, updated_at: new Date().toISOString() }).eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, key: newKey });
});

/* ════════════════════════════════════════════
   IP WHITELIST
════════════════════════════════════════════ */
app.get('/api/ip-whitelist', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('ip_whitelist').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/ip-whitelist', authMiddleware, async (req, res) => {
  const { ip_address, label } = req.body;
  if (!ip_address) return res.status(400).json({ error: 'IP address required' });
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
  if (!ipRegex.test(ip_address)) return res.status(400).json({ error: 'Invalid IP address format' });
  const { error } = await supabase.from('ip_whitelist').insert({ user_id: req.user.id, ip_address, label: label || ip_address });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/api/ip-whitelist/:id', authMiddleware, async (req, res) => {
  const { error } = await supabase.from('ip_whitelist').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

/* ════════════════════════════════════════════
   NOTIFICATIONS
════════════════════════════════════════════ */
app.get('/api/notifications', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('notifications').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  await supabase.from('notifications').update({ is_read: true, read_at: new Date().toISOString() }).eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ success: true });
});

/* Mark all read — support both PATCH and POST */
const markAllRead = async (req, res) => {
  await supabase.from('notifications').update({ is_read: true, read_at: new Date().toISOString() }).eq('user_id', req.user.id).eq('is_read', false);
  res.json({ success: true });
};
app.patch('/api/notifications/read-all', authMiddleware, markAllRead);
app.post('/api/notifications/mark-all-read', authMiddleware, markAllRead);

/* ════════════════════════════════════════════
   SETTINGS
════════════════════════════════════════════ */
app.get('/api/settings', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('user_settings').select('*').eq('user_id', req.user.id).single();
  res.json(data || {
    email_payin: true,
    email_settlement: true,
    email_disbursement: true,
    inapp: true,
    email_notifications: true,
    sms_notifications: false,
    two_factor_auth: false,
    session_timeout: 60,
    language: 'en',
    timezone: 'Africa/Lusaka'
  });
});

app.put('/api/settings', authMiddleware, async (req, res) => {
  const { error } = await supabase.from('user_settings').upsert({
    user_id: req.user.id,
    ...req.body,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

app.patch('/api/settings/notifications', authMiddleware, async (req, res) => {
  const { error } = await supabase.from('user_settings').upsert({
    user_id: req.user.id,
    ...req.body,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

/* ════════════════════════════════════════════
   ACCOUNT VERIFICATION (KYC)
════════════════════════════════════════════ */

/* GET /api/verification/status */
app.get('/api/verification/status', authMiddleware, async (req, res) => {
  const uid = req.user.id;

  const { data: profile } = await supabase.from('profiles').select('verification_status, business_type, business_name, country').eq('id', uid).single();
  const { data: submission } = await supabase.from('verification_submissions').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(1).single();
  /* Exclude file_data / file_url (base64 blobs) — metadata only to keep response small */
  const { data: docs } = await supabase
    .from('verification_documents')
    .select('id, document_type, filename, file_size, status, rejection_reason, reviewed_at, created_at')
    .eq('user_id', uid)
    .order('created_at', { ascending: false });
  const visibleDocs = (docs || []).filter(d => KYC_DOCUMENT_TYPES.has(d.document_type));

  let status = 'not_started';
  if (profile && profile.verification_status === 'verified') status = 'verified';
  else if (profile && profile.verification_status === 'rejected') status = 'rejected';
  else if (submission && (submission.status === 'submitted' || submission.status === 'pending')) status = 'submitted';
  else if (visibleDocs.length > 0) status = 'submitted';

  res.json({
    status,
    business_type: (profile && profile.business_type) || 'Business',
    country: (profile && profile.country) || req.user.user_metadata?.country || null,
    expires_at: (submission && submission.expires_at) || null,
    rejection_reason: (submission && submission.rejection_reason) || null,
    documents: visibleDocs.map(d => ({
      id: d.id,
      document_type: d.document_type,
      filename: d.filename || '—',
      /* Use the dedicated view endpoint instead of embedding the raw data URL */
      file_url: `/api/verification/document/${d.id}/url`,
      file_size: d.file_size || '—',
      status: d.status === 'approved' ? 'verified' : (d.status === 'rejected' ? 'rejected' : 'pending'),
      rejection_reason: d.rejection_reason || null,
      reviewed_at: d.reviewed_at || null,
      created_at: d.created_at
    }))
  });
});

/* POST /api/verification/upload — stores file as base64 in DB (no storage bucket needed) */
app.post('/api/verification/upload', authMiddleware, upload.single('file'), async (req, res) => {
  /* Guard: ensure profile row exists before inserting into verification_documents.
     verification_documents.user_id has a FK → profiles.id. If the profile was
     never saved (e.g. /api/auth/profile failed silently at signup), auto-create a
     minimal profile row from the auth user so the upload is not blocked. */
  const { data: existingProfile } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', req.user.id)
    .single();

  if (!existingProfile) {
    const email = req.user.email || '';
    const metaCountry = req.user.user_metadata?.country || '';
    const emergencyCurrencyMap = { Zambia: 'ZMW', Zimbabwe: 'USD', Namibia: 'NAD', Botswana: 'BWP' };
    const emergencyCurrency = emergencyCurrencyMap[metaCountry] || 'ZMW';
    await supabase.from('profiles').upsert({
      id: req.user.id,
      email,
      full_name: req.user.user_metadata?.full_name || email.split('@')[0] || '',
      business_name: req.user.user_metadata?.business_name || '',
      country: metaCountry || null,
      currency: emergencyCurrency,
      account_type: 'business',
      verification_status: 'not_started',
      is_disabled: false,
      created_at: new Date().toISOString()
    }, { onConflict: 'id' });
    /* Also ensure wallet(s) exist — profile missing usually means wallet missing too */
    const walletsToCreate = metaCountry === 'Zimbabwe'
      ? [
          { user_id: req.user.id, currency: 'USD', country: metaCountry, balance: 0, locked_balance: 0, available_balance: 0 },
          { user_id: req.user.id, currency: 'ZiG', country: metaCountry, balance: 0, locked_balance: 0, available_balance: 0 }
        ]
      : [{ user_id: req.user.id, currency: emergencyCurrency, country: metaCountry, balance: 0, locked_balance: 0, available_balance: 0 }];
    for (const w of walletsToCreate) {
      await supabase.from('wallets').upsert(w, { onConflict: 'user_id,currency' });
    }
  }

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { document_type } = req.body;
  if (!document_type) return res.status(400).json({ error: 'Document type required' });
  if (!KYC_DOCUMENT_TYPES.has(document_type)) {
    return res.status(400).json({ error: 'Invalid verification document type' });
  }

  const ext = req.file.originalname.split('.').pop().toLowerCase();
  const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const fileSizeKB = (req.file.size / 1024).toFixed(2) + ' KB';

  /* Normalise MIME type — mobile browsers sometimes send application/octet-stream for PDFs */
  const mimeMap = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  const mimeType = (req.file.mimetype && req.file.mimetype !== 'application/octet-stream')
    ? req.file.mimetype
    : (mimeMap[ext] || 'application/octet-stream');

  /* Validate file type on server side — strict allowlist */
  const ALLOWED_EXTS = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif'];
  if (!ALLOWED_EXTS.includes(ext)) {
    return res.status(400).json({ error: 'File type not allowed. Accepted: PDF, JPG, PNG, WebP' });
  }

  /* Convert to base64 — stored once in file_data; file_url points to the view endpoint (not a blob) */
  const base64Data = req.file.buffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64Data}`;

  /* Check if a document of this type already exists for this user.
     We do NOT rely on a DB UNIQUE constraint (avoids "no constraint" errors). */
  const { data: existing } = await supabase
    .from('verification_documents')
    .select('id')
    .eq('user_id', req.user.id)
    .eq('document_type', document_type)
    .maybeSingle();

  let docId;
  if (existing && existing.id) {
    /* Update the existing row in-place */
    const { error: updErr } = await supabase
      .from('verification_documents')
      .update({
        filename: safeName,
        file_path: '',
        /* file_url stores the view endpoint path — NOT the raw base64 */
        file_url: `/api/verification/document/${existing.id}/url`,
        file_data: dataUrl,
        file_size: fileSizeKB,
        status: 'pending',
        upload_status: 'uploaded',
        uploaded_at: new Date().toISOString()
      })
      .eq('id', existing.id);
    if (updErr) return res.status(400).json({ error: updErr.message });
    docId = existing.id;
  } else {
    /* Insert a fresh row first to get the ID, then update file_url with it */
    const { data: insertedDoc, error: insErr } = await supabase
      .from('verification_documents')
      .insert({
        user_id: req.user.id,
        document_type,
        filename: safeName,
        file_path: '',
        file_url: '',
        file_data: dataUrl,
        file_size: fileSizeKB,
        status: 'pending',
        upload_status: 'uploaded'
      })
      .select('id')
      .single();
    if (insErr) return res.status(400).json({ error: insErr.message });
    docId = insertedDoc.id;
    /* Patch file_url now that we have the ID */
    await supabase.from('verification_documents')
      .update({ file_url: `/api/verification/document/${docId}/url` })
      .eq('id', docId);
  }

  res.json({ success: true, id: docId, url: `/api/verification/document/${docId}/url`, document_type, filename: safeName, file_size: fileSizeKB });
});

/* DELETE /api/verification/document/:id */
app.delete('/api/verification/document/:id', authMiddleware, async (req, res) => {
  const { data: doc } = await supabase.from('verification_documents').select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.status === 'approved') return res.status(400).json({ error: 'Cannot delete an approved document' });

  /* File data is stored in the database (no storage bucket) — nothing to remove from storage */

  const { error } = await supabase.from('verification_documents').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

/* POST /api/verification/submit */
app.post('/api/verification/submit', authMiddleware, async (req, res) => {
  try {
    /* Guard: auto-create minimal profile if missing (same logic as upload endpoint) */
    const { data: profileCheck } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', req.user.id)
      .single();

    if (!profileCheck) {
      const email = req.user.email || '';
      const metaCountry = req.user.user_metadata?.country || '';
      const emergencyCurrencyMap = { Zambia: 'ZMW', Zimbabwe: 'USD', Namibia: 'NAD', Botswana: 'BWP' };
      const emergencyCurrency = emergencyCurrencyMap[metaCountry] || 'ZMW';
      const { error: upsertErr } = await supabase.from('profiles').upsert({
        id: req.user.id,
        email,
        full_name: req.user.user_metadata?.full_name || email.split('@')[0] || '',
        business_name: req.user.user_metadata?.business_name || '',
        country: metaCountry || null,
        currency: emergencyCurrency,
        account_type: 'business',
        verification_status: 'not_started',
        is_disabled: false,
        created_at: new Date().toISOString()
      }, { onConflict: 'id' });
      if (upsertErr) {
        console.error('[submit] profile upsert error:', upsertErr.message);
        return res.status(500).json({ error: 'Could not create user profile: ' + upsertErr.message });
      }
      /* Also ensure wallet(s) exist — profile missing usually means wallet missing too */
      const walletsToCreate = metaCountry === 'Zimbabwe'
        ? [
            { user_id: req.user.id, currency: 'USD', country: metaCountry, balance: 0, locked_balance: 0, available_balance: 0 },
            { user_id: req.user.id, currency: 'ZiG', country: metaCountry, balance: 0, locked_balance: 0, available_balance: 0 }
          ]
        : [{ user_id: req.user.id, currency: emergencyCurrency, country: metaCountry, balance: 0, locked_balance: 0, available_balance: 0 }];
      for (const w of walletsToCreate) {
        await supabase.from('wallets').upsert(w, { onConflict: 'user_id,currency' });
      }
    }

    const { data: docs, error: docsErr } = await supabase
      .from('verification_documents').select('*').eq('user_id', req.user.id);
    if (docsErr) {
      console.error('[submit] docs fetch error:', docsErr.message);
      return res.status(500).json({ error: 'Could not fetch documents: ' + docsErr.message });
    }
    const uploadedTypes = new Set((docs || []).map(doc => doc.document_type));
    const missingTypes = KYC_REQUIRED_DOCUMENT_TYPES.filter(type => !uploadedTypes.has(type));
    if (missingTypes.length > 0) {
      return res.status(400).json({
        error: 'Please upload all four required document categories, including both sides of the representative ID or passport.'
      });
    }

    /* Upsert verification submission row */
    const { error: subErr } = await supabase.from('verification_submissions').upsert({
      user_id: req.user.id,
      status: 'submitted',
      submitted_at: new Date().toISOString(),
       document_count: 4
    }, { onConflict: 'user_id' });
    if (subErr) {
      console.error('[submit] submission upsert error:', subErr.message);
      return res.status(500).json({ error: 'Could not record submission: ' + subErr.message });
    }

    /* Update profile verification status */
    const { error: profErr } = await supabase
      .from('profiles').update({ verification_status: 'submitted', updated_at: new Date().toISOString() })
      .eq('id', req.user.id);
    if (profErr) {
      console.error('[submit] profile update error:', profErr.message);
      /* Non-fatal — submission row was already saved; continue */
    }

    /* Send in-app notification (deduplicated to once per 10 min) */
    try {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: recentNotif } = await supabase.from('notifications')
        .select('id').eq('user_id', req.user.id).eq('title', 'Verification submitted')
        .gte('created_at', tenMinutesAgo).limit(1);
      if (!recentNotif || !recentNotif.length) {
        await supabase.from('notifications').insert({
          user_id: req.user.id,
          title: 'Verification submitted',
          message: 'Your account verification documents have been submitted and are under review. This usually takes 1–2 business days.',
          type: 'info',
          is_read: false
        });
      }
    } catch (notifErr) {
      console.error('[submit] notification error (non-fatal):', notifErr.message);
    }

    /* Audit log (non-fatal) */
    supabase.from('audit_log').insert({
      action: 'kyc_submitted',
      target_id: req.user.id,
       detail: 'Merchant submitted all four required document categories for KYC review',
      created_at: new Date().toISOString()
    }).then(null, () => {});

    return res.json({ success: true });
  } catch (err) {
    console.error('[submit] unexpected error:', err);
    return res.status(500).json({ error: 'Submission failed: ' + (err.message || 'Unknown server error') });
  }
});

/* ════════════════════════════════════════════
   ADMIN ROUTES
════════════════════════════════════════════ */

/* Stats overview */
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  const [users, verifiedUsers, pendingKyc, transactions, settlements, disbursements, activeLinks] = await Promise.all([
    supabase.from('profiles').select('id', { count: 'exact' }),
    supabase.from('profiles').select('id', { count: 'exact' }).eq('verification_status', 'verified'),
    supabase.from('profiles').select('id', { count: 'exact' }).in('verification_status', ['submitted', 'pending']),
    supabase.from('transactions').select('amount'),
    supabase.from('settlements').select('id', { count: 'exact' }).eq('status', 'pending'),
    supabase.from('disbursements').select('id', { count: 'exact' }).eq('status', 'pending'),
    supabase.from('payment_links').select('id', { count: 'exact' }).eq('status', 'active')
  ]);
  res.json({
    total_merchants: users.count || 0,
    verified_merchants: verifiedUsers.count || 0,
    pending_kyc: pendingKyc.count || 0,
    pending_settlements: settlements.count || 0,
    pending_disbursements: disbursements.count || 0,
    total_volume: (transactions.data || []).reduce((s, r) => s + Number(r.amount), 0),
    active_payment_links: activeLinks.count || 0
  });
});

/* Users list — flat array */
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  const { search } = req.query;
  let query = supabase.from('profiles').select('*').order('created_at', { ascending: false }).limit(200);
  if (search) query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,business_name.ilike.%${search}%`);
  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });

  const profiles = data || [];

  /* For any profile where country is missing, pull it from Supabase auth user_metadata */
  const missingIds = profiles.filter(p => !p.country).map(p => p.id);
  let metaCountryMap = {};
  if (missingIds.length > 0) {
    const results = await Promise.all(
      missingIds.map(id =>
        supabase.auth.admin.getUserById(id)
          .then(r => ({ id, country: r.data?.user?.user_metadata?.country || null }))
          .catch(() => ({ id, country: null }))
      )
    );
    results.forEach(r => { if (r.country) metaCountryMap[r.id] = r.country; });
  }

  const enriched = profiles.map(p => ({
    ...p,
    country: p.country || metaCountryMap[p.id] || null
  }));

  res.json(enriched);
});

/* Disable user */
app.post('/api/admin/users/:id/disable', adminMiddleware, async (req, res) => {
  const { reason } = req.body;
  const { error } = await supabase.from('profiles').update({
    is_disabled: true,
    disable_reason: reason || null,
    updated_at: new Date().toISOString()
  }).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });

  /* Ban in Supabase auth */
  await supabase.auth.admin.updateUserById(req.params.id, { ban_duration: '87600h' }).then(null, () => {});

  /* Insert audit log */
  await supabase.from('audit_log').insert({
    action: 'disable_user',
    target_id: req.params.id,
    detail: reason || 'No reason provided',
    created_at: new Date().toISOString()
  }).then(null, () => {});

  /* Notify user */
  await supabase.from('notifications').insert({
    user_id: req.params.id,
    title: 'Account Suspended',
    message: reason ? `Your account has been suspended. Reason: ${reason}` : 'Your account has been suspended. Please contact support.',
    type: 'error',
    is_read: false
  }).then(null, () => {});

  res.json({ success: true });
});

/* Enable user */
app.post('/api/admin/users/:id/enable', adminMiddleware, async (req, res) => {
  const { error } = await supabase.from('profiles').update({
    is_disabled: false,
    disable_reason: null,
    updated_at: new Date().toISOString()
  }).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });

  await supabase.auth.admin.updateUserById(req.params.id, { ban_duration: 'none' }).then(null, () => {});

  await supabase.from('audit_log').insert({
    action: 'enable_user',
    target_id: req.params.id,
    detail: 'Account re-enabled by admin',
    created_at: new Date().toISOString()
  }).then(null, () => {});

  await supabase.from('notifications').insert({
    user_id: req.params.id,
    title: 'Account Restored',
    message: 'Your account has been restored. You may now sign in and use NexaPay.',
    type: 'success',
    is_read: false
  }).then(null, () => {});

  res.json({ success: true });
});

/* KYC list */
app.get('/api/admin/kyc', adminMiddleware, async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('profiles').select('id,full_name,email,business_name,country,verification_status,updated_at,created_at').order('updated_at', { ascending: false }).limit(200);
  if (status === 'submitted') {
    query = query.in('verification_status', ['submitted', 'pending']);
  } else if (status === 'pending') {
    query = query.eq('verification_status', 'pending');
  }
  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

/* KYC approve / reject */
app.post('/api/admin/kyc/:userId/verified', adminMiddleware, async (req, res) => {
  try {
    const uid = req.params.userId;
    const { error: pErr } = await supabase.from('profiles').update({ verification_status: 'verified', updated_at: new Date().toISOString() }).eq('id', uid);
    if (pErr) return res.status(500).json({ error: pErr.message });
    await supabase.from('verification_submissions').update({ status: 'verified', reviewed_at: new Date().toISOString() }).eq('user_id', uid);
    await supabase.from('verification_documents').update({ status: 'approved' }).eq('user_id', uid);
    await supabase.from('notifications').insert({
      user_id: uid,
      title: '✅ Account Verified!',
      message: 'Congratulations! Your account has been verified. You now have full access to all NexaPay features.',
      type: 'success',
      is_read: false
    }).then(null, () => {});
    await supabase.from('audit_log').insert({ action: 'kyc_approved', target_id: uid, detail: 'KYC approved by admin', created_at: new Date().toISOString() }).then(null, () => {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Internal server error' });
  }
});

app.post('/api/admin/kyc/:userId/rejected', adminMiddleware, async (req, res) => {
  try {
    const uid = req.params.userId;
    const { reason } = req.body;
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'Rejection reason is required — the user must know what to fix.' });
    const { error: pErr } = await supabase.from('profiles').update({ verification_status: 'rejected', updated_at: new Date().toISOString() }).eq('id', uid);
    if (pErr) return res.status(500).json({ error: pErr.message });
    await supabase.from('verification_submissions').update({
      status: 'rejected',
      reviewed_at: new Date().toISOString(),
      rejection_reason: reason || null
    }).eq('user_id', uid);
    /* Mark all pending documents as rejected so user knows to re-upload */
    await supabase.from('verification_documents').update({ status: 'rejected' }).eq('user_id', uid).eq('status', 'pending');
    await supabase.from('notifications').insert({
      user_id: uid,
      title: 'Verification Rejected — Action Required',
      message: `Your verification was not approved. ${reason ? 'Reason: ' + reason + '. ' : ''}Please log in, go to Account Verification, and re-upload clearer documents.`,
      type: 'error',
      is_read: false
    }).then(null, () => {});
    await supabase.from('audit_log').insert({ action: 'kyc_rejected', target_id: uid, detail: reason || 'No reason given', created_at: new Date().toISOString() }).then(null, () => {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Internal server error' });
  }
});

/* KYC detail */
app.get('/api/admin/kyc/:userId/details', adminMiddleware, async (req, res) => {
  const uid = req.params.userId;
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', uid).single();
  /* Exclude file_data (base64 blobs) from the list response — admins load individual docs via /view */
  const { data: docs } = await supabase
    .from('verification_documents')
    .select('id, document_type, filename, file_size, file_url, status, rejection_reason, reviewed_at, created_at')
    .eq('user_id', uid)
    .order('created_at', { ascending: false });
  const { data: submission } = await supabase.from('verification_submissions').select('rejection_reason').eq('user_id', uid).single();
  if (!profile) return res.status(404).json({ error: 'User not found' });
  res.json({
    ...profile,
    rejection_reason: (submission && submission.rejection_reason) || null,
    documents: (docs || []).filter(d => KYC_DOCUMENT_TYPES.has(d.document_type))
  });
});

/* Transactions (admin) */
app.get('/api/admin/transactions', adminMiddleware, async (req, res) => {
  const { type, limit: lim = 100 } = req.query;
  let query = supabase.from('transactions').select('*').order('created_at', { ascending: false }).limit(Number(lim));
  if (type) query = query.eq('type', type);
  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });

  /* Enrich with merchant email from profiles */
  const userIds = [...new Set((data || []).map(t => t.user_id).filter(Boolean))];
  let emailMap = {};
  if (userIds.length) {
    const { data: profiles } = await supabase.from('profiles').select('id,email,full_name').in('id', userIds);
    (profiles || []).forEach(p => { emailMap[p.id] = p.email; });
  }

  res.json((data || []).map(t => ({ ...t, merchant_email: emailMap[t.user_id] || '—' })));
});

/* Settlements (admin) */
app.get('/api/admin/settlements', adminMiddleware, async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('settlements').select('*').order('created_at', { ascending: true }).limit(200);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });

  const userIds = [...new Set((data || []).map(s => s.user_id).filter(Boolean))];
  let emailMap = {};
  if (userIds.length) {
    const { data: profiles } = await supabase.from('profiles').select('id,email').in('id', userIds);
    (profiles || []).forEach(p => { emailMap[p.id] = p.email; });
  }

  res.json((data || []).map(s => ({ ...s, merchant_email: emailMap[s.user_id] || '—' })));
});

app.post('/api/admin/settlements/:id/approve', adminMiddleware, async (req, res) => {
  const { data: stl } = await supabase.from('settlements').select('*').eq('id', req.params.id).single();
  if (!stl) return res.status(404).json({ error: 'Not found' });
  await supabase.from('settlements').update({ status: 'success', processed_at: new Date().toISOString() }).eq('id', req.params.id);
  await supabase.from('notifications').insert({
    user_id: stl.user_id,
    title: 'Settlement Approved',
    message: `Your settlement of ${stl.currency || ''} ${stl.amount} has been approved and will be processed shortly.`,
    type: 'success',
    is_read: false
  });
  await supabase.from('audit_log').insert({ action: 'settlement_approved', target_id: req.params.id, detail: `Amount: ${stl.amount}`, created_at: new Date().toISOString() }).then(null, () => {});
  res.json({ success: true });
});

app.post('/api/admin/settlements/:id/reject', adminMiddleware, async (req, res) => {
  const { reason } = req.body;
  const { data: stl } = await supabase.from('settlements').select('*').eq('id', req.params.id).single();
  if (!stl) return res.status(404).json({ error: 'Not found' });
  await supabase.from('settlements').update({ status: 'rejected', processed_at: new Date().toISOString() }).eq('id', req.params.id);
  await supabase.from('notifications').insert({
    user_id: stl.user_id,
    title: 'Settlement Rejected',
    message: reason ? `Your settlement was rejected. Reason: ${reason}` : 'Your settlement request was rejected.',
    type: 'error',
    is_read: false
  });
  await supabase.from('audit_log').insert({ action: 'settlement_rejected', target_id: req.params.id, detail: reason || 'No reason', created_at: new Date().toISOString() }).then(null, () => {});
  res.json({ success: true });
});

/* Disbursements (admin) */
app.get('/api/admin/disbursements', adminMiddleware, async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('disbursements').select('*').order('created_at', { ascending: false }).limit(200);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });

  const userIds = [...new Set((data || []).map(d => d.user_id).filter(Boolean))];
  let emailMap = {};
  if (userIds.length) {
    const { data: profiles } = await supabase.from('profiles').select('id,email').in('id', userIds);
    (profiles || []).forEach(p => { emailMap[p.id] = p.email; });
  }

  res.json((data || []).map(d => ({ ...d, merchant_email: emailMap[d.user_id] || '—' })));
});

app.post('/api/admin/disbursements/:id/approve', adminMiddleware, async (req, res) => {
  const { data: disb } = await supabase.from('disbursements').select('*').eq('id', req.params.id).single();
  if (!disb) return res.status(404).json({ error: 'Not found' });
  await supabase.from('disbursements').update({ status: 'success', processed_at: new Date().toISOString() }).eq('id', req.params.id);
  await supabase.from('notifications').insert({
    user_id: disb.user_id,
    title: 'Disbursement Approved',
    message: `Your disbursement of ${disb.currency || ''} ${disb.amount} to ${disb.beneficiary_name} has been approved.`,
    type: 'success',
    is_read: false
  });
  await supabase.from('audit_log').insert({ action: 'disbursement_approved', target_id: req.params.id, detail: `Amount: ${disb.amount}`, created_at: new Date().toISOString() }).then(null, () => {});
  res.json({ success: true });
});

app.post('/api/admin/disbursements/:id/reject', adminMiddleware, async (req, res) => {
  const { reason } = req.body;
  const { data: disb } = await supabase.from('disbursements').select('*').eq('id', req.params.id).single();
  if (!disb) return res.status(404).json({ error: 'Not found' });
  await supabase.from('disbursements').update({ status: 'rejected', processed_at: new Date().toISOString() }).eq('id', req.params.id);
  await supabase.from('notifications').insert({
    user_id: disb.user_id,
    title: 'Disbursement Rejected',
    message: reason ? `Your disbursement was rejected. Reason: ${reason}` : 'Your disbursement request was rejected.',
    type: 'error',
    is_read: false
  });
  await supabase.from('audit_log').insert({ action: 'disbursement_rejected', target_id: req.params.id, detail: reason || 'No reason', created_at: new Date().toISOString() }).then(null, () => {});
  res.json({ success: true });
});

/* Audit log */
app.get('/api/admin/audit', adminMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

/* ── Health check ── */
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

/* ── Single wallet by currency ── */
app.get('/api/wallets/:currency', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('wallets').select('*')
    .eq('user_id', req.user.id).eq('currency', req.params.currency.toUpperCase()).single();
  if (error || !data) return res.status(404).json({ error: 'Wallet not found', available_balance: 0, currency: req.params.currency });
  res.json(data);
});

/* ── Transaction search with filters ── */
app.get('/api/transactions/search', authMiddleware, async (req, res) => {
  const { q, type, status, currency, channel, from, to } = req.query;
  let query = supabase.from('transactions').select('*')
    .eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(200);
  if (type)   query = query.eq('type', type);
  if (status) query = query.eq('status', status);
  if (currency) query = query.eq('currency', currency);
  if (channel)  query = query.eq('channel', channel);
  if (from) query = query.gte('created_at', new Date(from).toISOString());
  if (to)   query = query.lte('created_at', new Date(to + 'T23:59:59').toISOString());
  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });
  let results = data || [];
  if (q) {
    const ql = q.toLowerCase();
    results = results.filter(t =>
      (t.id || '').toLowerCase().includes(ql) ||
      (t.tx_ref || '').toLowerCase().includes(ql) ||
      (t.reference || '').toLowerCase().includes(ql)
    );
  }
  res.json(results);
});

/* ── Admin ping (cold-start connectivity test) ── */
app.get('/api/admin/ping', adminMiddleware, (req, res) => res.json({ ok: true, ts: Date.now() }));

/* ── Admin: per-document approve ── */
app.post('/api/admin/kyc/:userId/document/:docId/approve', adminMiddleware, async (req, res) => {
  try {
    const { docId, userId } = req.params;
    const { error } = await supabase.from('verification_documents')
      .update({ status: 'approved', reviewed_at: new Date().toISOString() })
      .eq('id', docId);
    if (error) return res.status(500).json({ error: error.message });
    await supabase.from('notifications').insert({
      user_id: userId,
      title: 'Document Approved',
      message: 'One of your KYC documents has been approved by our team.',
      type: 'success', is_read: false
    }).then(null, () => {});
    await supabase.from('audit_log').insert({ action: 'kyc_doc_approved', target_id: userId, detail: 'Document approved: ' + docId, created_at: new Date().toISOString() }).then(null, () => {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Internal server error' });
  }
});

/* ── Admin: per-document reject ── */
app.post('/api/admin/kyc/:userId/document/:docId/reject', adminMiddleware, async (req, res) => {
  try {
    const { docId, userId } = req.params;
    const { reason } = req.body;
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'Rejection reason is required — the user must know what to fix.' });
    const { error } = await supabase.from('verification_documents')
      .update({ status: 'rejected', rejection_reason: reason.trim(), reviewed_at: new Date().toISOString() })
      .eq('id', docId);
    if (error) return res.status(500).json({ error: error.message });
    const { data: doc } = await supabase.from('verification_documents').select('document_type').eq('id', docId).single();
    await supabase.from('notifications').insert({
      user_id: userId,
      title: 'Document Needs Re-upload',
      message: `Your ${doc ? doc.document_type : 'KYC document'} was rejected.${reason ? ' Reason: ' + reason : ''} Please upload a clearer version.`,
      type: 'error', is_read: false
    }).then(null, () => {});
    await supabase.from('audit_log').insert({ action: 'kyc_doc_rejected', target_id: userId, detail: (reason || 'No reason given') + ' | doc: ' + docId, created_at: new Date().toISOString() }).then(null, () => {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Internal server error' });
  }
});

/* ── Admin: per-user KYC audit trail ── */
app.get('/api/admin/kyc/:userId/audit', adminMiddleware, async (req, res) => {
  const { data: entries } = await supabase
    .from('audit_log')
    .select('*')
    .eq('target_id', req.params.userId)
    .order('created_at', { ascending: false })
    .limit(50);
  res.json(entries || []);
});

/* ── Admin: global KYC audit log (all merchants) ── */
app.get('/api/admin/audit/kyc', adminMiddleware, async (req, res) => {
  const { data: entries } = await supabase
    .from('audit_log')
    .select('*')
    .in('action', ['kyc_submitted','kyc_approved','kyc_rejected','kyc_doc_approved','kyc_doc_rejected'])
    .order('created_at', { ascending: false })
    .limit(200);

  if (!entries || !entries.length) return res.json([]);

  const userIds = [...new Set(entries.map(e => e.target_id).filter(Boolean))];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, full_name, email, business_name')
    .in('id', userIds);

  const profileMap = {};
  (profiles || []).forEach(p => { profileMap[p.id] = p; });

  res.json(entries.map(e => ({ ...e, merchant: profileMap[e.target_id] || null })));
});

/* ── Admin: all payment links across all merchants ── */
app.get('/api/admin/payment-links', adminMiddleware, async (req, res) => {
  const { status, search } = req.query;
  let query = supabase.from('payment_links').select('*').order('created_at', { ascending: false }).limit(300);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });

  const userIds = [...new Set((data || []).map(l => l.user_id).filter(Boolean))];
  let emailMap = {};
  if (userIds.length) {
    const { data: profiles } = await supabase.from('profiles').select('id,email,full_name').in('id', userIds);
    (profiles || []).forEach(p => { emailMap[p.id] = p.email; });
  }

  let result = (data || []).map(l => ({ ...l, merchant_email: emailMap[l.user_id] || '—' }));

  /* Local search filter across name, merchant email, slug */
  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    result = result.filter(l =>
      (l.name || '').toLowerCase().includes(q) ||
      (l.title || '').toLowerCase().includes(q) ||
      (l.merchant_email || '').toLowerCase().includes(q) ||
      (l.slug || '').toLowerCase().includes(q)
    );
  }

  res.json(result);
});

/* ── Admin: deactivate a payment link ── */
app.post('/api/admin/payment-links/:id/deactivate', adminMiddleware, async (req, res) => {
  const { data: link } = await supabase.from('payment_links').select('user_id,name').eq('id', req.params.id).single();
  if (!link) return res.status(404).json({ error: 'Payment link not found' });
  const { error } = await supabase.from('payment_links').update({ status: 'inactive' }).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  await supabase.from('notifications').insert({
    user_id: link.user_id,
    title: 'Payment Link Deactivated',
    message: `Your payment link "${link.name || req.params.id}" has been deactivated by the admin team.`,
    type: 'error', is_read: false
  }).then(null, () => {});
  await supabase.from('audit_log').insert({
    action: 'payment_link_deactivated', target_id: req.params.id,
    detail: `Link: ${link.name || req.params.id}`, created_at: new Date().toISOString()
  }).then(null, () => {});
  res.json({ success: true });
});

/* ── Admin: send custom notification to a user ── */
app.post('/api/admin/users/:id/notify', adminMiddleware, async (req, res) => {
  const { title, message, type } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Notification title is required' });
  if (!message || !message.trim()) return res.status(400).json({ error: 'Notification message is required' });
  const validTypes = ['info', 'success', 'warning', 'error'];
  const notifType = validTypes.includes(type) ? type : 'info';

  const { error } = await supabase.from('notifications').insert({
    user_id: req.params.id,
    title: title.trim(),
    message: message.trim(),
    type: notifType,
    is_read: false
  });
  if (error) return res.status(400).json({ error: error.message });

  await supabase.from('audit_log').insert({
    action: 'notify_user', target_id: req.params.id,
    detail: `Title: ${title.trim()} | Type: ${notifType}`, created_at: new Date().toISOString()
  }).then(null, () => {});

  res.json({ success: true });
});

/* ── Admin: full user details (profile + wallets + counts + docs) ── */
app.get('/api/admin/users/:id/full', adminMiddleware, async (req, res) => {
  const uid = req.params.id;
  const [profileRes, walletsRes, docsRes, txnRes, settlRes, disbRes, linksRes, benefRes, submissionRes] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', uid).single(),
    supabase.from('wallets').select('*').eq('user_id', uid),
    supabase.from('verification_documents')
      .select('id, document_type, filename, file_size, file_url, status, rejection_reason, reviewed_at, created_at')
      .eq('user_id', uid).order('created_at', { ascending: false }),
    supabase.from('transactions').select('id', { count: 'exact' }).eq('user_id', uid),
    supabase.from('settlements').select('id', { count: 'exact' }).eq('user_id', uid),
    supabase.from('disbursements').select('id', { count: 'exact' }).eq('user_id', uid),
    supabase.from('payment_links').select('id', { count: 'exact' }).eq('user_id', uid),
    supabase.from('beneficiaries').select('id', { count: 'exact' }).eq('user_id', uid),
    supabase.from('verification_submissions').select('rejection_reason').eq('user_id', uid).single()
  ]);

  if (!profileRes.data) return res.status(404).json({ error: 'User not found' });

  res.json({
    ...profileRes.data,
    rejection_reason: (submissionRes.data && submissionRes.data.rejection_reason) || null,
    wallets: walletsRes.data || [],
    documents: (docsRes.data || []).filter(d => KYC_DOCUMENT_TYPES.has(d.document_type)),
    _counts: {
      transactions: txnRes.count || 0,
      settlements: settlRes.count || 0,
      disbursements: disbRes.count || 0,
      payment_links: linksRes.count || 0,
      beneficiaries: benefRes.count || 0,
      documents: (docsRes.data || []).filter(d => KYC_DOCUMENT_TYPES.has(d.document_type)).length
    }
  });
});

/* ── Admin: download document as raw binary file ── */
app.get('/api/admin/kyc/:userId/document/:docId/download', adminMiddleware, async (req, res) => {
  const { docId, userId } = req.params;
  const { data: doc } = await supabase
    .from('verification_documents')
    .select('file_data, file_url, filename')
    .eq('id', docId)
    .eq('user_id', userId)   /* enforce that the doc belongs to the stated user */
    .single();
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  /* Old-server uploads: file_data is null but file_url is a Supabase Storage public URL */
  if (!doc.file_data && doc.file_url && doc.file_url.startsWith('http')) {
    return res.redirect(doc.file_url);
  }
  if (!doc.file_data) return res.status(404).json({ error: 'Document data not available' });

  /* Parse the data URL: data:<mime>;base64,<data> */
  const match = doc.file_data.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return res.status(500).json({ error: 'Stored file data is corrupt' });

  const mimeType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  const safeName = (doc.filename || 'document').replace(/[^a-zA-Z0-9._-]/g, '_');

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
});

/* ── Admin: get signed URL for document viewing ── */
app.get('/api/admin/kyc/:userId/document/:docId/view', adminMiddleware, async (req, res) => {
  const { docId } = req.params;
  const { data: doc } = await supabase
    .from('verification_documents')
    .select('file_data, file_url, filename')
    .eq('id', docId)
    .single();
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  /* Old-server uploads have file_url (Supabase Storage) but no file_data */
  const url = doc.file_data || (doc.file_url && doc.file_url.startsWith('http') ? doc.file_url : null);
  if (!url) return res.status(404).json({ error: 'Document data not available' });
  res.json({ url, filename: doc.filename });
});

/* ── User: fetch own document for viewing ── */
app.get('/api/verification/document/:docId/url', authMiddleware, async (req, res) => {
  const { data: doc } = await supabase
    .from('verification_documents')
    .select('file_data, file_url, filename')
    .eq('id', req.params.docId)
    .eq('user_id', req.user.id)
    .single();
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  /* Old-server uploads have file_url (Supabase Storage) but no file_data */
  const url = doc.file_data || (doc.file_url && doc.file_url.startsWith('http') ? doc.file_url : null);
  if (!url) return res.status(404).json({ error: 'Document data not available' });
  res.json({ url, filename: doc.filename });
});


/* ════════════════════════════════════════════
   SANDBOX SIMULATION ROUTES
   Realistic mobile money payment simulation
════════════════════════════════════════════ */

const SANDBOX_PHONE_RULES = {
  '26096': { network: 'MTN Zambia', country: 'Zambia', currency: 'ZMW' },
  '26097': { network: 'MTN Zambia', country: 'Zambia', currency: 'ZMW' },
  '26076': { network: 'Airtel Zambia', country: 'Zambia', currency: 'ZMW' },
  '26077': { network: 'Airtel Zambia', country: 'Zambia', currency: 'ZMW' },
  '26326': { network: 'EcoCash', country: 'Zimbabwe', currency: 'USD' },
  '26377': { network: 'NetOne', country: 'Zimbabwe', currency: 'USD' },
  '26781': { network: 'Orange Botswana', country: 'Botswana', currency: 'BWP' },
  '26474': { network: 'MTC Namibia', country: 'Namibia', currency: 'NAD' },
};

const SANDBOX_TEST_NUMBERS = {
  '260960000001': 'success',
  '260960000002': 'failed',
  '260960000003': 'timeout',
  '260960000004': 'insufficient_funds',
  '260760000001': 'success',
  '263260000001': 'success',
  '263260000002': 'failed',
};

function detectNetwork(phone) {
  const cleaned = phone.replace(/[\s\-\+]/g, '');
  for (const prefix of Object.keys(SANDBOX_PHONE_RULES)) {
    if (cleaned.startsWith(prefix)) return SANDBOX_PHONE_RULES[prefix];
  }
  return { network: 'Unknown', country: 'Unknown', currency: 'USD' };
}

function sandboxAuthMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const key = auth.replace('Bearer ', '').replace('Basic ', '');
  if (!key || (!key.startsWith('npay_test_') && !key.startsWith('npay_live_'))) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Invalid or missing API key. Use npay_test_sec_... for sandbox.',
      docs: 'https://nexapay.net/docs'
    });
  }
  if (key.startsWith('npay_live_') && req.path.includes('sandbox')) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Live keys cannot be used on the sandbox endpoint. Use npay_test_sec_...',
    });
  }
  req.sandboxMode = key.startsWith('npay_test_');
  next();
}

/* ── Sandbox: Charge (collect payment from customer) ── */
app.post(['/sandbox/v2/payments/charge', '/api/v2/payments/charge'], sandboxAuthMiddleware, async (req, res) => {
  const { phone, amount, currency, network, reference, description, callback_url } = req.body;

  if (!phone) return res.status(422).json({ error: 'validation_error', message: 'phone is required', field: 'phone' });
  if (!amount || isNaN(amount) || Number(amount) <= 0) return res.status(422).json({ error: 'validation_error', message: 'amount must be a positive number', field: 'amount' });
  if (!currency) return res.status(422).json({ error: 'validation_error', message: 'currency is required', field: 'currency' });

  const networkInfo = detectNetwork(phone);
  const txId = 'pay_' + uuidv4().replace(/-/g, '').substring(0, 20);
  const testOutcome = SANDBOX_TEST_NUMBERS[phone.replace(/[\s\-\+]/g, '')] || 'success';

  /* Immediate pending response — like real gateways */
  const pendingResponse = {
    id: txId,
    status: 'pending',
    type: 'charge',
    amount: Number(amount),
    currency: currency.toUpperCase(),
    phone: phone.replace(/[\s\-\+]/g, ''),
    network: network || networkInfo.network,
    country: networkInfo.country,
    reference: reference || 'REF-' + Date.now(),
    description: description || 'Payment via NexaPay',
    created_at: new Date().toISOString(),
    estimated_completion: new Date(Date.now() + 15000).toISOString(),
    sandbox: true,
    message: 'Payment initiated. Customer will receive a prompt on their phone.',
    webhook_url: callback_url || null,
    _test_tip: `This number will result in: ${testOutcome}`
  };

  res.status(202).json(pendingResponse);

  /* Async: simulate the payment completing and call webhook */
  if (callback_url) {
    const delay = testOutcome === 'timeout' ? 30000 : testOutcome === 'failed' ? 5000 : 8000;
    setTimeout(async () => {
      const finalStatus = testOutcome === 'timeout' ? 'failed' : testOutcome;
      const webhookPayload = {
        event: finalStatus === 'success' ? 'payment.success' : 'payment.failed',
        id: 'evt_' + uuidv4().replace(/-/g, '').substring(0, 18),
        created_at: new Date().toISOString(),
        data: {
          id: txId,
          status: finalStatus,
          amount: Number(amount),
          currency: currency.toUpperCase(),
          phone,
          network: network || networkInfo.network,
          reference: reference || 'REF-' + Date.now(),
          failure_reason: finalStatus !== 'success' ? (testOutcome === 'insufficient_funds' ? 'Insufficient funds' : testOutcome === 'timeout' ? 'Customer did not respond' : 'Transaction declined') : null,
          settled_at: finalStatus === 'success' ? new Date().toISOString() : null,
          sandbox: true
        }
      };
      try {
        const fetch = (await import('node-fetch')).default;
        await fetch(callback_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-NexaPay-Signature': 'sandbox_sig_' + uuidv4().replace(/-/g,'').substring(0,16) },
          body: JSON.stringify(webhookPayload)
        });
      } catch(e) { /* webhook delivery failed silently */ }
    }, delay);
  }
});

/* ── Sandbox: Check payment status ── */
app.get(['/sandbox/v2/payments/:id', '/api/v2/payments/:id'], sandboxAuthMiddleware, (req, res) => {
  const { id } = req.params;
  if (!id.startsWith('pay_')) return res.status(404).json({ error: 'not_found', message: 'Payment not found' });
  res.json({
    id,
    status: 'success',
    amount: 150.00,
    currency: 'ZMW',
    phone: '260960000001',
    network: 'MTN Zambia',
    reference: 'REF-SANDBOX',
    description: 'Sandbox payment',
    created_at: new Date(Date.now() - 15000).toISOString(),
    settled_at: new Date().toISOString(),
    sandbox: true
  });
});

/* ── Sandbox: Payout (send money to customer) ── */
app.post(['/sandbox/v2/payouts', '/api/v2/payouts'], sandboxAuthMiddleware, (req, res) => {
  const { phone, amount, currency, reference, description } = req.body;
  if (!phone || !amount || !currency) {
    return res.status(422).json({ error: 'validation_error', message: 'phone, amount and currency are required' });
  }
  const networkInfo = detectNetwork(phone);
  res.status(202).json({
    id: 'po_' + uuidv4().replace(/-/g, '').substring(0, 20),
    status: 'pending',
    type: 'payout',
    amount: Number(amount),
    currency: currency.toUpperCase(),
    phone,
    network: networkInfo.network,
    country: networkInfo.country,
    reference: reference || 'POUT-' + Date.now(),
    description: description || 'Payout via NexaPay',
    created_at: new Date().toISOString(),
    estimated_arrival: new Date(Date.now() + 10000).toISOString(),
    sandbox: true,
    message: 'Payout initiated. Funds will be sent to the recipient shortly.'
  });
});

/* ── Sandbox: Refund ── */
app.post(['/sandbox/v2/payments/:id/refunds', '/api/v2/payments/:id/refunds'], sandboxAuthMiddleware, (req, res) => {
  const { id } = req.params;
  const { amount, reason } = req.body;
  res.status(201).json({
    id: 'rfd_' + uuidv4().replace(/-/g, '').substring(0, 20),
    payment_id: id,
    status: 'success',
    amount: Number(amount) || 0,
    reason: reason || 'Customer request',
    created_at: new Date().toISOString(),
    sandbox: true
  });
});

/* ── Sandbox: Webhooks register ── */
app.post(['/sandbox/v2/webhooks', '/api/v2/webhooks'], sandboxAuthMiddleware, (req, res) => {
  const { url, events } = req.body;
  if (!url) return res.status(422).json({ error: 'validation_error', message: 'url is required' });
  res.status(201).json({
    id: 'wh_' + uuidv4().replace(/-/g, '').substring(0, 20),
    url,
    events: events || ['payment.success', 'payment.failed', 'payout.success'],
    status: 'active',
    created_at: new Date().toISOString(),
    sandbox: true
  });
});

/* ── Sandbox: Webhook test trigger ── */
app.post(['/sandbox/v2/webhooks/test', '/api/v2/webhooks/test'], sandboxAuthMiddleware, (req, res) => {
  const { url, event } = req.body;
  res.json({
    delivered: true,
    event: event || 'payment.success',
    url: url,
    response_code: 200,
    sandbox: true,
    message: 'Test webhook delivered successfully'
  });
});

/* ── Sandbox: Balance ── */
app.get(['/sandbox/v2/balance', '/api/v2/balance'], sandboxAuthMiddleware, (req, res) => {
  res.json({
    available: [
      { currency: 'ZMW', amount: 12500.00, country: 'Zambia' },
      { currency: 'USD', amount: 850.00, country: 'Zimbabwe' },
      { currency: 'BWP', amount: 3200.00, country: 'Botswana' },
      { currency: 'NAD', amount: 5600.00, country: 'Namibia' }
    ],
    pending: [
      { currency: 'ZMW', amount: 450.00 }
    ],
    sandbox: true
  });
});

/* ── Sandbox: Test phone numbers reference ── */
app.get('/sandbox/v2/test-numbers', (req, res) => {
  res.json({
    description: 'Use these phone numbers in sandbox to simulate different outcomes',
    numbers: [
      { phone: '260960000001', network: 'MTN Zambia', outcome: 'success', note: 'Payment succeeds' },
      { phone: '260960000002', network: 'MTN Zambia', outcome: 'failed', note: 'Payment declined' },
      { phone: '260960000003', network: 'MTN Zambia', outcome: 'timeout', note: 'Customer does not respond' },
      { phone: '260960000004', network: 'MTN Zambia', outcome: 'insufficient_funds', note: 'Not enough balance' },
      { phone: '260760000001', network: 'Airtel Zambia', outcome: 'success', note: 'Payment succeeds' },
      { phone: '263260000001', network: 'EcoCash Zimbabwe', outcome: 'success', note: 'Payment succeeds' },
      { phone: '263260000002', network: 'EcoCash Zimbabwe', outcome: 'failed', note: 'Payment declined' }
    ],
    sandbox: true
  });
});

/* ── API health ── */
app.get(['/api/health', '/api/v2/health', '/sandbox/v2/health'], (req, res) => {
  res.json({
    status: 'operational',
    version: 'v2',
    environment: 'sandbox',
    region: 'af-south',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      api: 'operational',
      sandbox: 'operational',
      webhooks: 'operational',
      payments: 'operational'
    }
  });
});


/* ── Docs access verification — used by docs.html auth guard ── */
app.get('/api/docs/verify', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired session' });
  }
  /* Fetch the profile — need full_name, email, verification_status, is_disabled */
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, email, verification_status, is_disabled')
    .eq('id', user.id)
    .single();
  if (profile && profile.is_disabled) {
    return res.status(403).json({ ok: false, error: 'Account suspended' });
  }
  return res.json({
    ok: true,
    email: profile?.email || user.email,
    full_name: profile?.full_name || null,
    verification_status: profile?.verification_status || 'not_started'
  });
});

/* ── Catch-all ── */
app.get('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

/* ── Global error handler — always return JSON, never HTML ── */
app.use((err, req, res, _next) => {
  console.error('[Server Error]', err.message || err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`NexaPay server running on port ${PORT}`);
  console.log(`Frontend: https://nexapay.net/auth.html`);
  console.log(`Dashboard: https://nexapay.net/dashboard.html`);
  console.log(`Backend API: https://api.nexapay.net/api/health`);
});
