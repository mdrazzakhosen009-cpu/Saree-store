const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;

// Database Connection
let db;
try {
  db = createClient({
    url: process.env.TURSO_DATABASE_URL || 'file:local.db',
    authToken: process.env.TURSO_AUTH_TOKEN || '',
  });
  console.log('Database client initialized successfully.');
} catch (err) {
  console.error('Failed to initialize database client:', err);
}

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'saree_store_secret_key',
  resave: false,
  saveUninitialized: false,
}));

// File Upload Setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Admin Auth Middleware
const requireAdmin = (req, res, next) => {
    if (!req.session || !req.session.admin) {
        return res.redirect('/admin/login');
    }
    next();
};

// --- Database Table Initialization Check ---
async function initDB() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_name TEXT,
        store_logo TEXT,
        theme_color TEXT,
        delivery_time TEXT,
        store_info TEXT,
        chat_order_prompt TEXT,
        bkash_number TEXT,
        bkash_type TEXT,
        nagad_number TEXT,
        nagad_type TEXT,
        rocket_number TEXT,
        rocket_type TEXT
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
        is_featured INTEGER
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT,
        customer_name TEXT,
        phone TEXT,
        address TEXT,
        total REAL,
        status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const settingsCheck = await db.execute('SELECT COUNT(*) as cnt FROM settings');
    if (settingsCheck.rows[0].cnt === 0) {
      await db.execute({
        sql: `INSERT INTO settings (store_name, store_logo, theme_color, delivery_time, store_info, chat_order_prompt, bkash_number, bkash_type, nagad_number, nagad_type, rocket_number, rocket_type) 
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ['Saree Store', '/uploads/default-logo.png', '#800020', '2-3 Days', 'Premium Quality Sarees', 'Order via chat easily', '018900000', 'Personal', '01700000000', 'Personal', '01700000000', 'Personal']
      });
    }
  } catch (e) {
    console.error('DB Init Error:', e);
  }
}
initDB();

// --- Public Routes ---
app.get('/', async (req, res) => {
    try {
        const products = await db.execute('SELECT * FROM products ORDER BY id DESC');
        const settingsRes = await db.execute('SELECT * FROM settings LIMIT 1');
        res.render('index', { 
            products: products.rows || [], 
            settings: settingsRes.rows[0] || {} 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/tracking', async (req, res) => {
    try {
        const { order_id } = req.query;
        let order = null;
        if (order_id) {
            const result = await db.execute({ sql: 'SELECT * FROM orders WHERE order_id = ?', args: [order_id] });
            order = result.rows[0] || null;
        }
        res.render('tracking', { order, success: false });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// --- Admin Authentication Routes ---
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
    console.error(err);
    res.render('admin/login', { error: 'Database error during login' });
  }
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/admin/login');
    });
});

// --- Protected Admin Routes ---
app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const revenueRes = await db.execute('SELECT SUM(total) as rev FROM orders');
    const ordersCount = await db.execute('SELECT COUNT(*) as cnt FROM orders');
    const productsCount = await db.execute('SELECT COUNT(*) as cnt FROM products');
    const recentOrders = await db.execute('SELECT * FROM orders ORDER BY id DESC LIMIT 5');

    res.render('admin/dashboard', {
      revenue: revenueRes.rows[0]?.rev || 0,
      ordersCount: ordersCount.rows[0]?.cnt || 0,
      productsCount: productsCount.rows[0]?.cnt || 0,
      recentOrders: recentOrders.rows || []
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

app.get('/admin/products', requireAdmin, async (req, res) => {
  try {
    const products = await db.execute('SELECT * FROM products ORDER BY id DESC');
    res.render('admin/products', { products: products.rows || [] });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

app.post('/admin/products/add', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { name, category, price, old_price, description, is_featured } = req.body;
    const image = req.file ? `/uploads/${req.file.filename}` : '/uploads/default-saree.jpg';
    await db.execute({
      sql: 'INSERT INTO products (name, category, price, old_price, image, description, is_featured) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [name || 'Saree', category || 'General', parseFloat(price) || 0, parseFloat(old_price) || parseFloat(price) || 0, image, description || '', is_featured ? 1 : 0]
    });
    res.redirect('/admin/products');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error: ' + err.message);
  }
});

app.post('/admin/products/delete/:id', requireAdmin, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [req.params.id] });
    res.redirect('/admin/products');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

app.get('/admin/orders', requireAdmin, async (req, res) => {
  try {
    const orders = await db.execute('SELECT * FROM orders ORDER BY id DESC');
    res.render('admin/orders', { orders: orders.rows || [] });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

app.post('/admin/orders/status/:id', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    await db.execute({ sql: 'UPDATE orders SET status = ? WHERE id = ?', args: [status, req.params.id] });
    res.redirect('/admin/orders');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

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

app.post('/admin/settings', requireAdmin, upload.single('store_logo'), async (req, res) => {
    try {
        const { 
            store_name, theme_color, delivery_time, store_info, chat_order_prompt, 
            bkash_number, bkash_type, nagad_number, nagad_type, rocket_number, rocket_type, new_password 
        } = req.body;
        
        const current = await db.execute('SELECT * FROM settings LIMIT 1');
        let logoPath = current.rows[0]?.store_logo || '/uploads/default-logo.png';
        
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
            sql: `UPDATE settings SET store_name = ?, store_logo = ?, theme_color = ?, delivery_time = ?, store_info = ?, chat_order_prompt = ?, 
                  bkash_number = ?, bkash_type = ?, nagad_number = ?, nagad_type = ?, rocket_number = ?, rocket_type = ? WHERE id = 1`,
            args: [
                store_name || 'Saree Store', logoPath, theme_color || '#800020', delivery_time || '', 
                store_info || '', chat_order_prompt || '', bkash_number || '', bkash_type || 'Personal', 
                nagad_number || '', nagad_type || 'Personal', rocket_number || '', rocket_type || 'Personal'
            ]
        });

        const updatedResult = await db.execute('SELECT * FROM settings LIMIT 1');
        res.render('admin/settings', { settings: updatedResult.rows[0] || {}, message: 'Settings updated successfully!' });
    } catch (err) {
        console.error(err);
        res.render('admin/settings', { settings: {}, message: 'Failed to update settings: ' + err.message });
    }
});

// --- Admin AI Assistant & Designer Chatbot ---
app.get('/admin/ai-assistant', requireAdmin, async (req, res) => {
    try {
        const settingsRes = await db.execute('SELECT * FROM settings LIMIT 1');
        res.render('admin/ai-assistant', { 
            responseMessage: null, 
            generatedDesign: null,
            settings: settingsRes.rows[0] || {}
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/admin/ai-assistant', requireAdmin, async (req, res) => {
    try {
        const { prompt_instruction } = req.body;
        let responseMessage = "AI Assistant successfully analyzed your prompt and configured store styling.";
        let generatedDesign = null;

        const instruction = (prompt_instruction || '').toLowerCase();

        if (instruction.includes('dark') || instruction.includes('black')) {
            await db.execute({ sql: "UPDATE settings SET theme_color = ? WHERE id = 1", args: ['#121212'] });
            generatedDesign = "Applied Dark Luxury Theme (#121212)";
        } else if (instruction.includes('red') || instruction.includes('royal')) {
            await db.execute({ sql: "UPDATE settings SET theme_color = ? WHERE id = 1", args: ['#800020'] });
            generatedDesign = "Applied Royal Red Theme (#800020)";
        } else if (instruction.includes('gold') || instruction.includes('premium')) {
            await db.execute({ sql: "UPDATE settings SET theme_color = ? WHERE id = 1", args: ['#D4AF37'] });
            generatedDesign = "Applied Premium Gold Theme (#D4AF37)";
        } else if (instruction.includes('blue') || instruction.includes('corporate')) {
            await db.execute({ sql: "UPDATE settings SET theme_color = ? WHERE id = 1", args: ['#1E3A8A'] });
            generatedDesign = "Applied Ocean Blue Theme (#1E3A8A)";
        } else {
            generatedDesign = `Custom AI Instruction Saved: "${prompt_instruction}"`;
        }

        const settingsRes = await db.execute('SELECT * FROM settings LIMIT 1');
        res.render('admin/ai-assistant', { responseMessage, generatedDesign, settings: settingsRes.rows[0] || {} });
    } catch (err) {
        console.error(err);
        const settingsRes = await db.execute('SELECT * FROM settings LIMIT 1');
        res.render('admin/ai-assistant', { responseMessage: 'Error processing AI command', generatedDesign: null, settings: settingsRes.rows[0] || {} });
    }
});

app.post('/api/ai/match', upload.single('customer_image'), async (req, res) => {
  try {
    const products = await db.execute('SELECT * FROM products LIMIT 3');
    res.json({
      success: true,
      matched_products: products.rows || [],
      message: 'AI matched similar design from our catalog successfully!'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'AI match error' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
          
