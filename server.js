const express = require('express');
const session = require('express-session');
const { createClient } = require('@libsql/client');
const multer = require('multer');
const path = require('path');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Turso Database Connection
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

app.use(session({
  secret: process.env.SESSION_SECRET || 'saree-secret-key',
  resave: false,
  saveUninitialized: false,
}));

// Multer Setup for Image Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Initialize Database Tables
async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      category TEXT,
      price REAL,
      old_price REAL,
      image TEXT,
      description TEXT,
      is_featured INTEGER DEFAULT 0
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT UNIQUE,
      customer_name TEXT,
      phone TEXT,
      address TEXT,
      total REAL,
      payment_method TEXT,
      trx_id TEXT,
      status TEXT DEFAULT 'Pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Default Settings Seed
  const defaultSettings = [
    ['store_name', 'Royal Silk & Saree'],
    ['store_logo', '/uploads/default-logo.png'],
    ['theme_color', '#800020'],
    ['delivery_time', 'Inside Dhaka: 2-3 Days, Outside Dhaka: 3-5 Days'],
    ['store_info', 'We sell 100% pure Katan, Jamdani, Banarasi, and Georgette sarees directly from weavers.'],
    ['chat_order_prompt', 'To place an order via chat, please provide your Name, Phone Number, Delivery Address, and the Product Name.']
  ];

  for (const [k, v] of defaultSettings) {
    const res = await db.execute({ sql: 'SELECT * FROM settings WHERE key = ?', args: [k] });
    if (res.rows.length === 0) {
      await db.execute({ sql: 'INSERT INTO settings (key, value) VALUES (?, ?)', args: [k, v] });
    }
  }

  // Default Admin Check
  const adminRes = await db.execute('SELECT * FROM products LIMIT 1'); // Just checking schema readiness
  const checkAdmin = await db.execute('SELECT * FROM admin WHERE username = ?', ['admin']);
  if (checkAdmin.rows.length === 0) {
    const hashed = await bcrypt.hash(process.env.ADMIN_SECRET_FALLBACK_PASSWORD || 'admin123', 10);
    await db.execute({ sql: 'INSERT INTO admin (username, password) VALUES (?, ?)', args: ['admin', hashed] });
  }
}

initDb().catch(console.error);

// Global Settings Middleware
app.use(async (req, res, next) => {
  try {
    const result = await db.execute('SELECT * FROM settings');
    const settings = {};
    result.rows.forEach(row => {
      settings[row.key] = row.value;
    });
    res.locals.settings = settings;
    res.locals.admin = req.session.admin || null;
    res.locals.cartCount = req.session.cart ? req.session.cart.reduce((acc, item) => acc + item.qty, 0) : 0;
  } catch (err) {
    res.locals.settings = {};
    res.locals.admin = null;
    res.locals.cartCount = 0;
  }
  next();
});

// --- Frontend Routes ---

app.get('/', async (req, res) => {
  const featured = await db.execute('SELECT * FROM products WHERE is_featured = 1 LIMIT 8');
  const allProducts = await db.execute('SELECT * FROM products ORDER BY id DESC LIMIT 8');
  res.render('index', { featured: featured.rows, products: allProducts.rows });
});

app.get('/shop', async (req, res) => {
  const { category, search } = req.query;
  let query = 'SELECT * FROM products WHERE 1=1';
  let args = [];

  if (category && category !== 'All') {
    query += ' AND category = ?';
    args.push(category);
  }
  if (search) {
    query += ' AND (name LIKE ? OR description LIKE ?)';
    args.push(`%${search}%`, `%${search}%`);
  }

  const result = await db.execute({ sql: query, args });
  const categoriesRes = await db.execute('SELECT DISTINCT category FROM products');
  res.render('shop', { products: result.rows, categories: categoriesRes.rows, currentCategory: category || 'All', search: search || '' });
});

app.get('/product/:id', async (req, res) => {
  const product = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [req.params.id] });
  if (product.rows.length === 0) return res.status(404).send('Product not found');
  const related = await db.execute({ sql: 'SELECT * FROM products WHERE category = ? AND id != ? LIMIT 4', args: [product.rows[0].category, req.params.id] });
  res.render('product', { product: product.rows[0], related: related.rows });
});

app.post('/cart/add', (req, res) => {
  const { id, name, price, image } = req.body;
  if (!req.session.cart) req.session.cart = [];
  const existing = req.session.cart.find(item => item.id == id);
  if (existing) {
    existing.qty += 1;
  } else {
    req.session.cart.push({ id, name, price: parseFloat(price), image, qty: 1 });
  }
  res.redirect('/cart');
});

app.get('/cart', (req, res) => {
  res.render('cart', { cart: req.session.cart || [] });
});

