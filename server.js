const express = require('express');
const session = require('express-session');
const { createClient } = require('@libsql/client');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  if (isProduction) {
    console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN. Set both in Render Environment Variables.');
    process.exit(1);
  }
  console.warn('TURSO_DATABASE_URL/TURSO_AUTH_TOKEN not set. Using local.db for local development only.');
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Production-safe session storage backed by Turso instead of MemoryStore.
class TursoSessionStore extends session.Store {
  async get(sid, callback) {
    try {
      const result = await db.execute({ sql: 'SELECT data, expires_at FROM sessions WHERE sid = ?', args: [sid] });
      if (!result.rows.length) return callback(null, null);
      const row = result.rows[0];
      if (row.expires_at && Number(row.expires_at) <= Date.now()) {
        await db.execute({ sql: 'DELETE FROM sessions WHERE sid = ?', args: [sid] });
        return callback(null, null);
      }
      callback(null, JSON.parse(row.data));
    } catch (err) { callback(err); }
  }

  async set(sid, sess, callback) {
    try {
      const expiresAt = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 1000 * 60 * 60 * 24 * 7;
      await db.execute({
        sql: `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
              ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
        args: [sid, JSON.stringify(sess), expiresAt],
      });
      callback(null);
    } catch (err) { callback(err); }
  }

  async destroy(sid, callback) {
    try {
      await db.execute({ sql: 'DELETE FROM sessions WHERE sid = ?', args: [sid] });
      callback(null);
    } catch (err) { callback(err); }
  }

  async touch(sid, sess, callback) {
    try {
      const expiresAt = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 1000 * 60 * 60 * 24 * 7;
      await db.execute({ sql: 'UPDATE sessions SET expires_at = ? WHERE sid = ?', args: [expiresAt, sid] });
      callback(null);
    } catch (err) { callback(err); }
  }
}

app.use(session({
  store: new TursoSessionStore(),
  secret: process.env.SESSION_SECRET || 'change-this-session-secret-in-render',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
}));

// Memory upload first; the bytes are then stored in Turso as a data URL.
// This makes product/logo images survive Render restarts and redeploys.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed.'));
    }
    cb(null, true);
  },
});

function fileToDataUrl(file) {
  if (!file || !file.buffer) return null;
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

function cleanText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function parseMoney(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function initDb() {
  await db.execute(`CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL, price REAL NOT NULL DEFAULT 0, old_price REAL NOT NULL DEFAULT 0, image TEXT, description TEXT, is_featured INTEGER NOT NULL DEFAULT 0)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT UNIQUE NOT NULL, customer_name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, total REAL NOT NULL DEFAULT 0, payment_method TEXT NOT NULL, trx_id TEXT, status TEXT NOT NULL DEFAULT 'Pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL)`);

  // Migrate older Turso schemas without deleting existing data.
  async function ensureColumn(table, column, definition) {
    const info = await db.execute(`PRAGMA table_info(${table})`);
    const exists = info.rows.some(row => String(row.name).toLowerCase() === column.toLowerCase());
    if (!exists) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  await ensureColumn('products', 'old_price', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn('products', 'image', 'TEXT');
  await ensureColumn('products', 'description', 'TEXT');
  await ensureColumn('products', 'is_featured', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('orders', 'trx_id', 'TEXT');
  await ensureColumn('orders', 'status', "TEXT NOT NULL DEFAULT 'Pending'");
  await ensureColumn('orders', 'created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');

  const defaults = [
    ['store_name', 'Royal Silk & Saree'],
    ['store_logo', '/uploads/default-logo.svg'],
    ['theme_color', '#800020'],
    ['delivery_time', 'Inside Dhaka: 2-3 Days, Outside Dhaka: 3-5 Days'],
    ['store_info', 'We sell 100% pure Katan, Jamdani, Banarasi, and Georgette sarees directly from weavers.'],
    ['chat_order_prompt', 'To place an order via chat, please provide your Name, Phone Number, Delivery Address, and the Product Name.'],
  ];
  for (const [key, value] of defaults) {
    await db.execute({ sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', args: [key, value] });
  }

  const adminResult = await db.execute('SELECT id FROM admin WHERE username = ?', ['admin']);
  if (!adminResult.rows.length) {
    const password = process.env.ADMIN_SECRET_FALLBACK_PASSWORD || 'admin123';
    const hashed = await bcrypt.hash(password, 12);
    await db.execute({ sql: 'INSERT INTO admin (username, password) VALUES (?, ?)', args: ['admin', hashed] });
    console.log('Default admin created. Change the password immediately from Admin Settings.');
  }

  // Clean expired sessions occasionally.
  await db.execute({ sql: 'DELETE FROM sessions WHERE expires_at < ?', args: [Date.now()] });
}

async function getSettings() {
  const result = await db.execute('SELECT key, value FROM settings');
  const settings = {};
  result.rows.forEach(row => { settings[row.key] = row.value; });
  return settings;
}

// Every page receives current settings/admin/cart count from the same database.
app.use(async (req, res, next) => {
  try {
    res.locals.settings = await getSettings();
    res.locals.admin = req.session.admin || null;
    res.locals.cartCount = Array.isArray(req.session.cart)
      ? req.session.cart.reduce((sum, item) => sum + Number(item.qty || 0), 0)
      : 0;
    next();
  } catch (err) {
    console.error('Global middleware error:', err);
    next(err);
  }
});

// ---------- Frontend ----------
app.get('/', async (req, res, next) => {
  try {
    const [featured, products] = await Promise.all([
      db.execute('SELECT * FROM products WHERE is_featured = 1 ORDER BY id DESC LIMIT 8'),
      db.execute('SELECT * FROM products ORDER BY id DESC LIMIT 8'),
    ]);
    res.render('index', { featured: featured.rows, products: products.rows });
  } catch (err) { next(err); }
});

app.get('/shop', async (req, res, next) => {
  try {
    const category = cleanText(req.query.category, 'All');
    const search = cleanText(req.query.search);
    let sql = 'SELECT * FROM products WHERE 1=1';
    const args = [];
    if (category !== 'All') { sql += ' AND category = ?'; args.push(category); }
    if (search) { sql += ' AND (name LIKE ? OR description LIKE ?)'; args.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY id DESC';
    const [result, categoriesRes] = await Promise.all([
      db.execute({ sql, args }),
      db.execute('SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != "" ORDER BY category'),
    ]);
    res.render('shop', { products: result.rows, categories: categoriesRes.rows, currentCategory: category, search });
  } catch (err) { next(err); }
});

app.get('/product/:id', async (req, res, next) => {
  try {
    const product = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [req.params.id] });
    if (!product.rows.length) return res.status(404).send('Product not found');
    const related = await db.execute({ sql: 'SELECT * FROM products WHERE category = ? AND id != ? ORDER BY id DESC LIMIT 4', args: [product.rows[0].category, req.params.id] });
    res.render('product', { product: product.rows[0], related: related.rows });
  } catch (err) { next(err); }
});

app.post('/cart/add', (req, res) => {
  const id = cleanText(req.body.id);
  const name = cleanText(req.body.name);
  const image = cleanText(req.body.image);
  const price = parseMoney(req.body.price);
  if (!id || !name) return res.status(400).send('Invalid product');
  if (!req.session.cart) req.session.cart = [];
  const existing = req.session.cart.find(item => String(item.id) === id);
  if (existing) existing.qty += 1;
  else req.session.cart.push({ id, name, price, image, qty: 1 });
  res.redirect('/cart');
});

app.get('/cart', (req, res) => res.render('cart', { cart: req.session.cart || [] }));

app.post('/cart/update', (req, res) => {
  const id = cleanText(req.body.id);
  const qty = Math.max(0, parseInt(req.body.qty, 10) || 0);
  req.session.cart = (req.session.cart || []).map(item => {
    if (String(item.id) === id) item.qty = qty;
    return item;
  }).filter(item => item.qty > 0);
  res.redirect('/cart');
});

app.get('/checkout', (req, res) => {
  const cart = req.session.cart || [];
  if (!cart.length) return res.redirect('/cart');
  const total = cart.reduce((sum, i) => sum + Number(i.price) * Number(i.qty), 0);
  res.render('checkout', { cart, total });
});

app.post('/order/place', async (req, res, next) => {
  try {
    const customer_name = cleanText(req.body.customer_name);
    const phone = cleanText(req.body.phone);
    const address = cleanText(req.body.address);
    const payment_method = cleanText(req.body.payment_method, 'COD');
    const trx_id = cleanText(req.body.trx_id);
    const cart = req.session.cart || [];
    if (!cart.length) return res.redirect('/cart');
    if (!customer_name || !phone || !address) return res.status(400).send('Name, phone and address are required.');
    const allowedPayments = ['bKash', 'Nagad', 'Rocket', 'COD'];
    if (!allowedPayments.includes(payment_method)) return res.status(400).send('Invalid payment method.');
    if (payment_method !== 'COD' && !trx_id) return res.status(400).send('Transaction ID is required.');

    const total = cart.reduce((sum, i) => sum + Number(i.price) * Number(i.qty), 0);
    const order_id = `SAR-${Date.now().toString().slice(-6)}${crypto.randomInt(10, 99)}`;
    await db.execute({
      sql: 'INSERT INTO orders (order_id, customer_name, phone, address, total, payment_method, trx_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [order_id, customer_name, phone, address, total, payment_method, trx_id || 'COD'],
    });
    req.session.cart = [];
    res.render('tracking', { order: { order_id, customer_name, phone, address, total, payment_method, trx_id: trx_id || 'COD', status: 'Pending' }, success: true });
  } catch (err) { next(err); }
});

app.get('/track', async (req, res, next) => {
  try {
    const order_id = cleanText(req.query.order_id);
    let order = null;
    if (order_id) {
      const result = await db.execute({ sql: 'SELECT * FROM orders WHERE order_id = ?', args: [order_id] });
      order = result.rows[0] || null;
    }
    res.render('tracking', { order, success: false, order_id });
  } catch (err) { next(err); }
});

// ---------- Admin ----------
app.get('/admin/login', (req, res) => res.render('admin/login', { error: null }));

app.post('/admin/login', async (req, res) => {
  try {
    const username = cleanText(req.body.username);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const result = await db.execute({ sql: 'SELECT * FROM admin WHERE username = ?', args: [username] });
    if (result.rows.length && await bcrypt.compare(password, result.rows[0].password)) {
      req.session.regenerate(err => {
        if (err) return res.status(500).render('admin/login', { error: 'Could not start secure session.' });
        req.session.admin = { id: result.rows[0].id, username: result.rows[0].username };
        req.session.save(saveErr => saveErr ? res.status(500).render('admin/login', { error: 'Could not save login session.' }) : res.redirect('/admin/dashboard'));
      });
      return;
    }
    res.status(401).render('admin/login', { error: 'Invalid username or password' });
  } catch (err) {
    console.error(err);
    res.status(500).render('admin/login', { error: 'Database error during login' });
  }
});

app.get('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/admin/login')));

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.redirect('/admin/login');
  next();
}

app.get('/admin/dashboard', requireAdmin, async (req, res, next) => {
  try {
    const [revenueRes, ordersCount, productsCount, recentOrders] = await Promise.all([
      db.execute('SELECT COALESCE(SUM(total), 0) AS rev FROM orders'),
      db.execute('SELECT COUNT(*) AS cnt FROM orders'),
      db.execute('SELECT COUNT(*) AS cnt FROM products'),
      db.execute('SELECT * FROM orders ORDER BY id DESC LIMIT 5'),
    ]);
    res.render('admin/dashboard', {
      revenue: Number(revenueRes.rows[0].rev || 0),
      ordersCount: Number(ordersCount.rows[0].cnt || 0),
      productsCount: Number(productsCount.rows[0].cnt || 0),
      recentOrders: recentOrders.rows,
    });
  } catch (err) { next(err); }
});

app.get('/admin/products', requireAdmin, async (req, res, next) => {
  try {
    const products = await db.execute('SELECT * FROM products ORDER BY id DESC');
    res.render('admin/products', { products: products.rows, message: null });
  } catch (err) { next(err); }
});

app.post('/admin/products/add', requireAdmin, upload.single('image'), async (req, res, next) => {
  try {
    const name = cleanText(req.body.name);
    const category = cleanText(req.body.category);
    const price = parseMoney(req.body.price);
    const old_price = parseMoney(req.body.old_price, price);
    const description = cleanText(req.body.description);
    const is_featured = req.body.is_featured ? 1 : 0;
    if (!name || !category) return res.status(400).send('Product name and category are required.');
    const image = fileToDataUrl(req.file) || '/uploads/default-saree.svg';
    await db.execute({
      sql: 'INSERT INTO products (name, category, price, old_price, image, description, is_featured) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [name, category, price, old_price, image, description, is_featured],
    });
    res.redirect('/admin/products');
  } catch (err) { next(err); }
});

app.get('/admin/products/edit/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [req.params.id] });
    if (!result.rows.length) return res.status(404).send('Product not found');
    res.render('admin/products-edit', { product: result.rows[0], error: null });
  } catch (err) { next(err); }
});

app.post('/admin/products/edit/:id', requireAdmin, upload.single('image'), async (req, res, next) => {
  try {
    const name = cleanText(req.body.name);
    const category = cleanText(req.body.category);
    const price = parseMoney(req.body.price);
    const old_price = parseMoney(req.body.old_price, price);
    const description = cleanText(req.body.description);
    const is_featured = req.body.is_featured ? 1 : 0;
    if (!name || !category) return res.status(400).send('Product name and category are required.');
    if (req.file) {
      await db.execute({ sql: 'UPDATE products SET name=?, category=?, price=?, old_price=?, image=?, description=?, is_featured=? WHERE id=?', args: [name, category, price, old_price, fileToDataUrl(req.file), description, is_featured, req.params.id] });
    } else {
      await db.execute({ sql: 'UPDATE products SET name=?, category=?, price=?, old_price=?, description=?, is_featured=? WHERE id=?', args: [name, category, price, old_price, description, is_featured, req.params.id] });
    }
    res.redirect('/admin/products');
  } catch (err) { next(err); }
});

app.post('/admin/products/delete/:id', requireAdmin, async (req, res, next) => {
  try {
    await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [req.params.id] });
    res.redirect('/admin/products');
  } catch (err) { next(err); }
});

