const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;

let db;
try {
  db = createClient({
    url: process.env.TURSO_DATABASE_URL || 'file:local.db',
    authToken: process.env.TURSO_AUTH_TOKEN || '',
  });
} catch (err) {
  console.error('Database error:', err);
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'saree_store_secret',
  resave: false,
  saveUninitialized: false,
}));
app.use(async (req, res, next) => {
    try {
        let cart = req.session.cart || [];
        res.locals.cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
        
        const settingsResult = await db.execute('SELECT * FROM settings LIMIT 1');
        res.locals.settings = settingsResult.rows[0] || {};
    } catch (err) {
        res.locals.cartCount = 0;
        res.locals.settings = {};
    }
    next();
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

const requireAdmin = (req, res, next) => {
    if (!req.session || !req.session.admin) return res.redirect('/admin/login');
    next();
};

async function initDB() {
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY AUTOINCREMENT, store_name TEXT, store_logo TEXT, theme_color TEXT, delivery_time TEXT, store_info TEXT, chat_order_prompt TEXT, bkash_number TEXT, bkash_type TEXT, nagad_number TEXT, nagad_type TEXT, rocket_number TEXT, rocket_type TEXT)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, category TEXT, price REAL, old_price REAL, image TEXT, description TEXT, is_featured INTEGER)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT, customer_name TEXT, phone TEXT, address TEXT, total REAL, status TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    
    const check = await db.execute('SELECT COUNT(*) as cnt FROM settings');
    if (check.rows[0].cnt === 0) {
      await db.execute({
        sql: `INSERT INTO settings (store_name, store_logo, theme_color, delivery_time, store_info, chat_order_prompt, bkash_number, bkash_type, nagad_number, nagad_type, rocket_number, rocket_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ['Saree Store', '/uploads/default-logo.png', '#800020', '2-3 Days', 'Premium Quality', 'Order via chat', '01700000000', 'Personal', '01700000000', 'Personal', '01700000000', 'Personal']
      });
    }
  } catch (e) { console.error(e); }
}
initDB();

app.get('/', async (req, res) => {
    try {
        const productsResult = await db.execute('SELECT * FROM products ORDER BY id DESC LIMIT 8');
        res.render('index', { featured: productsResult.rows || [] });
    } catch (err) {
        console.error(err);
        res.render('index', { featured: [] });
    }
});

app.get('/admin/login', (req, res) => res.render('admin/login', { error: null }));
app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await db.execute({ sql: 'SELECT * FROM admin WHERE username = ?', args: [username] });
    if (result.rows.length > 0 && await bcrypt.compare(password, result.rows[0].password)) {
      req.session.admin = { username };
      return res.redirect('/admin/dashboard');
    }
    res.render('admin/login', { error: 'Invalid credentials' });
  } catch (err) { res.render('admin/login', { error: 'Login error' }); }
});

app.get('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/admin/login')));

app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  const rev = await db.execute('SELECT SUM(total) as rev FROM orders');
  const orders = await db.execute('SELECT COUNT(*) as cnt FROM orders');
  const products = await db.execute('SELECT COUNT(*) as cnt FROM products');
  const recent = await db.execute('SELECT * FROM orders ORDER BY id DESC LIMIT 5');
  res.render('admin/dashboard', { revenue: rev.rows[0]?.rev || 0, ordersCount: orders.rows[0]?.cnt || 0, productsCount: products.rows[0]?.cnt || 0, recentOrders: recent.rows || [] });
});

app.get('/admin/products', requireAdmin, async (req, res) => {
  const products = await db.execute('SELECT * FROM products ORDER BY id DESC');
  res.render('admin/products', { products: products.rows || [] });
});

app.post('/admin/products/add', requireAdmin, upload.single('image'), async (req, res) => {

    try {
        const { name, category, price, old_price, description, is_featured } = req.body;
        const image = req.file ? `/uploads/${req.file.filename}` : '/uploads/default.jpg';
        const featuredValue = is_featured ? 1 : 0;
        
        await db.execute({
            sql: 'INSERT INTO products (name, category, price, old_price, image, description, is_featured) VALUES (?, ?, ?, ?, ?, ?, ?)',
            args: [name, category, parseFloat(price) || 0, parseFloat(old_price) || 0, image, description || '', featuredValue]
        });
        res.redirect('/admin/products');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error: ' + err.message);
    }
});


app.post('/admin/products/delete/:id', requireAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [req.params.id] });
  res.redirect('/admin/products');
});

app.get('/admin/orders', requireAdmin, async (req, res) => {
  const orders = await db.execute('SELECT * FROM orders ORDER BY id DESC');
  res.render('admin/orders', { orders: orders.rows || [] });
});

app.post('/admin/orders/status/:id', requireAdmin, async (req, res) => {
  await db.execute({ sql: 'UPDATE orders SET status = ? WHERE id = ?', args: [req.body.status, req.params.id] });
  res.redirect('/admin/orders');
});

app.get('/admin/settings', requireAdmin, async (req, res) => {
  const settings = await db.execute('SELECT * FROM settings LIMIT 1');
  res.render('admin/settings', { settings: settings.rows[0] || {}, message: null });
});

app.post('/admin/settings', requireAdmin, upload.single('store_logo'), async (req, res) => {
  const { store_name, theme_color, delivery_time, store_info, chat_order_prompt, bkash_number, bkash_type, nagad_number, nagad_type, rocket_number, rocket_type } = req.body;
  const current = await db.execute('SELECT * FROM settings LIMIT 1');
  let logoPath = req.file ? `/uploads/${req.file.filename}` : (current.rows[0]?.store_logo || '');
  
  await db.execute({
    sql: `UPDATE settings SET store_name = ?, store_logo = ?, theme_color = ?, delivery_time = ?, store_info = ?, chat_order_prompt = ?, bkash_number = ?, bkash_type = ?, nagad_number = ?, nagad_type = ?, rocket_number = ?, rocket_type = ? WHERE id = 1`,
    args: [store_name, logoPath, theme_color, delivery_time, store_info, chat_order_prompt, bkash_number, bkash_type, nagad_number, nagad_type, rocket_number, rocket_type]
  });
  const updated = await db.execute('SELECT * FROM settings LIMIT 1');
  res.render('admin/settings', { settings: updated.rows[0], message: 'Updated successfully!' });
});

app.get('/admin/password', requireAdmin, (req, res) => res.render('admin/password', { message: null }));
app.post('/admin/password', requireAdmin, async (req, res) => {
  if (req.body.new_password) {
    const hashed = await bcrypt.hash(req.body.new_password, 10);
    await db.execute({ sql: 'UPDATE admin SET password = ? WHERE id = 1', args: [hashed] });
  }
  res.render('admin/password', { message: 'Password updated!' });
});

// AI Assistant & Designer Chatbot Routes
app.get('/admin/ai-assistant', requireAdmin, async (req, res) => {
    const settings = await db.execute('SELECT * FROM settings LIMIT 1');
    res.render('admin/ai-assistant', { responseMessage: null, generatedDesign: null, settings: settings.rows[0] || {} });
});

app.post('/admin/ai-assistant', requireAdmin, async (req, res) => {
    const instruction = (req.body.prompt_instruction || '').toLowerCase();
    let color = '#800020';
    let msg = "AI Custom instruction applied successfully.";
    
    if (instruction.includes('dark')) color = '#121212';
    else if (instruction.includes('gold')) color = '#D4AF37';
    else if (instruction.includes('blue')) color = '#1E3A8A';
    
    await db.execute({ sql: "UPDATE settings SET theme_color = ? WHERE id = 1", args: [color] });
    const settings = await db.execute('SELECT * FROM settings LIMIT 1');
    res.render('admin/ai-assistant', { responseMessage: msg, generatedDesign: `Applied Theme Color: ${color}`, settings: settings.rows[0] || {} });
});
// Separate Admin Feature Routes
app.get('/admin/ai-agent', requireAdmin, async (req, res) => {
    const settings = await db.execute('SELECT * FROM settings LIMIT 1');
    res.render('admin/ai-agent', { message: null, settings: settings.rows[0] || {} });
});

app.get('/admin/payment-settings', requireAdmin, async (req, res) => {
    const settings = await db.execute('SELECT * FROM settings LIMIT 1');
    res.render('admin/payment-settings', { message: null, settings: settings.rows[0] || {} });
});
app.post('/admin/payment-settings', requireAdmin, async (req, res) => {
    const { bkash_number, bkash_type, nagad_number, nagad_type, rocket_number, rocket_type } = req.body;
    await db.execute({
        sql: `UPDATE settings SET bkash_number = ?, bkash_type = ?, nagad_number = ?, nagad_type = ?, rocket_number = ?, rocket_type = ? WHERE id = 1`,
        args: [bkash_number, bkash_type, nagad_number, nagad_type, rocket_number, rocket_type]
    });
    const updated = await db.execute('SELECT * FROM settings LIMIT 1');
    res.render('admin/payment-settings', { message: 'Payment settings updated successfully!', settings: updated.rows[0] });
});

app.get('/admin/logo-design', requireAdmin, async (req, res) => {
    const settings = await db.execute('SELECT * FROM settings LIMIT 1');
    res.render('admin/logo-design', { message: null, settings: settings.rows[0] || {} });
});
app.post('/admin/logo-design', requireAdmin, upload.single('store_logo'), async (req, res) => {
    const { theme_color } = req.body;
    const current = await db.execute('SELECT * FROM settings LIMIT 1');
    let logoPath = req.file ? `/uploads/${req.file.filename}` : (current.rows[0]?.store_logo || '');
    await db.execute({
        sql: `UPDATE settings SET store_logo = ?, theme_color = ? WHERE id = 1`,
        args: [logoPath, theme_color]
    });
    const updated = await db.execute('SELECT * FROM settings LIMIT 1');
    res.render('admin/logo-design', { message: 'Logo & Design updated successfully!', settings: updated.rows[0] });
});

app.get('/admin/chatbot-settings', requireAdmin, async (req, res) => {
    const settings = await db.execute('SELECT * FROM settings LIMIT 1');
    res.render('admin/chatbot-settings', { message: null, settings: settings.rows[0] || {} });
});
app.post('/admin/chatbot-settings', requireAdmin, async (req, res) => {
    const { delivery_time, store_info, chat_order_prompt } = req.body;
    await db.execute({
        sql: `UPDATE settings SET delivery_time = ?, store_info = ?, chat_order_prompt = ? WHERE id = 1`,
        args: [delivery_time, store_info, chat_order_prompt]
    });
    const updated = await db.execute('SELECT * FROM settings LIMIT 1');
    res.render('admin/chatbot-settings', { message: 'Chatbot settings updated successfully!', settings: updated.rows[0] });
});

      
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
                    