app.post('/cart/update', (req, res) => {
  const { id, qty } = req.body;
  if (req.session.cart) {
    req.session.cart = req.session.cart.map(item => {
      if (item.id == id) item.qty = parseInt(qty);
      return item;
    }).filter(item => item.qty > 0);
  }
  res.redirect('/cart');
});

app.get('/checkout', (req, res) => {
  if (!req.session.cart || req.session.cart.length === 0) return res.redirect('/cart');
  const total = req.session.cart.reduce((sum, i) => sum + (i.price * i.qty), 0);
  res.render('checkout', { cart: req.session.cart, total });
});

app.post('/order/place', async (req, res) => {
  const { customer_name, phone, address, payment_method, trx_id } = req.body;
  const cart = req.session.cart || [];
  if (cart.length === 0) return res.redirect('/cart');

  const total = cart.reduce((sum, i) => sum + (i.price * i.qty), 0);
  const orderIdNum = Math.floor(100000 + Math.random() * 900000);
  const order_id = `SAR-${orderIdNum}`;

  await db.execute({
    sql: 'INSERT INTO orders (order_id, customer_name, phone, address, total, payment_method, trx_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [order_id, customer_name, phone, address, total, payment_method, trx_id || 'COD']
  });

  req.session.cart = [];
  res.render('tracking', { order: { order_id, customer_name, phone, address, total, payment_method, trx_id, status: 'Pending' }, success: true });
});

app.get('/track', async (req, res) => {
  const { order_id } = req.query;
  let order = null;
  if (order_id) {
    const result = await db.execute({ sql: 'SELECT * FROM orders WHERE order_id = ?', args: [order_id] });
    order = result.rows[0] || null;
  }
  res.render('tracking', { order, success: false });
});


// --- Admin Routes ---
const requireAdmin = (req, res, next) => {
    if (!req.session || !req.session.admin) {
        return res.redirect('/admin/login');
    }
    next();
};

app.get('/admin/password', requireAdmin, (req, res) => {
    res.render('admin/password', { message: null });
});

app.post('/admin/password', requireAdmin, async (req, res) => {
    try {
        const { new_password } = req.body;
        if (new_password && new_password.trim() !== '') {
            const hashedPassword = await bcrypt.hash(new_password, 10);
            await db.execute({
                sql: 'UPDATE admin SET password = ? WHERE id = 1',
                args: [hashedPassword]
            });
        }
        res.render('admin/password', { message: 'Password updated successfully!' });
    } catch (err) {
        console.error(err);
        res.render('admin/password', { message: 'Failed to update password' });
    }
});

app.get('/admin/login', (req, res) => {
  res.render('admin/login', { error: null });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await db.execute({ sql: 'SELECT * FROM admin WHERE username = ?', args: [username] });
    if (result.rows.length > 0) {
      const match = await bcrypt.compare(password, result.rows[0].password);
      if (match) {
        req.session.admin = { username };
        return res.redirect('/admin/dashboard');
      }
    }
    res.render('admin/login', { error: 'Invalid username or password' });
  } catch (err) {
    res.render('admin/login', { error: 'Database error during login' });
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.admin = null;
  res.redirect('/admin/login');
const requireAdmin = (req, res, next) => {
    if (!req.session || !req.session.admin) {
        return res.redirect('/admin/login');
    }
    next();
};

app.get('/admin/password', requireAdmin, (req, res) => {
    res.render('admin/password', { message: null });
});

app.post('/admin/password', requireAdmin, async (req, res) => {
    try {
        const { new_password } = req.body;
        if (new_password && new_password.trim() !== '') {
            const hashedPassword = await bcrypt.hash(new_password, 10);
            await db.execute({
                sql: 'UPDATE admin SET password = ? WHERE id = 1',
                args: [hashedPassword]
            });
        }
        res.render('admin/password', { message: 'Password updated successfully!' });
    } catch (err) {
        console.error(err);
        res.render('admin/password', { message: 'Failed to update password' });
    }
});

});

app.get('/admin/settings', requireAdmin, async (req, res) => {
    try {
        const result = await db.execute('SELECT * FROM settings LIMIT 1');
        const settings = result.rows[0] || {};
        res.render('admin/settings', { settings, message: null });
    } catch (err) {
        console.error(err);
        res.render('admin/settings', { settings: {}, message: 'Error loading settings' });
    }
});