app.get('/admin/orders', requireAdmin, async (req, res, next) => {
  try {
    const orders = await db.execute('SELECT * FROM orders ORDER BY id DESC');
    res.render('admin/orders', { orders: orders.rows });
  } catch (err) { next(err); }
});

app.post('/admin/orders/status/:id', requireAdmin, async (req, res, next) => {
  try {
    const allowed = ['Pending', 'Processing', 'Completed', 'Cancelled'];
    const status = cleanText(req.body.status);
    if (!allowed.includes(status)) return res.status(400).send('Invalid order status.');
    await db.execute({ sql: 'UPDATE orders SET status = ? WHERE id = ?', args: [status, req.params.id] });
    res.redirect('/admin/orders');
  } catch (err) { next(err); }
});

app.get('/admin/settings', requireAdmin, async (req, res, next) => {
  try { res.render('admin/settings', { message: null, error: null }); }
  catch (err) { next(err); }
});

app.post('/admin/settings', requireAdmin, upload.single('store_logo_file'), async (req, res, next) => {
  try {
    const updates = [
      ['store_name', cleanText(req.body.store_name, 'Royal Silk & Saree')],
      ['theme_color', cleanText(req.body.theme_color, '#800020')],
      ['delivery_time', cleanText(req.body.delivery_time)],
      ['store_info', cleanText(req.body.store_info)],
      ['chat_order_prompt', cleanText(req.body.chat_order_prompt)],
    ];
    for (const [key, value] of updates) {
      await db.execute({ sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', args: [key, value] });
    }
    if (req.file) {
      await db.execute({ sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', args: ['store_logo', fileToDataUrl(req.file)] });
    }
    if (typeof req.body.new_password === 'string' && req.body.new_password.trim()) {
      if (req.body.new_password.trim().length < 8) return res.status(400).render('admin/settings', { message: null, error: 'New password must be at least 8 characters.' });
      const hashed = await bcrypt.hash(req.body.new_password.trim(), 12);
      await db.execute({ sql: 'UPDATE admin SET password = ? WHERE id = ?', args: [hashed, req.session.admin.id] });
    }
    res.render('admin/settings', { message: 'Settings successfully updated!', error: null });
  } catch (err) { next(err); }
});

app.get('/admin/password', requireAdmin, (req, res) => res.render('admin/password', { message: null, error: null }));

app.post('/admin/password', requireAdmin, async (req, res, next) => {
  try {
    const newPassword = typeof req.body.new_password === 'string' ? req.body.new_password.trim() : '';
    if (newPassword.length < 8) return res.status(400).render('admin/password', { message: null, error: 'Password must be at least 8 characters.' });
    const hashed = await bcrypt.hash(newPassword, 12);
    await db.execute({ sql: 'UPDATE admin SET password = ? WHERE id = ?', args: [hashed, req.session.admin.id] });
    res.render('admin/password', { message: 'Password updated successfully. Your new password is now active.', error: null });
  } catch (err) { next(err); }
});

// AI Shopping Agent endpoint. This is a database-backed store agent: it can
// understand common shopping questions, search the live catalog, explain delivery/store info,
// and track an order without requiring an external AI API key.
app.post('/api/agent/chat', async (req, res, next) => {
  try {
    const message = cleanText(req.body.message);
    if (!message) return res.status(400).json({ success: false, message: 'Please type a message.' });

    const q = message.toLowerCase();
    const settings = await getSettings();
    const products = await db.execute('SELECT id, name, category, price, old_price, image, description, is_featured FROM products ORDER BY id DESC');

    const money = value => `৳${Number(value || 0).toLocaleString('en-BD', { maximumFractionDigits: 2 })}`;
    const catalog = products.rows;
    let reply = '';
    let matches = [];

    // Order tracking: accept "track SAR-123456" or any SAR order id.
    const orderMatch = message.match(/\bSAR[- ]?\d{5,8}\b/i);
    if (orderMatch || /track|order status|where.*order|অর্ডার.*স্ট্যাটাস|অর্ডার.*কোথায়/i.test(q)) {
      const id = orderMatch ? orderMatch[0].replace(' ', '-').toUpperCase() : '';
      if (id) {
        const order = await db.execute({ sql: 'SELECT order_id, total, status, created_at FROM orders WHERE order_id = ? LIMIT 1', args: [id] });
        if (order.rows.length) {
          const o = order.rows[0];
          reply = `Order ${o.order_id} is currently <strong>${o.status}</strong>. Total: ${money(o.total)}.`;
        } else {
          reply = `I could not find order <strong>${id}</strong>. Please check the order ID and try again.`;
        }
      } else {
        reply = 'Please send your order ID, for example <strong>SAR-123456</strong>, and I will check its status.';
      }
    } else if (/delivery|shipping|কুরিয়ার|ডেলিভারি|কতদিন|কয়দিন/i.test(q)) {
      reply = settings.delivery_time || 'Please contact us for delivery information.';
    } else if (/about|store|কি বিক্রি|what.*sell|product.*type|saree|শাড়ি|সাড়ি|ক্যাটাগরি|category/i.test(q) && catalog.length === 0) {
      reply = settings.store_info || 'Our saree catalog is currently empty.';
    } else if (/price|budget|under|below|দাম|টাকা|বাজেট/i.test(q)) {
      const nums = (message.match(/\d[\d,]*/g) || []).map(v => Number(v.replace(/,/g, ''))).filter(n => Number.isFinite(n));
      const max = nums.length ? Math.max(...nums) : Infinity;
      matches = catalog.filter(p => Number(p.price) <= max).slice(0, 6);
      if (matches.length) {
        reply = `I found ${matches.length} saree${matches.length > 1 ? 's' : ''}${Number.isFinite(max) ? ` within ${money(max)}` : ''}.`;
      } else {
        reply = 'I could not find a saree matching that budget. Tell me your preferred budget and category, and I will search again.';
      }
    } else if (/jamdani|katan|banarasi|georgette|silk|cotton|tangail|muslin|জামদানি|কাতান|বেনারসি|জর্জেট|সিল্ক|কটন/i.test(q)) {
      matches = catalog.filter(p => `${p.name} ${p.category} ${p.description || ''}`.toLowerCase().includes(q)).slice(0, 6);
      // If the full sentence did not match, match any known category/name keyword.
      if (!matches.length) {
        const terms = q.split(/[^a-z0-9\u0980-\u09ff]+/).filter(Boolean);
        matches = catalog.filter(p => terms.some(t => `${p.name} ${p.category} ${p.description || ''}`.toLowerCase().includes(t))).slice(0, 6);
      }
      reply = matches.length ? `I found ${matches.length} matching option${matches.length > 1 ? 's' : ''} from our live catalog.` : 'I could not find an exact match. Try another saree type or ask me for recommendations.';
    } else if (/recommend|suggest|best|popular|featured|ভালো|সাজেস্ট|পছন্দ/i.test(q)) {
      matches = catalog.filter(p => Number(p.is_featured) === 1).slice(0, 6);
      if (!matches.length) matches = catalog.slice(0, 6);
      reply = matches.length ? 'Here are some sarees I recommend from our current catalog.' : 'There are no products in the catalog yet.';
    } else if (/order|buy|purchase|কিনতে|অর্ডার/i.test(q)) {
      reply = settings.chat_order_prompt || 'Please provide your name, phone number, delivery address, and product name. You can also add a product to cart and checkout.';
    } else if (/hello|hi|hey|হাই|আসসালামু|salam/i.test(q)) {
      reply = `Hello! I am your <strong>${settings.store_name || 'Saree'} Shopping Agent</strong>. Ask me about sarees, prices, delivery, recommendations, or order tracking.`;
    } else {
      // General live catalog search.
      const terms = q.split(/[^a-z0-9\u0980-\u09ff]+/).filter(t => t.length >= 2);
      matches = catalog.filter(p => {
        const hay = `${p.name} ${p.category} ${p.description || ''}`.toLowerCase();
        return terms.some(t => hay.includes(t));
      }).slice(0, 6);
      reply = matches.length
        ? `I found ${matches.length} product${matches.length > 1 ? 's' : ''} related to your request.`
        : 'I can help you find sarees, compare prices, recommend products, explain delivery, or track an order. Tell me what you need.';
    }

    res.json({
      success: true,
      reply,
      products: matches,
      agent: 'saree-shopping-agent'
    });
  } catch (err) { next(err); }
});

// AI Assistant catalog matching endpoint. The uploaded image is accepted for now;
// matching remains catalog-based because no external vision API credentials were supplied.
app.post('/api/ai/match', upload.single('customer_image'), async (req, res, next) => {
  try {
    const products = await db.execute('SELECT id, name, price, image, category FROM products ORDER BY id DESC LIMIT 3');
    res.json({ success: true, matched_products: products.rows, message: 'Here are some similar sarees from our catalog.' });
  } catch (err) { next(err); }
});

// Multer/file and general error handler.
app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError || err.message === 'Only image files are allowed.') {
    return res.status(400).send(err.message || 'Image upload failed.');
  }
  res.status(500).send('Something went wrong on the server. Please try again.');
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch(err => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
