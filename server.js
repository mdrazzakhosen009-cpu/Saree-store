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
        await db.execute(`CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            store_name TEXT, 
            store_logo TEXT, 
            theme_color TEXT, 
            delivery_time TEXT, 
            chat_order_prompt TEXT, 
            bkash_num TEXT,
            bkash_number TEXT,
            bkash_type TEXT,
            nagad_number TEXT,
            nagad_type TEXT,
            rocket_number TEXT,
            rocket_type TEXT,
            store_info TEXT
        )`);
        
        await db.execute(`CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            name TEXT, 
            category TEXT, 
            price REAL, 
            old_price REAL, 
            image TEXT, 
            description TEXT, 
            is_featured INTEGER DEFAULT 0
        )`);

        await db.execute(`CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            customer_name TEXT, 
            phone TEXT, 
            address TEXT, 
            total REAL, 
            status TEXT DEFAULT 'Pending', 
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        await db.execute(`CREATE TABLE IF NOT EXISTS admin (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT,
            password TEXT
        )`);

        const columns = [
            "is_featured INTEGER DEFAULT 0",
            "chat_order_prompt TEXT",
            "bkash_num TEXT",
            "bkash_number TEXT",
            "bkash_type TEXT",
            "nagad_number TEXT",
            "nagad_type TEXT",
            "rocket_number TEXT",
            "rocket_type TEXT",
            "delivery_time TEXT",
            "theme_color TEXT",
            "store_info TEXT",
            "store_logo TEXT",
            "store_name TEXT"
        ];

        for (let col of columns) {
            try { await db.execute(`ALTER TABLE settings ADD COLUMN ${col}`); } catch (e) {}
            try { await db.execute(`ALTER TABLE products ADD COLUMN ${col}`); } catch (e) {}
        }

        const checkSettings = await db.execute('SELECT COUNT(*) as cnt FROM settings');
        if (checkSettings.rows[0].cnt === 0) {
            await db.execute({
                sql: 'INSERT INTO settings (store_name, store_logo, theme_color, delivery_time, chat_order_prompt, bkash_num) VALUES (?, ?, ?, ?, ?, ?)',
                args: ['Saree Store', '/uploads/default-logo.png', '#800020', '2-3 Days', 'I want to order this product', '01700000000']
            });
        }

        const checkAdmin = await db.execute('SELECT COUNT(*) as cnt FROM admin');
        if (checkAdmin.rows[0].cnt === 0) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            await db.execute({
                sql: 'INSERT INTO admin (username, password) VALUES (?, ?)',
                args: ['admin', hashedPassword]
            });
        }
    } catch (e) { 
        console.error('DB Init Error:', e); 
    }
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
    } catch (err) { 
        res.render('admin/login', { error: 'Login error' }); 
    }
});

app.get('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/admin/login')));

app.get('/admin/dashboard', requireAdmin, async (req, res) => {
    try {
        const rev = await db.execute('SELECT SUM(total) as rev FROM orders');
        const orders = await db.execute('SELECT COUNT(*) as cnt FROM orders');
        const products = await db.execute('SELECT COUNT(*) as cnt FROM products');
        const recent = await db.execute('SELECT * FROM orders ORDER BY id DESC LIMIT 5');
        res.render('admin/dashboard', { revenue: rev.rows[0].rev || 0, ordersCount: orders.rows[0].cnt || 0, productsCount: products.rows[0].cnt || 0, recentOrders: recent.rows || [] });
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

app.get('/admin/products', requireAdmin, async (req, res) => {
    try {
        const products = await db.execute('SELECT * FROM products ORDER BY id DESC');
        res.render('admin/products', { products: products.rows || [] });
    } catch (err) {
        res.status(500).send('Server Error');
    }
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
    try {
        await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [req.params.id] });
        res.redirect('/admin/products');
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

app.get('/admin/orders', requireAdmin, async (req, res) => {
    try {
        const orders = await db.execute('SELECT * FROM orders ORDER BY id DESC');
        res.render('admin/orders', { orders: orders.rows || [] });
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

app.post('/admin/orders/status/:id', requireAdmin, async (req, res) => {
    try {
        await db.execute({ sql: 'UPDATE orders SET status = ? WHERE id = ?', args: [req.body.status, req.params.id] });
        res.redirect('/admin/orders');
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

app.get('/admin/settings', requireAdmin, async (req, res) => {
    try {
        const settings = await db.execute('SELECT * FROM settings LIMIT 1');
        res.render('admin/settings', { settings: settings.rows[0] || {}, message: null });
    } catch (err) {
        res.status(500).send('Server Error');
    }
});

app.post('/admin/settings', requireAdmin, upload.single('store_logo'), async (req, res) => {
    try {
        const { store_name, theme_color, delivery_time, chat_order_prompt, bkash_num } = req.body;
        const current = await db.execute('SELECT * FROM settings LIMIT 1');
        let logoPath = req.file ? `/uploads/${req.file.filename}` : (current.rows[0]?.store_logo || '/uploads/default-logo.png');

        await db.execute({
            sql: 'UPDATE settings SET store_name = ?, store_logo = ?, theme_color = ?, delivery_time = ?, chat_order_prompt = ?, bkash_num = ? WHERE id = 1',
            args: [store_name, logoPath, theme_color, delivery_time, chat_order_prompt, bkash_num]
        });
        
        const settings = await db.execute('SELECT * FROM settings LIMIT 1');
        res.render('admin/settings', { settings: settings.rows[0] || {}, message: 'Settings updated successfully!' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error: ' + err.message);
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
                             