app.post('/admin/settings', requireAdmin, upload.single('store_logo_file'), async (req, res) => {
    try {
        const { store_name, theme_color, delivery_time, store_info, chat_order_prompt, new_password } = req.body;
        
        const current = await db.execute('SELECT * FROM settings LIMIT 1');
        let logoPath = current.rows[0] ? current.rows[0].store_logo : '/uploads/default-logo.png';
        
        if (req.file) {
            logoPath = `/uploads/${req.file.filename}`;
        }

        if (new_password && new_password.trim() !== '') {
            const hashedPassword = await bcrypt.hash(new_password, 10);
            await db.execute({
                sql: 'UPDATE admin SET password = ? WHERE id = 1',
                args: [hashedPassword]
            });
        }

        await db.execute({
            sql: 'UPDATE settings SET store_name = ?, store_logo = ?, theme_color = ?, delivery_time = ?, store_info = ?, chat_order_prompt = ? WHERE id = 1',
            args: [store_name, logoPath, theme_color, delivery_time, store_info, chat_order_prompt]
        });

        const updatedResult = await db.execute('SELECT * FROM settings LIMIT 1');
        res.render('admin/settings', { settings: updatedResult.rows[0] || {}, message: 'Settings updated successfully!' });
    } catch (err) {
        console.error(err);
        const currentResult = await db.execute('SELECT * FROM settings LIMIT 1').catch(() => ({ rows: [{}] }));
        res.render('admin/settings', { settings: currentResult.rows[0] || {}, message: 'Failed to update settings' });
    }
});

          

app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  const revenueRes = await db.execute('SELECT SUM(total) as rev FROM orders');
  const ordersCount = await db.execute('SELECT COUNT(*) as cnt FROM orders');
  const productsCount = await db.execute('SELECT COUNT(*) as cnt FROM products');
  const recentOrders = await db.execute('SELECT * FROM orders ORDER BY id DESC LIMIT 5');

  res.render('admin/dashboard', {
    revenue: revenueRes.rows[0].rev || 0,
    ordersCount: ordersCount.rows[0].cnt || 0,
    productsCount: productsCount.rows[0].cnt || 0,
    recentOrders: recentOrders.rows
  });
});

app.get('/admin/products', requireAdmin, async (req, res) => {
  const products = await db.execute('SELECT * FROM products ORDER BY id DESC');
  res.render('admin/products', { products: products.rows });
});

app.post('/admin/products/add', requireAdmin, upload.single('image'), async (req, res) => {
  const { name, category, price, old_price, description, is_featured } = req.body;
  const image = req.file ? `/uploads/${req.file.filename}` : '/uploads/default-saree.jpg';
  await db.execute({
    sql: 'INSERT INTO products (name, category, price, old_price, image, description, is_featured) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [name, category, price, old_price || price, image, description, is_featured ? 1 : 0]
  });
  res.redirect('/admin/products');
});

app.post('/admin/products/delete/:id', requireAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [req.params.id] });
  res.redirect('/admin/products');
});

app.get('/admin/orders', requireAdmin, async (req, res) => {
  const orders = await db.execute('SELECT * FROM orders ORDER BY id DESC');
  res.render('admin/orders', { orders: orders.rows });
});

app.post('/admin/orders/status/:id', requireAdmin, async (req, res) => {
  const { status } = req.body;
  await db.execute({ sql: 'UPDATE orders SET status = ? WHERE id = ?', args: [status, req.params.id] });
  res.redirect('/admin/orders');
});

app.get('/admin/settings', requireAdmin, async (req, res) => {
  res.render('admin/settings', { message: null });
});

app.post('/admin/settings', requireAdmin, upload.single('store_logo_file'), async (req, res) => {
  const { store_name, theme_color, delivery_time, store_info, chat_order_prompt, new_password } = req.body;
  
  if (req.file) {
    const logoPath = `/uploads/${req.file.filename}`;
    await db.execute({ sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', args: ['store_logo', logoPath] });
  }

  const updates = [
    ['store_name', store_name],
    ['theme_color', theme_color],
    ['delivery_time', delivery_time],
    ['store_info', store_info],
    ['chat_order_prompt', chat_order_prompt]
  ];

  for (const [k, v] of updates) {
    await db.execute({ sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', args: [k, v] });
  }

  if (new_password && new_password.trim() !== '') {
    const hashed = await bcrypt.hash(new_password, 10);
    await db.execute({ sql: 'UPDATE admin SET password = ? WHERE username = ?', args: [hashed, 'admin'] });
  }

  res.render('admin/settings', { message: 'Settings successfully updated!' });
});

// AI Assistant Endpoint for image match / info
app.post('/api/ai/match', upload.single('customer_image'), async (req, res) => {
  // Simulated AI Vision catalog matching or info lookup
  const products = await db.execute('SELECT * FROM products LIMIT 3');
  res.json({
    success: true,
    matched_products: products.rows,
    message: 'AI matched similar design from our catalog successfully!'
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
