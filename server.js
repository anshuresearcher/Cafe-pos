require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT || 3000);


// =====================================================
// MIDDLEWARE
// =====================================================

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname)));


// =====================================================
// POSTGRESQL
// =====================================================

const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    }
  : {
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT
    };

const pool = new Pool(poolConfig);
pool.on(
    "connect",
    () => console.log("✅ PostgreSQL connected")
);

pool.on(
    "error",
    e => console.error(
        "❌ PostgreSQL error:",
        e.message
    )
);

// =====================================================
// AUTHENTICATION / SESSION / PERMISSION HELPERS
// =====================================================

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

async function ensureSessionTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS app_sessions (
            token VARCHAR(128) PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_app_sessions_expires_at
        ON app_sessions(expires_at)
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_app_sessions_user_id
        ON app_sessions(user_id)
    `);
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
    return `${salt}:${hash}`;
}


async function ensureBusinessTable() {
    // Create the table first, then backfill any columns that may be missing
    // from an older/partially-created Phase 1 database.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS businesses (
            id SERIAL PRIMARY KEY,
            business_code VARCHAR(100) NOT NULL,
            business_name VARCHAR(200) NOT NULL,
            business_type VARCHAR(80) NOT NULL DEFAULT 'Cafe',
            owner_name VARCHAR(150),
            phone VARCHAR(40),
            email VARCHAR(180),
            address TEXT,
            city VARCHAR(100),
            state VARCHAR(100),
            gstin VARCHAR(40),
            logo_url TEXT,
            currency VARCHAR(10) NOT NULL DEFAULT '₹',
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const columnMigrations = [
        `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS business_code VARCHAR(100)`,
        `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS business_name VARCHAR(200)`,
        `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS business_type VARCHAR(80) DEFAULT 'Cafe'`,
        `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS owner_name VARCHAR(150)`,
        `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS phone VARCHAR(40)`,
        `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS email VARCHAR(180)`,
        `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address TEXT`,
        `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS city VARCHAR(100)`,
        `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS state VARCHAR(100)`,
        `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gstin VARCHAR(40)`,
        `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_url TEXT`,
        `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT '₹'`,
        `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`,
        `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
        `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
        // Some earlier Phase 1 experiments added authentication fields directly
        // to businesses. Keep the column for compatibility but do not require it;
        // authentication now belongs to app_users.
        `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS password_hash TEXT`
    ];
    for (const sql of columnMigrations) await pool.query(sql);

    // Compatibility migration for older business schemas: any legacy required
    // columns outside the current canonical business model must not block a new
    // registration. This specifically handles old fields such as password_hash.
    const canonicalColumns = new Set([
        'id','business_code','business_name','business_type','owner_name','phone',
        'email','address','city','state','gstin','logo_url','currency','active',
        'created_at','updated_at'
    ]);
    const legacyRequired = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='businesses'
          AND is_nullable='NO'
          AND column_default IS NULL
    `);
    for (const row of legacyRequired.rows) {
        if (canonicalColumns.has(row.column_name)) continue;
        const identifier = String(row.column_name).replace(/"/g, '""');
        await pool.query(`ALTER TABLE businesses ALTER COLUMN "${identifier}" DROP NOT NULL`);
    }

    // Older Phase 1 databases may already have a business_code column with no
    // default. Backfill blank codes before any new registration can occur.
    await pool.query(`
        UPDATE businesses
        SET business_code = 'CAFE-' || id::text
        WHERE business_code IS NULL OR BTRIM(business_code) = ''
    `);
    await pool.query(`ALTER TABLE businesses ALTER COLUMN business_code SET NOT NULL`);
    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_business_code
        ON businesses(business_code)
    `);

    // Existing installs may have been created before business_id existed.
    await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL`);

    const existing = await pool.query(`SELECT id FROM businesses ORDER BY id LIMIT 1`);
    let defaultBusinessId;
    if (!existing.rows.length) {
        const created = await pool.query(`
            INSERT INTO businesses (business_code, business_name, business_type, owner_name, currency)
            VALUES ($1,$2,'Cafe','Administrator','₹')
            RETURNING id
        `, ['CAFE-DEFAULT','My Cafe']);
        defaultBusinessId = created.rows[0].id;
    } else {
        defaultBusinessId = existing.rows[0].id;
    }

    await pool.query(`UPDATE businesses SET business_type=COALESCE(NULLIF(business_type,''),'Cafe'), currency=COALESCE(NULLIF(currency,''),'₹'), active=COALESCE(active,TRUE), updated_at=COALESCE(updated_at,CURRENT_TIMESTAMP)`);
    await pool.query(`UPDATE app_users SET business_id=$1 WHERE business_id IS NULL`, [defaultBusinessId]);
}

function makeBusinessCode(businessName = '') {
    const base = String(businessName || 'CAFE')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 70) || 'CAFE';
    return `${base}-${Date.now().toString(36).toUpperCase().slice(-8)}`;
}

function cleanBusinessPayload(body = {}) {
    return {
        businessName: String(body.businessName || '').trim(),
        businessType: String(body.businessType || 'Cafe').trim() || 'Cafe',
        ownerName: String(body.ownerName || '').trim(),
        phone: String(body.phone || '').trim(),
        email: String(body.email || '').trim(),
        address: String(body.address || '').trim(),
        city: String(body.city || '').trim(),
        state: String(body.state || '').trim(),
        gstin: String(body.gstin || '').trim(),
        logoUrl: String(body.logoUrl || '').trim(),
        currency: String(body.currency || '₹').trim() || '₹'
    };
}

function verifyPassword(password, stored) {
    if (!stored || !String(stored).includes(":")) return false;
    const [salt, expectedHex] = String(stored).split(":");
    try {
        const actual = crypto.scryptSync(String(password), salt, 64).toString("hex");
        const a = Buffer.from(actual, "hex");
        const b = Buffer.from(expectedHex, "hex");
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (_) { return false; }
}

async function createSession(user) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await pool.query(
        `
        INSERT INTO app_sessions (token, user_id, expires_at)
        VALUES ($1, $2, $3)
        `,
        [token, user.id, expiresAt]
    );

    return {
        token,
        userId: user.id,
        expiresAt: expiresAt.getTime()
    };
}

async function getSessionUser(req) {
    const auth = String(req.headers.authorization || "");
    if (!auth.startsWith("Bearer ")) return null;

    const token = auth.slice(7).trim();
    if (!token) return null;

    const result = await pool.query(
        `
        SELECT token, user_id, expires_at
        FROM app_sessions
        WHERE token = $1
        LIMIT 1
        `,
        [token]
    );

    const session = result.rows[0];

    if (!session) return null;

    const expiresAt = new Date(session.expires_at).getTime();

    if (expiresAt < Date.now()) {
        await pool.query(
            `DELETE FROM app_sessions WHERE token = $1`,
            [token]
        );
        return null;
    }

    return {
        token,
        userId: session.user_id,
        expiresAt
    };
}

async function loadSessionUser(session) {
    const result = await pool.query(`
        SELECT u.id, u.display_name, u.username, u.profile_id, u.business_id, u.active,
               b.business_name, b.business_type, b.owner_name, b.phone AS business_phone,
               b.email AS business_email, b.address AS business_address, b.city, b.state, b.gstin,
               b.logo_url, b.currency, b.active AS business_active,
               p.name AS profile_name, COALESCE(p.permissions, '{}'::jsonb) AS permissions
        FROM app_users u
        LEFT JOIN businesses b ON b.id = u.business_id
        LEFT JOIN access_profiles p ON p.id = u.profile_id
        WHERE u.id = $1
    `, [session.userId]);
    const user = result.rows[0];
    return user && user.active ? user : null;
}

function permissionForRequest(req) {
    const path = req.path;
    const method = req.method.toUpperCase();
    if (path.startsWith("/auth/")) return null;
    if (path === "/dashboard/stats") return "dashboard.view";
    if (path.startsWith("/reports/")) return "reports.view";
    if (path === "/settings") return method === "GET" ? "settings.view" : "settings.edit";
    if (path === "/access" || path.startsWith("/access/")) {
        if (method === "GET") return "access.view";
        if (method === "POST") return "access.create";
        if (["PUT","PATCH"].includes(method)) return "access.edit";
        if (method === "DELETE") return "access.delete";
    }
    const groups = [
        ["kot-groups","kot_groups"],["expenses","expenses"],["loyalty","loyalty"],["backup","backup"],["invoice-designer","invoice_designer"],["advanced-reports","advanced_reports"],["deployment","deployment"],
        ["menu","menu"],["customers","customers"],["tables","tables"],
        ["reservations","reservations"],["kot","kitchen"],["payments","payments"],
        ["invoices","payments"]
    ];
    for (const [prefix,module] of groups) {
        if (path === `/${prefix}` || path.startsWith(`/${prefix}/`)) {
            if (module === "kitchen") {
                if (req.query?.print === "1") return "kitchen.print";
                return method === "GET" ? "kitchen.view" : "kitchen.edit";
            }
            if (method === "GET") return `${module}.view`;
            if (method === "POST") return `${module}.create`;
            if (["PUT","PATCH"].includes(method)) return `${module}.edit`;
            if (method === "DELETE") return `${module}.delete`;
        }
    }
    if (path === "/orders" || path.startsWith("/orders/")) {
        if (method === "GET") return "orders.view";
        if (method === "POST") return "new_order.create";
        if (["PUT","PATCH"].includes(method)) return "orders.edit";
        if (method === "DELETE") return "orders.delete";
    }
    return null;
}

async function requireAuth(req, res, next) {
    try {
        const session = await getSessionUser(req);
        if (!session) return res.status(401).json({ error: "Authentication required" });
        const user = await loadSessionUser(session);
        if (!user) return res.status(401).json({ error: "Session is invalid or user is inactive" });
        req.user = user;
        req.sessionToken = session.token;
        const required = permissionForRequest(req);
        if (!required) return next();
        const permissions = user.permissions && typeof user.permissions === "object" ? user.permissions : {};
        if (user.profile_name === "Admin" || permissions[required] === true) return next();
        return res.status(403).json({ error: `Permission denied: ${required}` });
    } catch (e) {
        console.error("Auth middleware error:", e);
        res.status(500).json({ error: "Authentication service error" });
    }
}

// =====================================================
// INVOICE DATABASE SETUP
// =====================================================

async function ensureInvoiceTables() {

    await pool.query(`
        CREATE SEQUENCE IF NOT EXISTS invoice_number_seq
        START WITH 1
        INCREMENT BY 1
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS invoices (

            id SERIAL PRIMARY KEY,

            invoice_number VARCHAR(50) NOT NULL UNIQUE,

            order_id INTEGER NOT NULL UNIQUE
                REFERENCES orders(id)
                ON DELETE RESTRICT,

            customer_id INTEGER
                REFERENCES customers(id)
                ON DELETE SET NULL,

            invoice_date TIMESTAMP NOT NULL
                DEFAULT CURRENT_TIMESTAMP,

            subtotal NUMERIC(12,2) NOT NULL
                DEFAULT 0,

            gst NUMERIC(12,2) NOT NULL
                DEFAULT 0,

            total NUMERIC(12,2) NOT NULL
                DEFAULT 0,

            payment_method VARCHAR(50),

            status VARCHAR(30) NOT NULL
                DEFAULT 'Generated',

            created_at TIMESTAMP NOT NULL
                DEFAULT CURRENT_TIMESTAMP
        )
    `);

    console.log(
        "✅ Invoice tables ready"
    );

}


// =====================================================
// BUSINESS EXTENSIONS (STEP 15-19)
// =====================================================

async function ensureBusinessTables() {

    
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL`);

    // Menu master enhancements: item nature, unit, item-level tax and channel pricing.
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS nature VARCHAR(20) NOT NULL DEFAULT 'Goods'`);
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS unit VARCHAR(20) NOT NULL DEFAULT 'ea'`);
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(6,2) NOT NULL DEFAULT 5`);
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS cgst_rate NUMERIC(6,2) NOT NULL DEFAULT 2.5`);
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS sgst_rate NUMERIC(6,2) NOT NULL DEFAULT 2.5`);
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS igst_rate NUMERIC(6,2) NOT NULL DEFAULT 5`);
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS tax_mode VARCHAR(20) NOT NULL DEFAULT 'exclusive'`);
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS tax_label VARCHAR(60) NOT NULL DEFAULT 'GST 5%'`);
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS channel_prices JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await pool.query(`CREATE TABLE IF NOT EXISTS menu_variants (
        id SERIAL PRIMARY KEY,
        menu_id INTEGER NOT NULL REFERENCES menu(id) ON DELETE CASCADE,
        name VARCHAR(120) NOT NULL,
        sku VARCHAR(80),
        price NUMERIC(12,2) NOT NULL DEFAULT 0,
        unit VARCHAR(20) NOT NULL DEFAULT 'ea',
        channel_prices JSONB NOT NULL DEFAULT '{}'::jsonb,
        available BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_menu_variants_menu ON menu_variants(menu_id)`);
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_id INTEGER REFERENCES menu_variants(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unit VARCHAR(20)`);
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(6,2) NOT NULL DEFAULT 5`);
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tax_mode VARCHAR(20) NOT NULL DEFAULT 'exclusive'`);

    await pool.query(`CREATE TABLE IF NOT EXISTS kot_groups (id SERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL UNIQUE, description TEXT, station VARCHAR(60) NOT NULL DEFAULT 'Kitchen', sort_order INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS kot_group_id INTEGER REFERENCES kot_groups(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE kot ADD COLUMN IF NOT EXISTS kot_group_id INTEGER REFERENCES kot_groups(id) ON DELETE SET NULL`);
    await pool.query(`INSERT INTO kot_groups(name, description, station, sort_order, active) VALUES('Main Kitchen','Default KOT group','Kitchen',0,TRUE) ON CONFLICT(name) DO NOTHING`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount NUMERIC(12,2) NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_charge NUMERIC(12,2) NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS expense_categories (
            id SERIAL PRIMARY KEY,
            name VARCHAR(120) NOT NULL UNIQUE,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS expenses (
            id SERIAL PRIMARY KEY,
            category_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
            amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
            payment_method VARCHAR(50) NOT NULL DEFAULT 'Cash',
            expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
            note TEXT,
            created_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const seedExpenseCategories = ['Purchase / Supplies','Staff / Salary','Rent','Utilities','Marketing','Maintenance','Delivery / Logistics','Other'];
    for (const name of seedExpenseCategories) {
        await pool.query(`INSERT INTO expense_categories(name) VALUES($1) ON CONFLICT(name) DO NOTHING`, [name]);
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS loyalty_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            points_per_currency NUMERIC(10,4) NOT NULL DEFAULT 1,
            currency_per_point NUMERIC(10,4) NOT NULL DEFAULT 1,
            min_redeem_points INTEGER NOT NULL DEFAULT 100,
            welcome_points INTEGER NOT NULL DEFAULT 0,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`
        INSERT INTO loyalty_settings(id) VALUES(1)
        ON CONFLICT(id) DO NOTHING
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS loyalty_transactions (
            id SERIAL PRIMARY KEY,
            customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
            points INTEGER NOT NULL,
            transaction_type VARCHAR(40) NOT NULL,
            reference_type VARCHAR(40),
            reference_id INTEGER,
            note TEXT,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(reference_type, reference_id, transaction_type)
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_loyalty_customer ON loyalty_transactions(customer_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date DESC)`);

        // Billing adjustments: discounts and service charges
    await pool.query(`
        CREATE TABLE IF NOT EXISTS billing_adjustments (
            id SERIAL PRIMARY KEY,
            name VARCHAR(150) NOT NULL UNIQUE,
            type VARCHAR(20) NOT NULL DEFAULT 'discount',
            value_type VARCHAR(20) NOT NULL DEFAULT 'amount',
            value NUMERIC(12,2) NOT NULL DEFAULT 0,
            applies_to VARCHAR(20) NOT NULL DEFAULT 'all',
            description TEXT,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    console.log('✅ Business extensions ready');
}

async function getLoyaltySettings() {
    const r = await pool.query(`SELECT * FROM loyalty_settings WHERE id=1`);
    return r.rows[0] || { points_per_currency: 1, currency_per_point: 1, min_redeem_points: 100, welcome_points: 0, enabled: true };
}

async function awardLoyaltyForPayment(paymentId, orderId, amount) {
    try {
        const order = (await pool.query(`SELECT customer_id FROM orders WHERE id=$1`, [orderId])).rows[0];
        if (!order?.customer_id) return;
        const settings = await getLoyaltySettings();
        if (!settings.enabled) return;
        const points = Math.max(0, Math.floor(Number(amount || 0) * Number(settings.points_per_currency || 0)));
        if (!points) return;
        await pool.query(`
            INSERT INTO loyalty_transactions(customer_id, points, transaction_type, reference_type, reference_id, note)
            VALUES($1,$2,'Earned','Payment',$3,'Points earned from bill')
            ON CONFLICT(reference_type, reference_id, transaction_type) DO NOTHING
        `, [order.customer_id, points, paymentId]);
    } catch (e) {
        console.error('Loyalty award failed:', e.message);
    }
}

function resolvePgDumpBinary() {
    const configured = String(process.env.PG_DUMP_PATH || "").trim();

    if (configured) {
        if (fs.existsSync(configured)) {
            return configured;
        }

        console.warn("Configured PG_DUMP_PATH does not exist:", configured);
    }

    // Try PATH first.
    const pathBinary = process.platform === "win32"
        ? "pg_dump.exe"
        : "pg_dump";

    // Common Windows PostgreSQL installation locations.
    if (process.platform === "win32") {
        const roots = [
            "C:\\Program Files\\PostgreSQL",
            "C:\\Program Files (x86)\\PostgreSQL"
        ];

        for (const root of roots) {
            if (!fs.existsSync(root)) continue;

            try {
                const versions = fs.readdirSync(root, { withFileTypes: true })
                    .filter(entry => entry.isDirectory())
                    .map(entry => entry.name)
                    .sort()
                    .reverse();

                for (const version of versions) {
                    const candidate = path.join(
                        root,
                        version,
                        "bin",
                        "pg_dump.exe"
                    );

                    if (fs.existsSync(candidate)) {
                        return candidate;
                    }
                }
            } catch (_) {}
        }
    }

    return pathBinary;
}

function runPgDump(args, env, cb) {
    const binary = resolvePgDumpBinary();

    console.log("Using pg_dump:", binary);

    execFile(
        binary,
        args,
        {
            env: env || process.env,
            maxBuffer: 25 * 1024 * 1024,
            windowsHide: true
        },
        cb
    );
}

function databaseEnv() {
    return { ...process.env, PGPASSWORD: process.env.DB_PASSWORD || '' };
}


// =====================================================
// HOME
// =====================================================

app.get("/", (_, res) => res.sendFile(path.join(__dirname, "index.html")));



// =====================================================
// BUSINESS / REGISTRATION
// =====================================================
app.post('/api/public/register-business', async (req, res) => {
    // Registration is public, but the startup migration should already have run.
    // Keep this defensive check for manually invoked/embedded server startup.
    await ensureBusinessTable();
    const client = await pool.connect();
    try {
        const b = cleanBusinessPayload(req.body);
        const username = String(req.body.username || '').trim().toLowerCase();
        const password = String(req.body.password || '');
        if (!b.businessName || !b.ownerName || !username || !password) {
            return res.status(400).json({ error: 'Business name, owner name, username and password are required' });
        }
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
        if (!/^[a-z0-9._-]{3,100}$/.test(username)) return res.status(400).json({ error: 'Username may contain only letters, numbers, dot, underscore and hyphen' });

        await client.query('BEGIN');
        const existingUser = await client.query('SELECT id FROM app_users WHERE LOWER(username)=$1 LIMIT 1', [username]);
        if (existingUser.rows.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Username already exists' });
        }

        // Business authentication is handled by app_users. Legacy business.password_hash
        // columns are kept nullable by ensureBusinessTable() for backwards compatibility.
        const business = (await client.query(`
            INSERT INTO businesses (business_code,business_name,business_type,owner_name,phone,email,address,city,state,gstin,logo_url,currency)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            RETURNING *
        `, [makeBusinessCode(b.businessName),b.businessName,b.businessType,b.ownerName,b.phone,b.email,b.address,b.city,b.state,b.gstin,b.logoUrl,b.currency])).rows[0];

        let adminProfile = (await client.query(`SELECT id FROM access_profiles WHERE name='Admin' LIMIT 1`)).rows[0];
        // Be defensive for databases where the access seed has not yet created Admin.
        if (!adminProfile) {
            const profileResult = await client.query(
                `INSERT INTO access_profiles (name, description, permissions) VALUES ('Admin','Full system access',$1::jsonb) RETURNING id`,
                [JSON.stringify(allPermissionsServer())]
            );
            adminProfile = profileResult.rows[0];
        }

        const user = (await client.query(`
            INSERT INTO app_users (display_name,username,password_hash,profile_id,business_id,active)
            VALUES ($1,$2,$3,$4,$5,TRUE)
            RETURNING id,display_name,username,profile_id,business_id,active
        `, [b.ownerName, username, hashPassword(password), adminProfile.id, business.id])).rows[0];

        await client.query('COMMIT');
        res.status(201).json({ success: true, business, user });
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('Business registration error:', e);
        const detail = process.env.NODE_ENV === 'production'
            ? 'Could not create business profile'
            : `Could not create business profile: ${e.message}`;
        const status = e?.code === '23505' ? 409 : 500;
        res.status(status).json({ error: status === 409 ? 'Username already exists' : detail });
    } finally {
        client.release();
    }
});

app.get('/api/public/business/:id', async (req,res)=>{
    try {
        const id=Number(req.params.id);
        const r=await pool.query(`SELECT id,business_code,business_name,business_type,owner_name,phone,email,address,city,state,gstin,logo_url,currency,active FROM businesses WHERE id=$1`,[id]);
        if(!r.rows.length) return res.status(404).json({error:'Business not found'});
        res.json(r.rows[0]);
    } catch(e){ res.status(500).json({error:'Failed to load business'}); }
});

// AUTH ROUTES
// =====================================================
app.post("/api/auth/login", async (req,res)=>{
    try {
        const username=String(req.body.username||"").trim().toLowerCase();
        const password=String(req.body.password||"");
        if(!username||!password) return res.status(400).json({error:"Username and password are required"});
        const r=await pool.query(`SELECT u.id,u.display_name,u.username,u.profile_id,u.business_id,u.active,u.password_hash,
            b.business_code,b.business_name,b.business_type,b.owner_name,b.phone AS business_phone,b.email AS business_email,
            b.address AS business_address,b.city,b.state,b.gstin,b.logo_url,b.currency,b.active AS business_active,
            p.name AS profile_name,COALESCE(p.permissions,'{}'::jsonb) AS permissions
            FROM app_users u
            LEFT JOIN businesses b ON b.id=u.business_id
            LEFT JOIN access_profiles p ON p.id=u.profile_id
            WHERE LOWER(u.username)=$1 LIMIT 1`,[username]);
        const user=r.rows[0];
        if(!user||!user.active||!verifyPassword(password,user.password_hash)) return res.status(401).json({error:"Invalid username or password"});
        delete user.password_hash;
        const session = await createSession(user);

res.json({
    success: true,
    token: session.token,
    user,
    expiresAt: session.expiresAt
});
    }catch(e){console.error("Login error:",e);res.status(500).json({error:"Login failed"});}
});
app.get("/api/auth/me",async(req,res)=>{
    try{const session = await getSessionUser(req);if(!session)return res.status(401).json({error:"Not logged in"});const user=await loadSessionUser(session);if(!user)return res.status(401).json({error:"Session is invalid"});res.json({user,expiresAt: session.expiresAt});}
    catch(e){res.status(500).json({error:"Could not read session"});}
});
app.post("/api/auth/logout", async (req, res) => {
    try {
        const session = await getSessionUser(req);

        if (session) {
            await pool.query(
                `DELETE FROM app_sessions WHERE token = $1`,
                [session.token]
            );
        }

        res.json({ success: true });

    } catch (e) {
        console.error("Logout error:", e);
        res.status(500).json({
            error: "Logout failed"
        });
    }
});
app.use("/api", requireAuth);

// =====================================================
// MENU
// =====================================================
// =====================================================
// MENU CATEGORIES
// =====================================================

app.get("/api/menu/categories", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                id,
                name,
                sort_order,
                active,
                created_at,
                updated_at
            FROM menu_categories
            ORDER BY sort_order ASC, name ASC, id ASC
        `);

        res.json(result.rows);
    } catch (e) {
        console.error("Load menu categories error:", e);
        res.status(500).json({
            error: "Failed to load menu categories"
        });
    }
});


app.post("/api/menu/categories", async (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        const sortOrder = Number(req.body.sortOrder || 0);
        const active = req.body.active !== false;

        if (!name) {
            return res.status(400).json({
                error: "Category name is required"
            });
        }

        const result = await pool.query(`
            INSERT INTO menu_categories
            (
                name,
                sort_order,
                active
            )
            VALUES
            ($1, $2, $3)
            RETURNING *
        `, [
            name,
            Number.isFinite(sortOrder) ? sortOrder : 0,
            active
        ]);

        res.status(201).json(result.rows[0]);

    } catch (e) {
        console.error("Create menu category error:", e);

        if (e.code === "23505") {
            return res.status(409).json({
                error: "Menu category already exists"
            });
        }

        res.status(500).json({
            error: "Failed to create menu category"
        });
    }
});


app.put("/api/menu/categories/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                error: "Invalid category ID"
            });
        }

        const name = String(req.body.name || "").trim();
        const sortOrder = Number(req.body.sortOrder || 0);
        const active = req.body.active !== false;

        if (!name) {
            return res.status(400).json({
                error: "Category name is required"
            });
        }

        const result = await pool.query(`
            UPDATE menu_categories
            SET
                name = $1,
                sort_order = $2,
                active = $3,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $4
            RETURNING *
        `, [
            name,
            Number.isFinite(sortOrder) ? sortOrder : 0,
            active,
            id
        ]);

        if (!result.rows.length) {
            return res.status(404).json({
                error: "Menu category not found"
            });
        }

        res.json(result.rows[0]);

    } catch (e) {
        console.error("Update menu category error:", e);

        if (e.code === "23505") {
            return res.status(409).json({
                error: "Menu category already exists"
            });
        }

        res.status(500).json({
            error: "Failed to update menu category"
        });
    }
});


app.delete("/api/menu/categories/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                error: "Invalid category ID"
            });
        }

        const result = await pool.query(`
            DELETE FROM menu_categories
            WHERE id = $1
            RETURNING id
        `, [id]);

        if (!result.rows.length) {
            return res.status(404).json({
                error: "Menu category not found"
            });
        }

        res.json({
            success: true
        });

    } catch (e) {
        console.error("Delete menu category error:", e);
        res.status(500).json({
            error: "Failed to delete menu category"
        });
    }
});

app.get(
    "/api/menu",
    async (_, res) => {
        try {
            const result = await pool.query(
                `SELECT m.*, kg.name AS kot_group_name, kg.station AS kot_group_station
                 FROM menu m
                 LEFT JOIN kot_groups kg ON kg.id=m.kot_group_id
                 ORDER BY m.category, m.name, m.id`
            );
            const items = result.rows;
            const variants = await pool.query(`
                SELECT id, menu_id, name, sku, price, unit, channel_prices, available
                FROM menu_variants
                ORDER BY menu_id, id
            `);
            const byMenu = new Map();
            for (const v of variants.rows) {
                const key = Number(v.menu_id);
                if (!byMenu.has(key)) byMenu.set(key, []);
                byMenu.get(key).push(v);
            }
            res.json(items.map(item => ({ ...item, variants: byMenu.get(Number(item.id)) || [] })));
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: "Failed to load menu" });
        }
    }
);

function normaliseTaxPayload(body = {}) {
    const taxRate = Number(body.taxRate ?? body.tax_rate ?? 5);
    let cgst = Number(body.cgstRate ?? body.cgst_rate ?? 0);
    let sgst = Number(body.sgstRate ?? body.sgst_rate ?? 0);
    let igst = Number(body.igstRate ?? body.igst_rate ?? taxRate);
    const profile = String(body.taxProfile || body.taxLabel || '').trim();
    if (!cgst && !sgst && taxRate > 0) { cgst = taxRate / 2; sgst = taxRate / 2; }
    if (!igst && taxRate > 0) igst = taxRate;
    return {
        taxRate: Number.isFinite(taxRate) ? Math.max(0, taxRate) : 0,
        cgstRate: Number.isFinite(cgst) ? Math.max(0, cgst) : 0,
        sgstRate: Number.isFinite(sgst) ? Math.max(0, sgst) : 0,
        igstRate: Number.isFinite(igst) ? Math.max(0, igst) : 0,
        taxLabel: profile || `GST ${taxRate}%`
    };
}

function cleanChannelPrices(value) {
    const src = (value && typeof value === 'object') ? value : {};
    const result = {};
    for (const key of ['dine_in', 'takeaway', 'delivery', 'online']) {
        const n = Number(src[key]);
        if (Number.isFinite(n) && n >= 0) result[key] = n;
    }
    return result;
}

function cleanVariants(value) {
    if (!Array.isArray(value)) return [];
    return value.map((v) => ({
        id: Number(v.id) || null,
        name: String(v.name || '').trim(),
        sku: String(v.sku || '').trim() || null,
        price: Number(v.price),
        unit: String(v.unit || 'ea').trim() || 'ea',
        channelPrices: cleanChannelPrices(v.channelPrices || v.channel_prices),
        available: v.available !== false
    })).filter(v => v.name && Number.isFinite(v.price) && v.price >= 0);
}

async function replaceMenuVariants(client, menuId, variants) {
    await client.query(`DELETE FROM menu_variants WHERE menu_id=$1`, [menuId]);
    for (const v of variants) {
        await client.query(`
            INSERT INTO menu_variants(menu_id,name,sku,price,unit,channel_prices,available)
            VALUES($1,$2,$3,$4,$5,$6,$7)
        `, [menuId, v.name, v.sku, v.price, v.unit, JSON.stringify(v.channelPrices), v.available]);
    }
}

app.post(
    "/api/menu",
    async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const name = String(req.body.name || '').trim();
            const price = Number(req.body.price);
            const category = String(req.body.category || '').trim();
            const nature = ['Goods','Service'].includes(req.body.nature) ? req.body.nature : 'Goods';
            const unit = String(req.body.unit || 'ea').trim() || 'ea';
            const available = req.body.available !== false;
            const kotGroupId = req.body.kotGroupId ? Number(req.body.kotGroupId) : null;
            const tax = normaliseTaxPayload(req.body);
            const taxMode = ['inclusive','exclusive'].includes(req.body.taxMode) ? req.body.taxMode : 'exclusive';
            const channelPrices = cleanChannelPrices(req.body.channelPrices);
            const variants = cleanVariants(req.body.variants);
            if (!name || !Number.isFinite(price) || price < 0 || !category) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: "Name, price and category are required" });
            }
            const result = await client.query(`
                INSERT INTO menu(name,price,category,available,kot_group_id,nature,unit,tax_rate,cgst_rate,sgst_rate,igst_rate,tax_mode,tax_label,channel_prices)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                RETURNING *
            `, [name, price, category, available, kotGroupId, nature, unit, tax.taxRate, tax.cgstRate, tax.sgstRate, tax.igstRate, taxMode, tax.taxLabel, JSON.stringify(channelPrices)]);
            await replaceMenuVariants(client, result.rows[0].id, variants);
            await client.query('COMMIT');
            res.status(201).json({ success: true, menu: result.rows[0] });
        } catch (e) {
            await client.query('ROLLBACK');
            console.error(e);
            res.status(500).json({ error: "Failed to add menu item: " + e.message });
        } finally { client.release(); }
    }
);

app.put(
    "/api/menu/:id",
    async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const name = String(req.body.name || '').trim();
            const price = Number(req.body.price);
            const category = String(req.body.category || '').trim();
            const nature = ['Goods','Service'].includes(req.body.nature) ? req.body.nature : 'Goods';
            const unit = String(req.body.unit || 'ea').trim() || 'ea';
            const kotGroupId = req.body.kotGroupId ? Number(req.body.kotGroupId) : null;
            const tax = normaliseTaxPayload(req.body);
            const taxMode = ['inclusive','exclusive'].includes(req.body.taxMode) ? req.body.taxMode : 'exclusive';
            const channelPrices = cleanChannelPrices(req.body.channelPrices);
            const variants = cleanVariants(req.body.variants);
            if (!name || !Number.isFinite(price) || price < 0 || !category) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: "Name, price and category are required" });
            }
            const result = await client.query(`
                UPDATE menu SET name=$1, price=$2, category=$3, kot_group_id=$4,
                    nature=$5, unit=$6, tax_rate=$7, cgst_rate=$8, sgst_rate=$9, igst_rate=$10,
                    tax_mode=$11, tax_label=$12, channel_prices=$13
                WHERE id=$14 RETURNING *
            `, [name, price, category, kotGroupId, nature, unit, tax.taxRate, tax.cgstRate, tax.sgstRate, tax.igstRate, taxMode, tax.taxLabel, JSON.stringify(channelPrices), req.params.id]);
            if (!result.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: "Menu item not found" });
            }
            await replaceMenuVariants(client, req.params.id, variants);
            await client.query('COMMIT');
            res.json({ success: true, menu: result.rows[0] });
        } catch (e) {
            await client.query('ROLLBACK');
            console.error(e);
            res.status(500).json({ error: "Failed to update menu item: " + e.message });
        } finally { client.release(); }
    }
);


app.get("/api/menu/:id/variants", async (req,res)=>{
    try { const r=await pool.query(`SELECT * FROM menu_variants WHERE menu_id=$1 ORDER BY id`,[req.params.id]); res.json(r.rows); }
    catch(e){ res.status(500).json({error:"Failed to load variants"}); }
});

app.delete(
    "/api/menu/:id",
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    UPDATE menu
                    SET available = false
                    WHERE id = $1
                    RETURNING *
                    `,
                    [req.params.id]
                );

            if (!result.rows.length) {

                return res.status(404).json({
                    error: "Menu item not found"
                });

            }

            res.json({
                success: true,
                menu: result.rows[0]
            });

        } catch (e) {

            res.status(500).json({
                error:
                    "Failed to disable menu item"
            });

        }

    }
);


app.put(
    "/api/menu/:id/enable",
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    UPDATE menu
                    SET available = true
                    WHERE id = $1
                    RETURNING *
                    `,
                    [req.params.id]
                );

            if (!result.rows.length) {

                return res.status(404).json({
                    error: "Menu item not found"
                });

            }

            res.json({
                success: true,
                menu: result.rows[0]
            });

        } catch (e) {

            res.status(500).json({
                error:
                    "Failed to enable menu item"
            });

        }

    }
);


// =====================================================
// TABLES
// =====================================================

app.get(
    "/api/tables",
    async (_, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM restaurant_tables
                    ORDER BY id
                    `
                );

            res.json(result.rows);

        } catch (e) {

            res.status(500).json({
                error:
                    "Failed to load tables"
            });

        }

    }
);


app.post(
    "/api/tables",
    async (req, res) => {

        try {

            const n =
                req.body.tableNumber ||
                req.body.table_number;

            const c =
                Number(req.body.capacity) || 4;

            if (!n) {

                return res.status(400).json({
                    error:
                        "Table number is required"
                });

            }

            const result =
                await pool.query(
                    `
                    INSERT INTO restaurant_tables
                    (
                        table_number,
                        capacity,
                        status
                    )
                    VALUES
                    ($1,$2,'Available')
                    RETURNING *
                    `,
                    [n, c]
                );

            res.status(201).json({
                success: true,
                table: result.rows[0]
            });

        } catch (e) {

            if (e.code === "23505") {

                return res.status(409).json({
                    error:
                        "Table number already exists"
                });

            }

            res.status(500).json({
                error:
                    "Failed to add table"
            });

        }

    }
);


app.put(
    "/api/tables/:id",
    async (req, res) => {

        try {

            const n =
                req.body.tableNumber ||
                req.body.table_number;

            const c =
                Number(req.body.capacity) || 4;

            if (!n) {

                return res.status(400).json({
                    error:
                        "Table number is required"
                });

            }

            const result =
                await pool.query(
                    `
                    UPDATE restaurant_tables
                    SET
                        table_number = $1,
                        capacity = $2
                    WHERE id = $3
                    RETURNING *
                    `,
                    [
                        n,
                        c,
                        req.params.id
                    ]
                );

            if (!result.rows.length) {

                return res.status(404).json({
                    error:
                        "Table not found"
                });

            }

            res.json({
                success: true,
                table: result.rows[0]
            });

        } catch (e) {

            if (e.code === "23505") {

                return res.status(409).json({
                    error:
                        "Table number already exists"
                });

            }

            res.status(500).json({
                error:
                    "Failed to update table"
            });

        }

    }
);


app.put(
    "/api/tables/:id/status",
    async (req, res) => {

        try {

            const allowed = [
                "Available",
                "Occupied",
                "Reserved"
            ];

            if (
                !allowed.includes(
                    req.body.status
                )
            ) {

                return res.status(400).json({
                    error:
                        "Invalid table status"
                });

            }

            const result =
                await pool.query(
                    `
                    UPDATE restaurant_tables
                    SET status = $1
                    WHERE id = $2
                    RETURNING *
                    `,
                    [
                        req.body.status,
                        req.params.id
                    ]
                );

            if (!result.rows.length) {

                return res.status(404).json({
                    error:
                        "Table not found"
                });

            }

            res.json({
                success: true,
                table: result.rows[0]
            });

        } catch (e) {

            res.status(500).json({
                error:
                    "Failed to update table status"
            });

        }

    }
);


app.delete(
    "/api/tables/:id",
    async (req, res) => {

        try {

            const tableResult =
                await pool.query(
                    `
                    SELECT *
                    FROM restaurant_tables
                    WHERE id = $1
                    `,
                    [req.params.id]
                );

            if (!tableResult.rows.length) {

                return res.status(404).json({
                    error:
                        "Table not found"
                });

            }

            const table =
                tableResult.rows[0];


            if (table.status === "Occupied") {

                return res.status(400).json({
                    error:
                        `${table.table_number} is currently occupied. Please make it Available before deleting.`
                });

            }


            const orders =
                await pool.query(
                    `
                    SELECT COUNT(*) AS count
                    FROM orders
                    WHERE table_number = $1
                    `,
                    [table.table_number]
                );

            if (
                Number(
                    orders.rows[0].count
                ) > 0
            ) {

                return res.status(400).json({
                    error:
                        `${table.table_number} has existing orders. It cannot be deleted because historical order data must be preserved.`
                });

            }


            const reservations =
                await pool.query(
                    `
                    SELECT COUNT(*) AS count
                    FROM reservations
                    WHERE table_number = $1
                    `,
                    [table.table_number]
                );

            if (
                Number(
                    reservations.rows[0].count
                ) > 0
            ) {

                return res.status(400).json({
                    error:
                        `${table.table_number} has reservation records. It cannot be deleted.`
                });

            }


            await pool.query(
                `
                DELETE FROM restaurant_tables
                WHERE id = $1
                `,
                [req.params.id]
            );


            res.json({
                success: true,
                table
            });

        } catch (e) {

            console.error(e);

            res.status(500).json({
                error:
                    "Failed to delete table"
            });

        }

    }
);


// =====================================================
// ORDERS
// =====================================================

app.post(
    "/api/orders",
    async (req, res) => {

        const b = req.body;

        const orderNumber =
            b.orderNumber ||
            b.order_number;

        const orderType =
            b.orderType ||
            b.order_type;

        const tableNumber =
            b.tableNumber ||
            b.table_number;

        const subtotal =
            Number(b.subtotal);

        const gst =
            Number(b.gst);

        const total =
            Number(b.total);

        const paymentMethod =
            b.paymentMethod ||
            b.payment_method ||
            null;

        const items =
            b.items;

        // Order workflow controls supplied by the POS client.
        // Open = saved draft/open order, Pending = KOT workflow,
        // Completed = direct-sale workflow when KOT is disabled.
        const requestedStatus = String(b.initialStatus || b.status || "Pending").trim();
        const orderStatus = ["Open", "Pending", "Completed"].includes(requestedStatus)
            ? requestedStatus
            : "Pending";
        const createKot = b.createKot !== false && orderStatus !== "Open";


        if (
            !orderNumber ||
            !orderType ||
            !Number.isFinite(subtotal) ||
            !Number.isFinite(gst) ||
            !Number.isFinite(total) ||
            !Array.isArray(items) ||
            !items.length
        ) {

            return res.status(400).json({
                error:
                    "Missing or invalid order information"
            });

        }


        if (
            orderType === "Dine-in" &&
            !tableNumber
        ) {

            return res.status(400).json({
                error:
                    "Please select a table for Dine-in order"
            });

        }


        const client =
            await pool.connect();


        try {

            await client.query("BEGIN");


            if (orderType === "Dine-in") {

                const tableResult =
                    await client.query(
                        `
                        SELECT *
                        FROM restaurant_tables
                        WHERE table_number = $1
                        FOR UPDATE
                        `,
                        [tableNumber]
                    );

                const table =
                    tableResult.rows[0];


                if (!table) {

                    throw new Error(
                        "Selected table does not exist"
                    );

                }


                if (
                    table.status !==
                    "Available"
                ) {

                    throw new Error(
                        "Selected table is not available"
                    );

                }

            }


            const orderResult =
                await client.query(
                    `
                    INSERT INTO orders
                    (
                        order_number,
                        order_type,
                        table_number,
                        subtotal,
                        gst,
                        total,
                        payment_method,
                        status,
                        customer_id,
                        discount,
                        service_charge,
                        notes
                    )
                    VALUES
                    (
                        $1,$2,$3,$4,$5,$6,$7,$12,$8,$9,$10,$11
                    )
                    RETURNING *
                    `,
                    [
                        orderNumber,
                        orderType,
                        tableNumber || null,
                        subtotal,
                        gst,
                        total,
                        paymentMethod,
                        b.customerId ? Number(b.customerId) : null,
                        Number(b.discount || 0),
                        Number(b.serviceCharge || 0),
                        b.notes ? String(b.notes).slice(0, 1000) : null,
                        orderStatus
                    ]
                );


            const order =
                orderResult.rows[0];


            for (const item of items) {

                const name =
                    item.name ||
                    item.item_name;

                const price =
                    Number(item.price);

                const quantity =
                    Number(item.quantity);

                const menuId =
                    item.menuId ||
                    item.menu_id ||
                    item.id ||
                    null;

                const variantId = item.variantId || item.variant_id || null;
                let itemUnit = item.unit || null;
                let itemTaxRate = Number(item.taxRate ?? item.tax_rate ?? 5);
                let itemTaxMode = item.taxMode === 'inclusive' || item.tax_mode === 'inclusive' ? 'inclusive' : 'exclusive';
                if (menuId) {
                    const meta = await client.query(`SELECT unit,tax_rate,tax_mode FROM menu WHERE id=$1`, [menuId]);
                    if (meta.rows[0]) {
                        itemUnit = itemUnit || meta.rows[0].unit;
                        itemTaxRate = Number(meta.rows[0].tax_rate ?? itemTaxRate);
                        if (!item.taxMode && meta.rows[0].tax_mode === 'inclusive') itemTaxMode = 'inclusive';
                    }
                }

                let kotGroupId = item.kotGroupId || item.kot_group_id || null;
                if (menuId && !kotGroupId) {
                    const mg = await client.query(`SELECT kot_group_id FROM menu WHERE id=$1`, [menuId]);
                    kotGroupId = mg.rows[0]?.kot_group_id || null;
                }
                if (kotGroupId) {
                    const gg = await client.query(`SELECT id FROM kot_groups WHERE id=$1 AND active=TRUE`, [kotGroupId]);
                    kotGroupId = gg.rows[0]?.id || null;
                }


                if (
                    !name ||
                    !Number.isFinite(price) ||
                    !Number.isFinite(quantity) ||
                    quantity <= 0
                ) {

                    throw new Error(
                        "Invalid order item information"
                    );

                }


                await client.query(
                    `
                    INSERT INTO order_items
                    (
                        order_id,
                        menu_id,
                        variant_id,
                        item_name,
                        price,
                        quantity,
                        line_total,
                        unit,
                        tax_rate,
                        tax_mode
                    )
                    VALUES
                    ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                    `,
                    [
                        order.id,
                        menuId,
                        variantId,
                        name,
                        price,
                        quantity,
                        price * quantity,
                        itemUnit,
                        itemTaxRate,
                        itemTaxMode
                    ]
                );


                if (createKot) {
                    await client.query(
                        `
                        INSERT INTO kot
                        (
                            order_id,
                            item_name,
                            quantity,
                            status,
                            kot_group_id
                        )
                        VALUES
                        ($1,$2,$3,'Pending',$4)
                        `,
                        [
                            order.id,
                            name,
                            quantity,
                            kotGroupId
                        ]
                    );
                }

            }


            if (orderType === "Dine-in") {

                await client.query(
                    `
                    UPDATE restaurant_tables
                    SET status = 'Occupied'
                    WHERE table_number = $1
                    `,
                    [tableNumber]
                );

            }


            await client.query("COMMIT");


            res.status(201).json({
                success: true,
                order
            });

        } catch (e) {

            await client.query(
                "ROLLBACK"
            );

            console.error(e);

            res.status(400).json({
                error: e.message
            });

        } finally {

            client.release();

        }

    }
);


app.get(
    "/api/orders",
    async (_, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM orders
                    ORDER BY created_at DESC
                    `
                );

            res.json(result.rows);

        } catch (e) {

            res.status(500).json({
                error:
                    "Failed to load orders"
            });

        }

    }
);


app.get(
    "/api/orders/:id",
    async (req, res) => {

        try {

            const orderResult =
                await pool.query(
                    `
                    SELECT
                        o.*,
                        c.name AS customer_name,
                        c.phone AS customer_phone,
                        c.email AS customer_email
                    FROM orders o
                    LEFT JOIN customers c ON c.id = o.customer_id
                    WHERE o.id = $1
                    `,
                    [req.params.id]
                );

                app.put(
    "/api/orders/:id",
    async (req, res) => {
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const orderId = Number(req.params.id);

            if (!Number.isInteger(orderId) || orderId <= 0) {
                throw new Error("Invalid order ID");
            }

            const {
                orderType,
                tableNumber,
                subtotal,
                gst,
                total,
                paymentMethod,
                customerId,
                discount,
                serviceCharge,
                notes,
                items
            } = req.body;

            if (!orderType) {
                throw new Error("Order type is required");
            }

            if (!Number.isFinite(Number(subtotal)) ||
                !Number.isFinite(Number(gst)) ||
                !Number.isFinite(Number(total))) {
                throw new Error("Invalid order totals");
            }

            if (!Array.isArray(items) || !items.length) {
                throw new Error("At least one order item is required");
            }

            const existingResult = await client.query(
                `
                SELECT *
                FROM orders
                WHERE id = $1
                FOR UPDATE
                `,
                [orderId]
            );

            const existingOrder = existingResult.rows[0];

            if (!existingOrder) {
                throw new Error("Order not found");
            }

            if (["Completed", "Cancelled"].includes(existingOrder.status)) {
                throw new Error("This order cannot be edited");
            }

            if (orderType === "Dine-in" && !tableNumber) {
                throw new Error("Please select a table for Dine-in order");
            }

            /*
             * If the table changed, release the old table.
             */
            if (
                existingOrder.order_type === "Dine-in" &&
                existingOrder.table_number &&
                existingOrder.table_number !== tableNumber
            ) {
                await client.query(
                    `
                    UPDATE restaurant_tables
                    SET status = 'Available'
                    WHERE table_number = $1
                    `,
                    [existingOrder.table_number]
                );
            }

            /*
             * Lock the new table and make sure it exists.
             */
            if (orderType === "Dine-in") {
                const tableResult = await client.query(
                    `
                    SELECT *
                    FROM restaurant_tables
                    WHERE table_number = $1
                    FOR UPDATE
                    `,
                    [tableNumber]
                );

                const table = tableResult.rows[0];

                if (!table) {
                    throw new Error("Selected table does not exist");
                }

                if (
                    table.status !== "Available" &&
                    table.table_number !== existingOrder.table_number
                ) {
                    throw new Error("Selected table is not available");
                }
            }

            const updatedOrderResult = await client.query(
                `
                UPDATE orders
                SET
                    order_type = $1,
                    table_number = $2,
                    subtotal = $3,
                    gst = $4,
                    total = $5,
                    payment_method = $6,
                    customer_id = $7,
                    discount = $8,
                    service_charge = $9,
                    notes = $10
                WHERE id = $11
                RETURNING *
                `,
                [
                    orderType,
                    tableNumber || null,
                    Number(subtotal),
                    Number(gst),
                    Number(total),
                    paymentMethod || null,
                    customerId ? Number(customerId) : null,
                    Number(discount || 0),
                    Number(serviceCharge || 0),
                    notes ? String(notes).slice(0, 1000) : null,
                    orderId
                ]
            );

            const updatedOrder = updatedOrderResult.rows[0];

            /*
             * Replace order items.
             */
            await client.query(
                `
                DELETE FROM order_items
                WHERE order_id = $1
                `,
                [orderId]
            );

            for (const item of items) {
                const name =
                    item.name ||
                    item.item_name ||
                    "";

                const price = Number(item.price);
                const quantity = Number(item.quantity);

                const menuId =
                    item.menuId ||
                    item.menu_id ||
                    item.id ||
                    null;

                const variantId =
                    item.variantId ||
                    item.variant_id ||
                    null;

                const itemUnit =
                    item.unit || "ea";

                const itemTaxRate =
                    Number(item.taxRate ?? item.tax_rate ?? 5);

                const itemTaxMode =
                    item.taxMode === "inclusive"
                        ? "inclusive"
                        : "exclusive";

                if (
                    !name ||
                    !Number.isFinite(price) ||
                    !Number.isFinite(quantity) ||
                    quantity <= 0
                ) {
                    throw new Error("Invalid order item");
                }

                await client.query(
                    `
                    INSERT INTO order_items
                    (
                        order_id,
                        menu_id,
                        variant_id,
                        item_name,
                        price,
                        quantity,
                        line_total,
                        unit,
                        tax_rate,
                        tax_mode
                    )
                    VALUES
                    (
                        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
                    )
                    `,
                    [
                        orderId,
                        menuId,
                        variantId,
                        name,
                        price,
                        quantity,
                        price * quantity,
                        itemUnit,
                        itemTaxRate,
                        itemTaxMode
                    ]
                );
            }

            /*
             * Mark selected dine-in table occupied.
             */
            if (orderType === "Dine-in" && tableNumber) {
                await client.query(
                    `
                    UPDATE restaurant_tables
                    SET status = 'Occupied'
                    WHERE table_number = $1
                    `,
                    [tableNumber]
                );
            }

            await client.query("COMMIT");

            res.json({
                success: true,
                order: updatedOrder
            });

        } catch (e) {
            await client.query("ROLLBACK");

            console.error(
                "❌ Update order error:",
                e
            );

            res.status(400).json({
                error: e.message
            });

        } finally {
            client.release();
        }
    }
);

            const order =
                orderResult.rows[0];


            if (!order) {

                return res.status(404).json({
                    error:
                        "Order not found"
                });

            }


            const items =
                (
                    await pool.query(
                        `
                        SELECT *
                        FROM order_items
                        WHERE order_id = $1
                        ORDER BY id
                        `,
                        [req.params.id]
                    )
                ).rows;


            res.json({
                order,
                items
            });

        } catch (e) {

            res.status(500).json({
                error:
                    "Failed to load order"
            });

        }

    }
);


app.put(
    "/api/orders/:id/cancel",
    async (req, res) => {

        const client =
            await pool.connect();

        try {

            await client.query("BEGIN");


            const orderResult =
                await client.query(
                    `
                    SELECT *
                    FROM orders
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [req.params.id]
                );


            const order =
                orderResult.rows[0];


            if (!order) {

                await client.query(
                    "ROLLBACK"
                );

                return res.status(404).json({
                    error:
                        "Order not found"
                });

            }


            if (
                [
                    "Completed",
                    "Cancelled"
                ].includes(order.status)
            ) {

                throw new Error(
                    "This order cannot be cancelled"
                );

            }


            const result =
                await client.query(
                    `
                    UPDATE orders
                    SET status = 'Cancelled'
                    WHERE id = $1
                    RETURNING *
                    `,
                    [req.params.id]
                );


            await client.query(
                `
                UPDATE kot
                SET status = 'Completed'
                WHERE order_id = $1
                AND status <> 'Completed'
                `,
                [req.params.id]
            );


            if (
                order.order_type ===
                "Dine-in" &&
                order.table_number
            ) {

                await client.query(
                    `
                    UPDATE restaurant_tables
                    SET status = 'Available'
                    WHERE table_number = $1
                    `,
                    [order.table_number]
                );

            }


            await client.query("COMMIT");


            res.json({
                success: true,
                order: result.rows[0]
            });

        } catch (e) {

            await client.query(
                "ROLLBACK"
            );

            res.status(400).json({
                error: e.message
            });

        } finally {

            client.release();

        }

    }
);


app.put(
    "/api/orders/:id/complete",
    async (req, res) => {

        try {

            const orderResult =
                await pool.query(
                    `
                    SELECT *
                    FROM orders
                    WHERE id = $1
                    `,
                    [req.params.id]
                );

            const order =
                orderResult.rows[0];


            if (!order) {

                return res.status(404).json({
                    error:
                        "Order not found"
                });

            }


            const result =
                await pool.query(
                    `
                    UPDATE orders
                    SET status = 'Completed'
                    WHERE id = $1
                    RETURNING *
                    `,
                    [req.params.id]
                );


            if (
                order.order_type ===
                "Dine-in" &&
                order.table_number
            ) {

                await pool.query(
                    `
                    UPDATE restaurant_tables
                    SET status = 'Available'
                    WHERE table_number = $1
                    `,
                    [order.table_number]
                );

            }


            res.json({
                success: true,
                order: result.rows[0]
            });

        } catch (e) {

            res.status(500).json({
                error:
                    "Failed to complete order"
            });

        }

    }
);

// =====================================================
// INVOICES
// =====================================================


// -----------------------------------------------------
// GET ALL INVOICES
// -----------------------------------------------------

app.get(
    "/api/invoices",
    async (_, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        i.*,
                        o.order_number,
                        o.order_type,
                        o.table_number
                    FROM invoices i

                    INNER JOIN orders o
                        ON o.id = i.order_id

                    ORDER BY
                        i.created_at DESC
                    `
                );

            res.json(
                result.rows
            );

        } catch (e) {

            console.error(
                "❌ Load invoices error:",
                e
            );

            res.status(500).json({
                error:
                    "Failed to load invoices"
            });

        }

    }
);


// -----------------------------------------------------
// GET INVOICE BY ID
// -----------------------------------------------------

app.get(
    "/api/invoices/:id",
    async (req, res) => {

        try {

            const invoiceResult =
                await pool.query(
                    `
                    SELECT
                        i.*,

                        o.order_number,
                        o.order_type,
                        o.table_number,

                        o.created_at AS order_created_at,

                        c.name AS customer_name,
                        c.phone AS customer_phone,
                        c.email AS customer_email

                    FROM invoices i

                    INNER JOIN orders o
                        ON o.id = i.order_id

                    LEFT JOIN customers c
                        ON c.id = i.customer_id

                    WHERE i.id = $1
                    `,
                    [req.params.id]
                );

            const invoice =
                invoiceResult.rows[0];

            if (!invoice) {

                return res.status(404).json({
                    error:
                        "Invoice not found"
                });

            }


            const items =
                (
                    await pool.query(
                        `
                        SELECT *
                        FROM order_items
                        WHERE order_id = $1
                        ORDER BY id
                        `,
                        [invoice.order_id]
                    )
                ).rows;


            res.json({
                invoice,
                items
            });

        } catch (e) {

            console.error(
                "❌ Load invoice error:",
                e
            );

            res.status(500).json({
                error:
                    "Failed to load invoice"
            });

        }

    }
);


// -----------------------------------------------------
// GET INVOICE BY ORDER ID
// -----------------------------------------------------

app.get(
    "/api/invoices/order/:orderId",
    async (req, res) => {

        try {

            const invoiceResult =
                await pool.query(
                    `
                    SELECT
                        i.*,

                        o.order_number,
                        o.order_type,
                        o.table_number,

                        o.created_at AS order_created_at

                    FROM invoices i

                    INNER JOIN orders o
                        ON o.id = i.order_id

                    WHERE i.order_id = $1
                    `,
                    [req.params.orderId]
                );

            const invoice =
                invoiceResult.rows[0];

            if (!invoice) {

                return res.status(404).json({
                    error:
                        "Invoice not found for this order"
                });

            }


            const items =
                (
                    await pool.query(
                        `
                        SELECT *
                        FROM order_items
                        WHERE order_id = $1
                        ORDER BY id
                        `,
                        [invoice.order_id]
                    )
                ).rows;


            res.json({
                invoice,
                items
            });

        } catch (e) {

            console.error(
                "❌ Load order invoice error:",
                e
            );

            res.status(500).json({
                error:
                    "Failed to load order invoice"
            });

        }

    }
);


// -----------------------------------------------------
// CREATE INVOICE
// -----------------------------------------------------

app.post(
    "/api/invoices",
    async (req, res) => {

        const orderId =
            Number(
                req.body.orderId ||
                req.body.order_id
            );

        const customerId =
            req.body.customerId ||
            req.body.customer_id ||
            null;


        if (
            !Number.isInteger(orderId) ||
            orderId <= 0
        ) {

            return res.status(400).json({
                error:
                    "Valid order ID is required"
            });

        }


        const client =
            await pool.connect();


        try {

            await client.query(
                "BEGIN"
            );


            // -----------------------------------------
            // LOCK ORDER
            // -----------------------------------------

            const orderResult =
                await client.query(
                    `
                    SELECT *
                    FROM orders
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [orderId]
                );

            const order =
                orderResult.rows[0];


            if (!order) {

                throw new Error(
                    "Order not found"
                );

            }


            // -----------------------------------------
            // PREVENT DUPLICATE INVOICE
            // -----------------------------------------

            const existingResult =
                await client.query(
                    `
                    SELECT *
                    FROM invoices
                    WHERE order_id = $1
                    FOR UPDATE
                    `,
                    [orderId]
                );

            if (
                existingResult.rows.length
            ) {

                await client.query(
                    "COMMIT"
                );

                return res.json({
                    success: true,

                    alreadyExists: true,

                    invoice:
                        existingResult.rows[0]
                });

            }


            // -----------------------------------------
            // OPTIONAL CUSTOMER VALIDATION
            // -----------------------------------------

            let validCustomerId = null;


            if (customerId !== null) {

                const parsedCustomerId =
                    Number(customerId);


                if (
                    !Number.isInteger(
                        parsedCustomerId
                    ) ||
                    parsedCustomerId <= 0
                ) {

                    throw new Error(
                        "Invalid customer ID"
                    );

                }


                const customerResult =
                    await client.query(
                        `
                        SELECT id
                        FROM customers
                        WHERE id = $1
                        `,
                        [parsedCustomerId]
                    );


                if (
                    !customerResult.rows.length
                ) {

                    throw new Error(
                        "Customer not found"
                    );

                }


                validCustomerId =
                    parsedCustomerId;

            }


            // -----------------------------------------
            // GENERATE INVOICE NUMBER
            // -----------------------------------------

            const sequenceResult =
                await client.query(
                    `
                    SELECT nextval(
                        'invoice_number_seq'
                    ) AS number
                    `
                );


            const sequenceNumber =
                Number(
                    sequenceResult.rows[0].number
                );


            const invoiceNumber =
                "INV-" +
                String(
                    sequenceNumber
                ).padStart(
                    6,
                    "0"
                );


            // -----------------------------------------
            // CREATE INVOICE
            // -----------------------------------------

            const invoiceResult =
                await client.query(
                    `
                    INSERT INTO invoices
                    (
                        invoice_number,
                        order_id,
                        customer_id,
                        invoice_date,
                        subtotal,
                        gst,
                        total,
                        payment_method,
                        status
                    )
                    VALUES
                    (
                        $1,
                        $2,
                        $3,
                        CURRENT_TIMESTAMP,
                        $4,
                        $5,
                        $6,
                        $7,
                        'Generated'
                    )
                    RETURNING *
                    `,
                    [
                        invoiceNumber,
                        order.id,
                        validCustomerId,
                        Number(order.subtotal),
                        Number(order.gst),
                        Number(order.total),
                        order.payment_method ||
                        null
                    ]
                );


            const invoice =
                invoiceResult.rows[0];


            await client.query(
                "COMMIT"
            );


            res.status(201).json({
                success: true,
                alreadyExists: false,
                invoice
            });

        } catch (e) {

            await client.query(
                "ROLLBACK"
            );


            console.error(
                "❌ Create invoice error:",
                e
            );


            res.status(400).json({
                error:
                    e.message
            });

        } finally {

            client.release();

        }

    }
);

// =====================================================
// RESERVATIONS
// =====================================================

app.get(
    "/api/reservations",
    async (_, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM reservations
                    ORDER BY
                        reservation_date ASC,
                        reservation_time ASC
                    `
                );

            res.json(result.rows);

        } catch (e) {

            res.status(500).json({
                error:
                    "Failed to load reservations"
            });

        }

    }
);


app.post(
    "/api/reservations",
    async (req, res) => {

        const b = req.body;

        const name =
            b.customerName ||
            b.customer_name;

        const phone =
            b.phone;

        const date =
            b.reservationDate ||
            b.reservation_date;

        const time =
            b.reservationTime ||
            b.reservation_time;

        const guests =
            Number(b.guests);

        const table =
            b.tableNumber ||
            b.table_number ||
            null;


        const client =
            await pool.connect();


        try {

            if (
                !name ||
                !phone ||
                !date ||
                !time ||
                !guests
            ) {

                throw new Error(
                    "Required reservation information is missing"
                );

            }


            await client.query("BEGIN");


            if (table) {

                const tableResult =
                    await client.query(
                        `
                        SELECT *
                        FROM restaurant_tables
                        WHERE table_number = $1
                        FOR UPDATE
                        `,
                        [table]
                    );


                const restaurantTable =
                    tableResult.rows[0];


                if (!restaurantTable) {

                    throw new Error(
                        "Selected table does not exist"
                    );

                }


                if (
                    restaurantTable.status !==
                    "Available"
                ) {

                    throw new Error(
                        "Selected table is not available"
                    );

                }


                const conflict =
                    await client.query(
                        `
                        SELECT 1
                        FROM reservations
                        WHERE table_number = $1
                        AND reservation_date = $2
                        AND reservation_time = $3
                        AND status IN
                            ('Reserved','Confirmed')
                        LIMIT 1
                        `,
                        [
                            table,
                            date,
                            time
                        ]
                    );


                if (conflict.rows.length) {

                    throw new Error(
                        "This table is already reserved for that date and time"
                    );

                }

            }


            const result =
                await client.query(
                    `
                    INSERT INTO reservations
                    (
                        customer_name,
                        phone,
                        reservation_date,
                        reservation_time,
                        guests,
                        table_number,
                        status,
                        notes
                    )
                    VALUES
                    ($1,$2,$3,$4,$5,$6,$7,$8)
                    RETURNING *
                    `,
                    [
                        name,
                        phone,
                        date,
                        time,
                        guests,
                        table,
                        b.status ||
                        "Reserved",
                        b.notes ||
                        null
                    ]
                );


            if (table) {

                await client.query(
                    `
                    UPDATE restaurant_tables
                    SET status = 'Reserved'
                    WHERE table_number = $1
                    `,
                    [table]
                );

            }


            await client.query("COMMIT");


            res.status(201).json({
                success: true,
                reservation:
                    result.rows[0]
            });

        } catch (e) {

            await client.query(
                "ROLLBACK"
            );

            res.status(400).json({
                error: e.message
            });

        } finally {

            client.release();

        }

    }
);


app.put(
    "/api/reservations/:id/status",
    async (req, res) => {

        const client =
            await pool.connect();

        try {

            await client.query("BEGIN");


            const reservationResult =
                await client.query(
                    `
                    SELECT *
                    FROM reservations
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [req.params.id]
                );


            const reservation =
                reservationResult.rows[0];


            if (!reservation) {

                throw new Error(
                    "Reservation not found"
                );

            }


            const allowed = [
                "Reserved",
                "Confirmed",
                "Arrived",
                "Cancelled",
                "Completed"
            ];


            if (
                !allowed.includes(
                    req.body.status
                )
            ) {

                throw new Error(
                    "Invalid reservation status"
                );

            }


            const status =
                req.body.status;


            const updated =
                (
                    await client.query(
                        `
                        UPDATE reservations
                        SET status = $1
                        WHERE id = $2
                        RETURNING *
                        `,
                        [
                            status,
                            req.params.id
                        ]
                    )
                ).rows[0];


            if (reservation.table_number) {

                if (
                    status === "Arrived"
                ) {

                    await client.query(
                        `
                        UPDATE restaurant_tables
                        SET status = 'Occupied'
                        WHERE table_number = $1
                        `,
                        [
                            reservation.table_number
                        ]
                    );

                } else if (
                    [
                        "Cancelled",
                        "Completed"
                    ].includes(status)
                ) {

                    await client.query(
                        `
                        UPDATE restaurant_tables
                        SET status = 'Available'
                        WHERE table_number = $1
                        `,
                        [
                            reservation.table_number
                        ]
                    );

                }

            }


            await client.query("COMMIT");


            res.json({
                success: true,
                reservation: updated
            });

        } catch (e) {

            await client.query(
                "ROLLBACK"
            );

            res.status(400).json({
                error: e.message
            });

        } finally {

            client.release();

        }

    }
);


// =====================================================
// KOT GROUPS
// =====================================================

app.get("/api/kot-groups", async (req,res)=>{
    try {
        const r=await pool.query(`SELECT * FROM kot_groups ORDER BY sort_order ASC, name ASC`);
        res.json(r.rows);
    } catch(e){res.status(500).json({error:"Failed to load KOT groups"});}
});
app.post("/api/kot-groups", async (req,res)=>{
    try {
        const name=String(req.body.name||"").trim();
        if(!name)return res.status(400).json({error:"KOT group name is required"});
        const r=await pool.query(`INSERT INTO kot_groups(name,description,station,sort_order,active) VALUES($1,$2,$3,$4,$5) RETURNING *`,[name,String(req.body.description||"").trim()||null,String(req.body.station||"Kitchen"),Number(req.body.sortOrder||0),req.body.active!==false]);
        res.status(201).json(r.rows[0]);
    }catch(e){if(e.code==="23505")return res.status(409).json({error:"KOT group already exists"});res.status(500).json({error:"Failed to create KOT group"});}
});
app.put("/api/kot-groups/:id", async (req,res)=>{
    try {
        const id=Number(req.params.id); if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:"Invalid KOT group ID"});
        const r=await pool.query(`UPDATE kot_groups SET name=$1,description=$2,station=$3,sort_order=$4,active=$5,updated_at=CURRENT_TIMESTAMP WHERE id=$6 RETURNING *`,[String(req.body.name||"").trim(),String(req.body.description||"").trim()||null,String(req.body.station||"Kitchen"),Number(req.body.sortOrder||0),req.body.active!==false,id]);
        if(!r.rows.length)return res.status(404).json({error:"KOT group not found"}); res.json(r.rows[0]);
    }catch(e){if(e.code==="23505")return res.status(409).json({error:"KOT group already exists"});res.status(500).json({error:"Failed to update KOT group"});}
});
app.delete("/api/kot-groups/:id", async (req,res)=>{
    try { const id=Number(req.params.id); const r=await pool.query(`DELETE FROM kot_groups WHERE id=$1 RETURNING id`,[id]); if(!r.rows.length)return res.status(404).json({error:"KOT group not found"}); res.json({success:true}); } catch(e){res.status(500).json({error:"Failed to delete KOT group"});}
});

// =====================================================
// KOT
// =====================================================

app.get(
    "/api/kot",
    async (req,res)=>{
        try {
            const range=req.query.range||"today";
            const dateRange=getReportDateRange(range,req.query.from,req.query.to);
            const result=await pool.query(`
                SELECT k.*,kg.name AS kot_group_name,kg.station AS kot_group_station,o.order_number,o.order_type,o.table_number
                FROM kot k JOIN orders o ON k.order_id=o.id
                LEFT JOIN kot_groups kg ON kg.id=k.kot_group_id
                WHERE k.created_at >= ${dateRange.start}
                  AND k.created_at < ${dateRange.end}
                ORDER BY k.created_at DESC
            `);
            res.json(result.rows);
        } catch(e){console.error("KOT load error:",e);res.status(500).json({error:"Failed to load KOT"});}
    }
);

// Update one KOT item's kitchen status. This is protected by the existing
// permission middleware as kitchen.edit. The UI advances an order's KOT
// items together, while the database keeps each KOT row independently tracked.
app.put(
    "/api/kot/:id",
    async (req,res)=>{
        try {
            const id=Number(req.params.id);
            const status=String(req.body?.status||"").trim();
            const allowed=["Pending","Preparing","Ready","Completed"];
            if(!Number.isInteger(id)||id<=0) return res.status(400).json({error:"Invalid KOT ID"});
            if(!allowed.includes(status)) return res.status(400).json({error:"Invalid KOT status"});

            const result=await pool.query(
                `UPDATE kot SET status=$1 WHERE id=$2 RETURNING *`,
                [status,id]
            );
            if(!result.rows.length) return res.status(404).json({error:"KOT not found"});

            res.json({success:true,kot:result.rows[0]});
        } catch(e){
            console.error("KOT update error:",e);
            res.status(500).json({error:"Failed to update KOT"});
        }
    }
);


// =====================================================
// PAYMENTS
// =====================================================

app.get(
    "/api/payments",
    async (_, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM payments
                    ORDER BY created_at DESC
                    `
                );

            res.json(result.rows);

        } catch (e) {

            res.status(500).json({
                error:
                    "Failed to load payments"
            });

        }

    }
);


app.post(
    "/api/payments",
    async (req, res) => {

        try {

            const b = req.body;

            const orderId =
                b.orderId ||
                b.order_id;

            const orderNumber =
                b.orderNumber ||
                b.order_number;

            const amount =
                Number(b.amount);

            const paymentMethod =
                b.paymentMethod ||
                b.payment_method;


            if (
                !orderId ||
                !orderNumber ||
                !Number.isFinite(amount) ||
                !paymentMethod
            ) {

                return res.status(400).json({
                    error:
                        "Payment information is incomplete"
                });

            }


            const result =
                await pool.query(
                    `
                    INSERT INTO payments
                    (
                        order_id,
                        order_number,
                        amount,
                        payment_method,
                        payment_status,
                        transaction_id
                    )
                    VALUES
                    ($1,$2,$3,$4,$5,$6)
                    RETURNING *
                    `,
                    [
                        orderId,
                        orderNumber,
                        amount,
                        paymentMethod,
                        b.paymentStatus ||
                        "Success",
                        b.transactionId ||
                        null
                    ]
                );


            if ((b.paymentStatus || "Success") === "Success") {
                await awardLoyaltyForPayment(result.rows[0].id, Number(orderId), amount);
            }

            res.status(201).json({
                success: true,
                payment:
                    result.rows[0]
            });

        } catch (e) {

            res.status(500).json({
                error:
                    "Failed to record payment"
            });

        }

    }
);


// =====================================================
// CUSTOMERS
// =====================================================

app.get(
    "/api/customers",
    async (_, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM customers
                    ORDER BY id DESC
                    `
                );

            res.json(result.rows);

        } catch (e) {

            res.status(500).json({
                error:
                    "Failed to load customers"
            });

        }

    }
);


app.post(
    "/api/customers",
    async (req, res) => {

        try {

            const {
                name,
                phone,
                email
            } = req.body;


            if (!name || !phone) {

                return res.status(400).json({
                    error:
                        "Name and phone are required"
                });

            }


            const result =
                await pool.query(
                    `
                    INSERT INTO customers
                    (
                        name,
                        phone,
                        email
                    )
                    VALUES
                    ($1,$2,$3)
                    RETURNING *
                    `,
                    [
                        name,
                        phone,
                        email || null
                    ]
                );


            res.status(201).json({
                success: true,
                customer:
                    result.rows[0]
            });

        } catch (e) {

            if (e.code === "23505") {

                return res.status(409).json({
                    error:
                        "Customer with this phone number already exists"
                });

            }


            res.status(500).json({
                error:
                    "Failed to add customer"
            });

        }

    }
);



// -----------------------------------------------------
// SAVE / UPDATE CUSTOMER FROM BILLING
// -----------------------------------------------------

app.post(
    "/api/customers/save-for-billing",
    async (req, res) => {

        try {

            const name = String(req.body.name || "").trim();
            const phone = String(req.body.phone || "").trim();
            const email = String(req.body.email || "").trim() || null;

            if (!name || !phone) {
                return res.status(400).json({
                    error: "Customer name and phone are required"
                });
            }

            const existing = await pool.query(
                `
                SELECT *
                FROM customers
                WHERE phone = $1
                LIMIT 1
                `,
                [phone]
            );

            if (existing.rows.length) {

                const updated = await pool.query(
                    `
                    UPDATE customers
                    SET name = $1,
                        email = $2
                    WHERE id = $3
                    RETURNING *
                    `,
                    [name, email, existing.rows[0].id]
                );

                return res.json({
                    success: true,
                    created: false,
                    customer: updated.rows[0]
                });
            }

            const created = await pool.query(
                `
                INSERT INTO customers
                (name, phone, email)
                VALUES ($1,$2,$3)
                RETURNING *
                `,
                [name, phone, email]
            );

            return res.status(201).json({
                success: true,
                created: true,
                customer: created.rows[0]
            });

        } catch (e) {

            console.error(
                "❌ Save billing customer error:",
                e
            );

            return res.status(500).json({
                error: "Failed to save customer"
            });
        }
    }
);


app.put(
    "/api/customers/:id",
    async (req, res) => {

        try {

            const {
                name,
                phone,
                email
            } = req.body;


            if (!name || !phone) {

                return res.status(400).json({
                    error:
                        "Name and phone are required"
                });

            }


            const result =
                await pool.query(
                    `
                    UPDATE customers
                    SET
                        name = $1,
                        phone = $2,
                        email = $3
                    WHERE id = $4
                    RETURNING *
                    `,
                    [
                        name,
                        phone,
                        email || null,
                        req.params.id
                    ]
                );


            if (!result.rows.length) {

                return res.status(404).json({
                    error:
                        "Customer not found"
                });

            }


            res.json({
                success: true,
                customer:
                    result.rows[0]
            });

        } catch (e) {

            if (e.code === "23505") {

                return res.status(409).json({
                    error:
                        "Customer with this phone number already exists"
                });

            }


            res.status(500).json({
                error:
                    "Failed to update customer"
            });

        }

    }
);


app.delete(
    "/api/customers/:id",
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    DELETE FROM customers
                    WHERE id = $1
                    RETURNING *
                    `,
                    [req.params.id]
                );


            if (!result.rows.length) {

                return res.status(404).json({
                    error:
                        "Customer not found"
                });

            }


            res.json({
                success: true,
                customer:
                    result.rows[0]
            });

        } catch (e) {

            res.status(500).json({
                error:
                    "Failed to delete customer"
            });

        }

    }
);


// =====================================================
// DASHBOARD
// =====================================================

app.get(
    "/api/dashboard/stats",
    async (_, res) => {

        try {

            const q =
                async sql =>
                    Number(
                        (
                            await pool.query(sql)
                        ).rows[0].value
                    );


            res.json({

                todaySales:
                    await q(
                        `
                        SELECT
                            COALESCE(
                                SUM(total),
                                0
                            ) value
                        FROM orders
                        WHERE
                            created_at::date =
                            CURRENT_DATE
                        AND status =
                            'Completed'
                        `
                    ),

                todayOrders:
                    await q(
                        `
                        SELECT
                            COUNT(*) value
                        FROM orders
                        WHERE
                            created_at::date =
                            CURRENT_DATE
                        `
                    ),

                pendingOrders:
                    await q(
                        `
                        SELECT
                            COUNT(*) value
                        FROM orders
                        WHERE status =
                            'Pending'
                        `
                    ),

                customers:
                    await q(
                        `
                        SELECT
                            COUNT(*) value
                        FROM customers
                        `
                    ),

                totalOrders:
                    await q(
                        `
                        SELECT
                            COUNT(*) value
                        FROM orders
                        `
                    ),

                totalRevenue:
                    await q(
                        `
                        SELECT
                            COALESCE(
                                SUM(total),
                                0
                            ) value
                        FROM orders
                        WHERE status =
                            'Completed'
                        `
                    )

            });

        } catch (e) {

            console.error(e);

            res.status(500).json({
                error:
                    "Failed to load dashboard statistics"
            });

        }

    }
);


// =====================================================
// REPORTS
// =====================================================


// -----------------------------------------------------
// REPORT DATE RANGE
// -----------------------------------------------------

function getReportDateRange(range, from, to) {

    // ==========================================
    // CUSTOM DATE RANGE
    // ==========================================

    if (range === "custom") {

        // Basic date format validation
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

        if (
            !dateRegex.test(from) ||
            !dateRegex.test(to)
        ) {
            throw new Error(
                "Invalid custom date range"
            );
        }

        // Make sure From date is not after To date
        if (from > to) {
            throw new Error(
                "From date cannot be after To date"
            );
        }

        return {
            start:
                `'${from}'::date`,

            end:
                `'${to}'::date + INTERVAL '1 day'`
        };
    }


    // ==========================================
    // PRESET DATE RANGES
    // ==========================================

    switch (range) {

        case "yesterday":

            return {
                start:
                    "CURRENT_DATE - INTERVAL '1 day'",

                end:
                    "CURRENT_DATE"
            };


        case "week":

            return {
                start:
                    "date_trunc('week', CURRENT_DATE)",

                end:
                    "date_trunc('week', CURRENT_DATE) + INTERVAL '1 week'"
            };


        case "month":

            return {
                start:
                    "date_trunc('month', CURRENT_DATE)",

                end:
                    "date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'"
            };


        case "today":

        default:

            return {
                start:
                    "CURRENT_DATE",

                end:
                    "CURRENT_DATE + INTERVAL '1 day'"
            };

    }

}

// -----------------------------------------------------
// REPORT SUMMARY
// -----------------------------------------------------

app.get(
    "/api/reports/summary",
    async (req, res) => {

        try {

            const range =
                req.query.range ||
                "today";

            const from =
                req.query.from;

            const to =
                req.query.to;

            const dateRange =
                getReportDateRange(
                    range,
                    from,
                    to
                );

            console.log(
                "📊 Summary range:",
                range
            );


            // -----------------------------------------
            // SALES + ORDERS
            // -----------------------------------------

            const salesResult =
                await pool.query(
                    `
                    SELECT

                        COALESCE(
                            SUM(amount),
                            0
                        ) AS total_sales,

                        COUNT(
                            DISTINCT order_id
                        ) AS total_orders,

                        COALESCE(
                            SUM(amount),
                            0
                        )
                        /
                        NULLIF(
                            COUNT(
                                DISTINCT order_id
                            ),
                            0
                        )
                        AS average_order

                    FROM payments

                    WHERE
                        payment_status =
                        'Success'

                    AND created_at >=
                        ${dateRange.start}

                    AND created_at <
                        ${dateRange.end}
                    `
                );


            // -----------------------------------------
            // ITEMS SOLD
            // -----------------------------------------

            const itemsResult =
                await pool.query(
                    `
                    SELECT

                        COALESCE(
                            SUM(
                                oi.quantity
                            ),
                            0
                        ) AS items_sold

                    FROM order_items oi

                    WHERE EXISTS (

                        SELECT 1

                        FROM payments p

                        WHERE
                            p.order_id =
                            oi.order_id

                        AND p.payment_status =
                            'Success'

                        AND p.created_at >=
                            ${dateRange.start}

                        AND p.created_at <
                            ${dateRange.end}

                    )
                    `
                );


            const sales =
                salesResult.rows[0];

            const items =
                itemsResult.rows[0];


            res.json({

                totalSales:
                    Number(
                        sales.total_sales || 0
                    ),

                totalOrders:
                    Number(
                        sales.total_orders || 0
                    ),

                averageOrder:
                    Number(
                        sales.average_order || 0
                    ),

                itemsSold:
                    Number(
                        items.items_sold || 0
                    )

            });

        } catch (error) {

            console.error(
                "❌ Reports summary error:",
                error
            );

            res.status(500).json({
                error:
                    "Failed to load report summary"
            });

        }

    }
);


// -----------------------------------------------------
// PAYMENT BREAKDOWN
// -----------------------------------------------------

app.get(
    "/api/reports/payments",
    async (req, res) => {

        try {

            const range =
                req.query.range ||
                "today";

            const from =
                req.query.from;

            const to =
                req.query.to;

            const dateRange =
                getReportDateRange(
                    range,
                    from,
                    to
                );

            console.log(
                "💳 Payment report range:",
                range
            );


            const result =
                await pool.query(
                    `
                    SELECT

                        payment_method,

                        COUNT(
                            DISTINCT order_id
                        ) AS orders,

                        COALESCE(
                            SUM(amount),
                            0
                        ) AS amount

                    FROM payments

                    WHERE
                        payment_status =
                        'Success'

                    AND created_at >=
                        ${dateRange.start}

                    AND created_at <
                        ${dateRange.end}

                    GROUP BY
                        payment_method

                    ORDER BY
                        amount DESC
                    `
                );


            res.json(
                result.rows
            );

        } catch (error) {

            console.error(
                "❌ Payment report error:",
                error
            );

            res.status(500).json({
                error:
                    "Failed to load payment report"
            });

        }

    }
);


// -----------------------------------------------------
// BEST SELLING ITEMS
// -----------------------------------------------------

app.get(
    "/api/reports/best-items",
    async (req, res) => {

        try {

            const range =
                req.query.range ||
                "today";

            const from =
                req.query.from;

            const to =
                req.query.to;

            const dateRange =
                getReportDateRange(
                    range,
                    from,
                    to
                );


            console.log(
                "🔥 Best items range:",
                range
            );


            const result =
                await pool.query(
                    `
                    SELECT

                        oi.item_name,

                        SUM(
                            oi.quantity
                        ) AS quantity_sold,

                        COALESCE(
                            SUM(
                                oi.line_total
                            ),
                            0
                        ) AS revenue

                    FROM order_items oi

                    WHERE EXISTS (

                        SELECT 1

                        FROM payments p

                        WHERE
                            p.order_id =
                            oi.order_id

                        AND p.payment_status =
                            'Success'

                        AND p.created_at >=
                            ${dateRange.start}

                        AND p.created_at <
                            ${dateRange.end}

                    )

                    GROUP BY
                        oi.item_name

                    ORDER BY
                        quantity_sold DESC,
                        revenue DESC

                    LIMIT 10
                    `
                );


            res.json(
                result.rows
            );

        } catch (error) {

            console.error(
                "❌ Best items report error:",
                error
            );

            res.status(500).json({
                error:
                    "Failed to load best selling items"
            });

        }

    }
);

// -----------------------------------------------------
// SALES BY CATEGORY
// -----------------------------------------------------

app.get(
    "/api/reports/category",
    async (req, res) => {

        try {

            const range =
                req.query.range ||
                "today";

            const from =
                req.query.from;

            const to =
                req.query.to;

            const dateRange =
                getReportDateRange(
                    range,
                    from,
                    to
                );


            console.log(
                "📊 Category report range:",
                range
            );


            const result =
                await pool.query(
                    `
                    SELECT

                        COALESCE(
                            m.category,
                            'Uncategorized'
                        ) AS category,

                        COALESCE(
                            SUM(oi.quantity),
                            0
                        ) AS quantity_sold,

                        COALESCE(
                            SUM(oi.line_total),
                            0
                        ) AS revenue

                    FROM order_items oi

                    LEFT JOIN menu m
                        ON m.id = oi.menu_id

                    WHERE EXISTS (

                        SELECT 1

                        FROM payments p

                        WHERE
                            p.order_id =
                            oi.order_id

                        AND p.payment_status =
                            'Success'

                        AND p.created_at >=
                            ${dateRange.start}

                        AND p.created_at <
                            ${dateRange.end}

                    )

                    GROUP BY
                        m.category

                    ORDER BY
                        revenue DESC
                    `
                );


            res.json(
                result.rows
            );


        } catch (error) {

            console.error(
                "❌ Category report error:",
                error
            );

            res.status(500).json({

                error:
                    "Failed to load category report"

            });

        }

    }
);

// -----------------------------------------------------
// SALES BY ORDER TYPE
// -----------------------------------------------------

app.get(
    "/api/reports/order-type",
    async (req, res) => {

        try {

            const range =
                req.query.range ||
                "today";

            const from =
                req.query.from;

            const to =
                req.query.to;

            const dateRange =
                getReportDateRange(
                    range,
                    from,
                    to
                );


            console.log(
                "🍽️ Order type report range:",
                range
            );


            const result =
                await pool.query(
                    `
                    SELECT

                        o.order_type,

                        COUNT(
                            DISTINCT o.id
                        ) AS orders,

                        COALESCE(
                            SUM(p.amount),
                            0
                        ) AS sales

                    FROM orders o

                    INNER JOIN payments p
                        ON p.order_id = o.id

                    WHERE
                        p.payment_status =
                        'Success'

                    AND p.created_at >=
                        ${dateRange.start}

                    AND p.created_at <
                        ${dateRange.end}

                    GROUP BY
                        o.order_type

                    ORDER BY
                        sales DESC
                    `
                );


            res.json(
                result.rows
            );


        } catch (error) {

            console.error(
                "❌ Order type report error:",
                error
            );


            res.status(500).json({

                error:
                    "Failed to load order type report"

            });

        }

    }
);

// -----------------------------------------------------
// DAILY SALES
// -----------------------------------------------------

app.get(
    "/api/reports/daily",
    async (req, res) => {

        try {

            const range =
                req.query.range ||
                "today";

            const from =
                req.query.from;

            const to =
                req.query.to;

            const dateRange =
                getReportDateRange(
                    range,
                    from,
                    to
                );


            console.log(
                "📅 Daily sales report range:",
                range
            );


            const result =
                await pool.query(
                    `
                    SELECT

                        DATE(p.created_at) AS sale_date,

                        COUNT(
                            DISTINCT p.order_id
                        ) AS orders,

                        COALESCE(
                            SUM(p.amount),
                            0
                        ) AS sales

                    FROM payments p

                    WHERE
                        p.payment_status =
                        'Success'

                    AND p.created_at >=
                        ${dateRange.start}

                    AND p.created_at <
                        ${dateRange.end}

                    GROUP BY
                        DATE(p.created_at)

                    ORDER BY
                        sale_date ASC
                    `
                );


            res.json(
                result.rows
            );


        } catch (error) {

            console.error(
                "❌ Daily sales report error:",
                error
            );


            res.status(500).json({

                error:
                    "Failed to load daily sales report"

            });

        }

    }
);

// -----------------------------------------------------
// GST / TAX REPORT
// -----------------------------------------------------

app.get(
    "/api/reports/gst",
    async (req, res) => {

        try {

            const range =
                req.query.range ||
                "today";

            const from =
                req.query.from;

            const to =
                req.query.to;

            const dateRange =
                getReportDateRange(
                    range,
                    from,
                    to
                );

            console.log(
                "🧾 GST report range:",
                range
            );

            const result =
                await pool.query(
                    `
                    SELECT

                        COUNT(
                            DISTINCT o.id
                        ) AS orders,

                        COALESCE(
                            SUM(o.subtotal),
                            0
                        ) AS taxable_sales,

                        COALESCE(
                            SUM(o.gst),
                            0
                        ) AS gst,

                        COALESCE(
                            SUM(o.total),
                            0
                        ) AS total_sales

                    FROM orders o

                    INNER JOIN payments p
                        ON p.order_id = o.id

                    WHERE
                        p.payment_status =
                        'Success'

                    AND p.created_at >=
                        ${dateRange.start}

                    AND p.created_at <
                        ${dateRange.end}
                    `
                );

            res.json(
                result.rows[0]
            );

        } catch (error) {

            console.error(
                "❌ GST report error:",
                error
            );

            res.status(500).json({

                error:
                    "Failed to load GST report"

            });

        }

    }
);


// =====================================================
// EXPENSES
// =====================================================
app.get('/api/expenses/categories', async (req,res)=>{
    try { res.json((await pool.query(`SELECT * FROM expense_categories WHERE active=true ORDER BY name`)).rows); }
    catch(e){ res.status(500).json({error:'Failed to load expense categories'}); }
});
app.post('/api/expenses/categories', async (req,res)=>{
    try {
        const name=String(req.body.name||'').trim(); if(!name) return res.status(400).json({error:'Category name is required'});
        const r=await pool.query(`INSERT INTO expense_categories(name) VALUES($1) RETURNING *`,[name]); res.status(201).json(r.rows[0]);
    } catch(e){ res.status(e.code==='23505'?409:500).json({error:e.code==='23505'?'Category already exists':'Failed to create category'}); }
});
app.get('/api/expenses', async (req,res)=>{
    try {
        const from=req.query.from||null, to=req.query.to||null;
        const r=await pool.query(`
            SELECT e.*, c.name AS category_name, u.display_name AS created_by_name
            FROM expenses e LEFT JOIN expense_categories c ON c.id=e.category_id LEFT JOIN app_users u ON u.id=e.created_by
            WHERE ($1::date IS NULL OR e.expense_date >= $1::date) AND ($2::date IS NULL OR e.expense_date <= $2::date)
            ORDER BY e.expense_date DESC, e.id DESC
        `,[from,to]); res.json(r.rows);
    } catch(e){ res.status(500).json({error:'Failed to load expenses'}); }
});
app.post('/api/expenses', async (req,res)=>{
    try {
        const amount=Number(req.body.amount); if(!Number.isFinite(amount)||amount<0) return res.status(400).json({error:'Invalid expense amount'});
        const r=await pool.query(`INSERT INTO expenses(category_id,amount,payment_method,expense_date,note,created_by) VALUES($1,$2,$3,COALESCE($4::date,CURRENT_DATE),$5,$6) RETURNING *`,[
            req.body.categoryId?Number(req.body.categoryId):null,amount,String(req.body.paymentMethod||'Cash'),req.body.expenseDate||null,req.body.note?String(req.body.note).slice(0,1000):null,req.user?.id||null]);
        res.status(201).json({success:true,expense:r.rows[0]});
    } catch(e){ console.error(e);res.status(500).json({error:'Failed to save expense'}); }
});
app.delete('/api/expenses/:id', async (req,res)=>{try{await pool.query(`DELETE FROM expenses WHERE id=$1`,[Number(req.params.id)]);res.json({success:true});}catch(e){res.status(500).json({error:'Failed to delete expense'});}});
app.get('/api/expenses/summary', async (req,res)=>{
    try {
        const from=req.query.from||null,to=req.query.to||null;
        const total=(await pool.query(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM expenses WHERE ($1::date IS NULL OR expense_date >= $1::date) AND ($2::date IS NULL OR expense_date <= $2::date)`,[from,to])).rows[0];
        const categories=(await pool.query(`SELECT COALESCE(c.name,'Uncategorised') category, COALESCE(SUM(e.amount),0) amount FROM expenses e LEFT JOIN expense_categories c ON c.id=e.category_id WHERE ($1::date IS NULL OR e.expense_date >= $1::date) AND ($2::date IS NULL OR e.expense_date <= $2::date) GROUP BY c.name ORDER BY amount DESC`,[from,to])).rows;
        res.json({total,count:Number(total.count||0),categories});
    } catch(e){res.status(500).json({error:'Failed to load expense summary'});}
});

// =====================================================
// LOYALTY
// =====================================================
app.get('/api/loyalty/settings', async (_,res)=>{try{res.json(await getLoyaltySettings());}catch(e){res.status(500).json({error:'Failed to load loyalty settings'});}});
app.put('/api/loyalty/settings', async (req,res)=>{try{
    const enabled=req.body.enabled!==false, ppc=Math.max(0,Number(req.body.pointsPerCurrency||1)), cpp=Math.max(0,Number(req.body.currencyPerPoint||1)), min=Math.max(0,Math.floor(Number(req.body.minRedeemPoints||100))), welcome=Math.max(0,Math.floor(Number(req.body.welcomePoints||0)));
    const r=await pool.query(`INSERT INTO loyalty_settings(id,points_per_currency,currency_per_point,min_redeem_points,welcome_points,enabled,updated_at) VALUES(1,$1,$2,$3,$4,$5,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET points_per_currency=EXCLUDED.points_per_currency,currency_per_point=EXCLUDED.currency_per_point,min_redeem_points=EXCLUDED.min_redeem_points,welcome_points=EXCLUDED.welcome_points,enabled=EXCLUDED.enabled,updated_at=CURRENT_TIMESTAMP RETURNING *`,[ppc,cpp,min,welcome,enabled]); res.json(r.rows[0]);
}catch(e){res.status(500).json({error:'Failed to save loyalty settings'});}});
app.get('/api/loyalty/customers/:customerId', async (req,res)=>{try{
    const customerId=Number(req.params.customerId); const customer=(await pool.query(`SELECT * FROM customers WHERE id=$1`,[customerId])).rows[0]; if(!customer) return res.status(404).json({error:'Customer not found'});
    const balance=(await pool.query(`SELECT COALESCE(SUM(points),0) points FROM loyalty_transactions WHERE customer_id=$1`,[customerId])).rows[0];
    const history=(await pool.query(`SELECT * FROM loyalty_transactions WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,[customerId])).rows;
    res.json({customer,balance:Number(balance.points||0),history});
}catch(e){res.status(500).json({error:'Failed to load loyalty history'});}});
app.post('/api/loyalty/adjust', async (req,res)=>{try{
    const customerId=Number(req.body.customerId), points=Math.trunc(Number(req.body.points||0)); if(!customerId||!points) return res.status(400).json({error:'Customer and non-zero points required'});
    const r=await pool.query(`INSERT INTO loyalty_transactions(customer_id,points,transaction_type,reference_type,note) VALUES($1,$2,'Adjustment','Manual',$3) RETURNING *`,[customerId,points,String(req.body.note||'Manual adjustment')]); res.status(201).json(r.rows[0]);
}catch(e){res.status(500).json({error:'Failed to adjust loyalty points'});}});

// =====================================================
// BILLING ADJUSTMENTS
// =====================================================

app.get("/api/billing-adjustments", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT *
            FROM billing_adjustments
            ORDER BY active DESC, name ASC, id ASC
        `);

        res.json(result.rows);
    } catch (e) {
        console.error("Load billing adjustments error:", e);
        res.status(500).json({
            error: "Failed to load billing adjustments"
        });
    }
});


app.post("/api/billing-adjustments", async (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        const type = ["discount", "charge"].includes(
            String(req.body.type || "").toLowerCase()
        )
            ? String(req.body.type).toLowerCase()
            : "discount";

        const valueType = ["amount", "percent"].includes(
            String(req.body.valueType || "").toLowerCase()
        )
            ? String(req.body.valueType).toLowerCase()
            : "amount";

        const value = Number(req.body.value);
        const appliesTo = ["all", "dine_in", "takeaway", "delivery"].includes(
            String(req.body.appliesTo || "").toLowerCase()
        )
            ? String(req.body.appliesTo).toLowerCase()
            : "all";

        const description =
            String(req.body.description || "").trim() || null;

        if (!name) {
            return res.status(400).json({
                error: "Adjustment name is required"
            });
        }

        if (!Number.isFinite(value) || value < 0) {
            return res.status(400).json({
                error: "Adjustment value must be a valid non-negative number"
            });
        }

        if (valueType === "percent" && value > 100) {
            return res.status(400).json({
                error: "Percentage cannot exceed 100"
            });
        }

        const result = await pool.query(`
            INSERT INTO billing_adjustments
            (
                name,
                type,
                value_type,
                value,
                applies_to,
                description,
                active
            )
            VALUES
            ($1,$2,$3,$4,$5,$6,TRUE)
            RETURNING *
        `, [
            name,
            type,
            valueType,
            value,
            appliesTo,
            description
        ]);

        res.status(201).json(result.rows[0]);

    } catch (e) {
        console.error("Create billing adjustment error:", e);

        if (e.code === "23505") {
            return res.status(409).json({
                error: "Billing adjustment already exists"
            });
        }

        res.status(500).json({
            error: "Failed to create billing adjustment"
        });
    }
});


app.put("/api/billing-adjustments/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                error: "Invalid adjustment ID"
            });
        }

        const name = String(req.body.name || "").trim();

        const type = ["discount", "charge"].includes(
            String(req.body.type || "").toLowerCase()
        )
            ? String(req.body.type).toLowerCase()
            : "discount";

        const valueType = ["amount", "percent"].includes(
            String(req.body.valueType || "").toLowerCase()
        )
            ? String(req.body.valueType).toLowerCase()
            : "amount";

        const value = Number(req.body.value);

        const appliesTo = ["all", "dine_in", "takeaway", "delivery"].includes(
            String(req.body.appliesTo || "").toLowerCase()
        )
            ? String(req.body.appliesTo).toLowerCase()
            : "all";

        const description =
            String(req.body.description || "").trim() || null;

        if (!name) {
            return res.status(400).json({
                error: "Adjustment name is required"
            });
        }

        if (!Number.isFinite(value) || value < 0) {
            return res.status(400).json({
                error: "Adjustment value must be a valid non-negative number"
            });
        }

        if (valueType === "percent" && value > 100) {
            return res.status(400).json({
                error: "Percentage cannot exceed 100"
            });
        }

        const result = await pool.query(`
            UPDATE billing_adjustments
            SET
                name = $1,
                type = $2,
                value_type = $3,
                value = $4,
                applies_to = $5,
                description = $6,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $7
            RETURNING *
        `, [
            name,
            type,
            valueType,
            value,
            appliesTo,
            description,
            id
        ]);

        if (!result.rows.length) {
            return res.status(404).json({
                error: "Billing adjustment not found"
            });
        }

        res.json(result.rows[0]);

    } catch (e) {
        console.error("Update billing adjustment error:", e);

        if (e.code === "23505") {
            return res.status(409).json({
                error: "Billing adjustment already exists"
            });
        }

        res.status(500).json({
            error: "Failed to update billing adjustment"
        });
    }
});


app.put("/api/billing-adjustments/:id/toggle", async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                error: "Invalid adjustment ID"
            });
        }

        const result = await pool.query(`
            UPDATE billing_adjustments
            SET
                active = NOT active,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *
        `, [id]);

        if (!result.rows.length) {
            return res.status(404).json({
                error: "Billing adjustment not found"
            });
        }

        res.json(result.rows[0]);

    } catch (e) {
        console.error("Toggle billing adjustment error:", e);
        res.status(500).json({
            error: "Failed to update billing adjustment"
        });
    }
});


app.delete("/api/billing-adjustments/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                error: "Invalid adjustment ID"
            });
        }

        const result = await pool.query(`
            DELETE FROM billing_adjustments
            WHERE id = $1
            RETURNING id
        `, [id]);

        if (!result.rows.length) {
            return res.status(404).json({
                error: "Billing adjustment not found"
            });
        }

        res.json({
            success: true
        });

    } catch (e) {
        console.error("Delete billing adjustment error:", e);
        res.status(500).json({
            error: "Failed to delete billing adjustment"
        });
    }
});

// =====================================================
// BACKUP / RESTORE
// =====================================================
app.get('/api/backup/health', async (_, res) => {
    const binary = resolvePgDumpBinary();
    const configured = Boolean(process.env.DB_USER && process.env.DB_NAME && process.env.DB_HOST);

    const pgDumpAvailable = await new Promise(resolve => {
        execFile(binary, ["--version"], {
            env: databaseEnv(),
            windowsHide: true,
            maxBuffer: 1024 * 1024
        }, err => resolve(!err));
    });

    res.json({
        database: process.env.DB_NAME || "",
        host: process.env.DB_HOST || "",
        pgDumpBinary: binary,
        pgDumpAvailable,
        ready: configured && pgDumpAvailable,
        node: process.version
    });
});

app.get("/api/backup/export", async (req, res) => {
    const binary = resolvePgDumpBinary();

    const args = [
        "--format=plain",
        "--no-owner",
        "--no-privileges",
        "--host",
        String(process.env.DB_HOST || "localhost"),
        "--port",
        String(process.env.DB_PORT || 5432),
        "--username",
        String(process.env.DB_USER || ""),
        String(process.env.DB_NAME || "")
    ];

    console.log("Starting database backup with:", binary);

    runPgDump(args, databaseEnv(), (err, stdout, stderr) => {
        if (err) {
            const detail = String(stderr || err.message || "Unknown pg_dump error").trim();
            console.error("❌ Backup failed:", detail);
            return res.status(500).json({ error: `Backup failed: ${detail}` });
        }

        res.setHeader("Content-Type", "application/sql;charset=utf-8");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="cafe-pos-backup-${new Date().toISOString().slice(0, 10)}.sql"`
        );
        res.send(stdout);
    });
});

app.post('/api/backup/restore', async (req,res)=>{
    try {
        const sql=String(req.body.sql||''); if(!sql.trim()) return res.status(400).json({error:'Backup SQL is empty'}); if(sql.length>25*1024*1024) return res.status(413).json({error:'Backup exceeds 25MB restore limit'});
        const temp=path.join(os.tmpdir(),`cafe-pos-restore-${Date.now()}.sql`); fs.writeFileSync(temp,sql,'utf8');
        const args=['--no-owner','--no-privileges','--host',String(process.env.DB_HOST||'localhost'),'--port',String(process.env.DB_PORT||5432),'--username',String(process.env.DB_USER||''),String(process.env.DB_NAME||'')];
        await new Promise((resolve,reject)=>execFile(process.env.PSQL_PATH||'psql',args,{env:databaseEnv(),maxBuffer:5*1024*1024},(err,stdout,stderr)=>err?reject(new Error(stderr||err.message)):resolve(stdout)));
        fs.unlinkSync(temp); res.json({success:true});
    } catch(e){console.error('Restore failed:',e);res.status(500).json({error:'Restore failed: '+e.message});}
});

// =====================================================
// ADVANCED REPORTS
// =====================================================
app.get('/api/reports/advanced', async (req, res) => {
    try {
        const range = req.query.range || "month";
        const dr = getReportDateRange(
            range,
            req.query.from,
            req.query.to
        );

        const warnings = [];

        let hourly = [];
        let weekday = [];
        let customers = [];
        let cancelled = [];
        let expenseTotal = 0;

        // -----------------------------------------
        // HOURLY SALES
        // -----------------------------------------
        try {
            const result = await pool.query(`
                SELECT
                    EXTRACT(HOUR FROM p.created_at)::int AS hour,
                    COUNT(DISTINCT p.order_id)::int AS orders,
                    COALESCE(SUM(p.amount), 0) AS sales
                FROM payments p
                WHERE p.payment_status = 'Success'
                  AND p.created_at >= ${dr.start}
                  AND p.created_at < ${dr.end}
                GROUP BY EXTRACT(HOUR FROM p.created_at)
                ORDER BY hour
            `);

            hourly = result.rows;
        } catch (e) {
            console.error("Advanced report hourly error:", e);
            warnings.push("Hourly sales unavailable");
        }

        // -----------------------------------------
        // WEEKDAY SALES
        // -----------------------------------------
        try {
            const result = await pool.query(`
                SELECT
                    TO_CHAR(p.created_at, 'Dy') AS day,
                    EXTRACT(ISODOW FROM p.created_at)::int AS day_no,
                    COUNT(DISTINCT p.order_id)::int AS orders,
                    COALESCE(SUM(p.amount), 0) AS sales
                FROM payments p
                WHERE p.payment_status = 'Success'
                  AND p.created_at >= ${dr.start}
                  AND p.created_at < ${dr.end}
                GROUP BY
                    TO_CHAR(p.created_at, 'Dy'),
                    EXTRACT(ISODOW FROM p.created_at)
                ORDER BY day_no
            `);

            weekday = result.rows;
        } catch (e) {
            console.error("Advanced report weekday error:", e);
            warnings.push("Weekday sales unavailable");
        }

        // -----------------------------------------
        // TOP CUSTOMERS
        // -----------------------------------------
        try {
            const result = await pool.query(`
                SELECT
                    COALESCE(c.name, 'Walk-in') AS customer,
                    COUNT(DISTINCT o.id)::int AS orders,
                    COALESCE(SUM(o.total), 0) AS sales
                FROM orders o
                LEFT JOIN customers c
                    ON c.id = o.customer_id
                INNER JOIN payments p
                    ON p.order_id = o.id
                   AND p.payment_status = 'Success'
                WHERE p.created_at >= ${dr.start}
                  AND p.created_at < ${dr.end}
                GROUP BY c.name
                ORDER BY sales DESC
                LIMIT 20
            `);

            customers = result.rows;
        } catch (e) {
            console.error("Advanced report customers error:", e);
            warnings.push("Top customers unavailable");
        }

        // -----------------------------------------
        // CANCELLED ORDERS
        // -----------------------------------------
        try {
            const result = await pool.query(`
                SELECT
                    DATE(o.created_at) AS date,
                    COUNT(*)::int AS orders,
                    COALESCE(SUM(o.total), 0) AS value
                FROM orders o
                WHERE o.status = 'Cancelled'
                  AND o.created_at >= ${dr.start}
                  AND o.created_at < ${dr.end}
                GROUP BY DATE(o.created_at)
                ORDER BY date DESC
            `);

            cancelled = result.rows;
        } catch (e) {
            console.error("Advanced report cancelled error:", e);
            warnings.push("Cancelled orders unavailable");
        }

        // -----------------------------------------
        // EXPENSE TOTAL
        // -----------------------------------------
        try {
            const result = await pool.query(`
                SELECT
                    COALESCE(SUM(amount), 0) AS amount
                FROM expenses
                WHERE expense_date >= (${dr.start})::date
                  AND expense_date < (${dr.end})::date
            `);

            expenseTotal = Number(
                result.rows[0]?.amount || 0
            );
        } catch (e) {
            console.error("Advanced report expense error:", e);
            warnings.push("Expense total unavailable");
        }

        res.json({
            hourly,
            weekday,
            customers,
            cancelled,
            expenseTotal,
            warnings
        });

    } catch (e) {
        console.error("❌ Advanced report fatal error:", e);

        res.status(500).json({
            error: "Failed to load advanced reports",
            detail: e.message
        });
    }
});
// =====================================================
// DEPLOYMENT / HEALTH
// =====================================================
app.get('/api/system/health', async (_,res)=>{
    try { await pool.query('SELECT 1'); res.json({ok:true,serverTime:new Date().toISOString(),node:process.version,environment:process.env.NODE_ENV||'development',database:process.env.DB_NAME||''}); }
    catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.get('/api/system/deployment-check', async (_,res)=>{
    const checks=[];
    checks.push({key:'database',label:'PostgreSQL configuration',ok:Boolean(process.env.DB_USER&&process.env.DB_NAME&&process.env.DB_HOST)});
    try{await pool.query('SELECT 1');checks.push({key:'dbConnection',label:'Database connection',ok:true});}catch(e){checks.push({key:'dbConnection',label:'Database connection',ok:false,detail:e.message});}
    checks.push({key:'node',label:'Node.js runtime',ok:parseInt(process.versions.node.split('.')[0],10)>=18,detail:process.version});
    checks.push({key:'pgDump',label:'pg_dump backup utility',ok:await new Promise(resolve=>execFile(process.env.PG_DUMP_PATH||'pg_dump',['--version'],{env:databaseEnv()},err=>resolve(!err)))});
    res.json({checks,env:{NODE_ENV:process.env.NODE_ENV||'development',PORT:PORT,DB_HOST:process.env.DB_HOST||'',DB_NAME:process.env.DB_NAME||''}});
});

// =====================================================
// ACCESS / USERS / ROLES / PERMISSIONS
// =====================================================

const ACCESS_MODULES_SERVER = [
    "dashboard", "orders", "new_order", "reservations", "tables",
    "kitchen", "menu", "customers", "payments", "reports", "settings", "access", "expenses", "loyalty", "backup", "invoice_designer", "advanced_reports", "deployment"
];
const ACCESS_ACTIONS_SERVER = ["view", "create", "edit", "delete", "export", "print"];

function defaultPermissionsServer() {
    const p = {};
    for (const moduleKey of ACCESS_MODULES_SERVER) {
        for (const action of ACCESS_ACTIONS_SERVER) {
            p[`${moduleKey}.${action}`] = false;
        }
    }
    p["dashboard.view"] = true;
    return p;
}

function allPermissionsServer() {
    const p = defaultPermissionsServer();
    for (const key of Object.keys(p)) p[key] = true;
    return p;
}

function managerPermissionsServer() {
    const p = defaultPermissionsServer();
    const allow = [
        "dashboard.view", "orders.view", "orders.print", "new_order.view", "new_order.create",
        "new_order.edit", "reservations.view", "reservations.create", "reservations.edit",
        "tables.view", "tables.edit", "kitchen.view", "kitchen.edit", "kitchen.print", "kot_groups.view", "kot_groups.create", "kot_groups.edit",
        "menu.view", "menu.create", "menu.edit", "customers.view", "customers.create", "customers.edit",
        "payments.view", "payments.print", "reports.view", "reports.export"
    ];
    allow.forEach(k => p[k] = true);
    return p;
}

async function ensureAccessTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS access_profiles (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL UNIQUE,
            description TEXT,
            permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS app_users (
            id SERIAL PRIMARY KEY,
            display_name VARCHAR(150) NOT NULL,
            username VARCHAR(100) NOT NULL UNIQUE,
            password_hash TEXT,
            profile_id INTEGER REFERENCES access_profiles(id) ON DELETE SET NULL,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_hash TEXT`);

    const adminProfile = await pool.query(`SELECT id FROM access_profiles WHERE name = 'Admin' LIMIT 1`);
    let adminProfileId = adminProfile.rows[0]?.id;
    if (!adminProfileId) {
        const r = await pool.query(`INSERT INTO access_profiles (name, description, permissions) VALUES ('Admin','Full system access',$1::jsonb) RETURNING id`, [JSON.stringify(allPermissionsServer())]);
        adminProfileId = r.rows[0].id;
    }
    const managerProfile = await pool.query(`SELECT id FROM access_profiles WHERE name = 'Manager' LIMIT 1`);
    let managerProfileId = managerProfile.rows[0]?.id;
    if (!managerProfileId) {
        const r = await pool.query(`INSERT INTO access_profiles (name, description, permissions) VALUES ('Manager','Operational access without full administration',$1::jsonb) RETURNING id`, [JSON.stringify(managerPermissionsServer())]);
        managerProfileId = r.rows[0].id;
    }
    const cashierPermissions = defaultPermissionsServer();
    ["dashboard.view","new_order.view","new_order.create","customers.view","customers.create","payments.view","payments.create","orders.view","kitchen.view","kitchen.print"].forEach(k=>cashierPermissions[k]=true);
    const cashierProfile = await pool.query(`SELECT id FROM access_profiles WHERE name = 'Cashier' LIMIT 1`);
    let cashierProfileId = cashierProfile.rows[0]?.id;
    if (!cashierProfileId) {
        const r = await pool.query(`INSERT INTO access_profiles (name, description, permissions) VALUES ('Cashier','Counter and cashier access',$1::jsonb) RETURNING id`, [JSON.stringify(cashierPermissions)]);
        cashierProfileId = r.rows[0].id;
    }
    // Backfill the new KOT Groups permissions for the built-in Manager profile without touching custom roles.
    await pool.query(`UPDATE access_profiles SET permissions = permissions || jsonb_build_object(
        'kot_groups.view', true, 'kot_groups.create', true, 'kot_groups.edit', true
    ), updated_at=CURRENT_TIMESTAMP WHERE name='Manager'`);

    const seeds = [
        ['Administrator','admin',adminProfileId,'admin123'],
        ['Manager','manager',managerProfileId,'manager123'],
        ['Cashier','cashier',cashierProfileId,'cashier123']
    ];
    for (const [displayName,username,profileId,password] of seeds) {
        await pool.query(`INSERT INTO app_users (display_name,username,password_hash,profile_id,active) VALUES ($1,$2,$3,$4,TRUE) ON CONFLICT (username) DO UPDATE SET profile_id=EXCLUDED.profile_id,active=TRUE,password_hash=COALESCE(app_users.password_hash,EXCLUDED.password_hash),updated_at=CURRENT_TIMESTAMP`, [displayName,username,hashPassword(password),profileId]);
    }
    console.log("✅ Access tables ready");
}

app.get("/api/access", async (_, res) => {
    try {
        const [users, profiles] = await Promise.all([
            pool.query(`
                SELECT u.id, u.display_name, u.username, u.profile_id, u.active, u.created_at,
                       p.name AS profile_name
                FROM app_users u
                LEFT JOIN access_profiles p ON p.id = u.profile_id
                ORDER BY u.id
            `),
            pool.query(`SELECT id, name, description, permissions, created_at, updated_at FROM access_profiles ORDER BY name`)
        ]);
        res.json({ users: users.rows, profiles: profiles.rows });
    } catch (e) {
        console.error("Access load error:", e);
        res.status(500).json({ error: "Failed to load access data" });
    }
});

app.get("/api/access/profiles", async (_, res) => {
    try {
        const result = await pool.query(`SELECT id, name, description, permissions, created_at, updated_at FROM access_profiles ORDER BY name`);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: "Failed to load access profiles" });
    }
});

app.post("/api/access/profiles", async (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        const description = String(req.body.description || "").trim();
        const permissions = req.body.permissions && typeof req.body.permissions === "object" ? req.body.permissions : defaultPermissionsServer();
        if (!name) return res.status(400).json({ error: "Profile name is required" });
        const result = await pool.query(
            `INSERT INTO access_profiles (name, description, permissions) VALUES ($1,$2,$3::jsonb) RETURNING *`,
            [name, description || null, JSON.stringify(permissions)]
        );
        res.status(201).json({ success: true, profile: result.rows[0] });
    } catch (e) {
        if (e.code === "23505") return res.status(409).json({ error: "An access profile with this name already exists" });
        res.status(500).json({ error: "Failed to create access profile" });
    }
});

app.put("/api/access/profiles/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid profile ID" });
        const current = await pool.query(`SELECT name FROM access_profiles WHERE id=$1`, [id]);
        if (!current.rows.length) return res.status(404).json({ error: "Access profile not found" });
        const name = String(req.body.name ?? current.rows[0].name).trim();
        const description = String(req.body.description ?? "").trim();
        const permissions = req.body.permissions && typeof req.body.permissions === "object" ? req.body.permissions : defaultPermissionsServer();
        if (!name) return res.status(400).json({ error: "Profile name is required" });
        const result = await pool.query(
            `UPDATE access_profiles SET name=$1, description=$2, permissions=$3::jsonb, updated_at=CURRENT_TIMESTAMP WHERE id=$4 RETURNING *`,
            [name, description || null, JSON.stringify(permissions), id]
        );
        res.json({ success: true, profile: result.rows[0] });
    } catch (e) {
        if (e.code === "23505") return res.status(409).json({ error: "An access profile with this name already exists" });
        res.status(500).json({ error: "Failed to update access profile" });
    }
});

app.delete("/api/access/profiles/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        const profile = await pool.query(`SELECT name FROM access_profiles WHERE id=$1`, [id]);
        if (!profile.rows.length) return res.status(404).json({ error: "Access profile not found" });
        if (profile.rows[0].name === "Admin") return res.status(400).json({ error: "The Admin profile cannot be deleted" });
        await pool.query(`DELETE FROM access_profiles WHERE id=$1`, [id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to delete access profile" });
    }
});

app.get("/api/access/users", async (_, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.display_name, u.username, u.profile_id, u.active, u.created_at,
                   p.name AS profile_name
            FROM app_users u
            LEFT JOIN access_profiles p ON p.id=u.profile_id
            ORDER BY u.id
        `);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: "Failed to load users" });
    }
});

app.post("/api/access/users", async (req, res) => {
    try {
        const displayName = String(req.body.displayName || "").trim();
        const username = String(req.body.username || "").trim();
        const profileId = req.body.profileId === null || req.body.profileId === undefined || req.body.profileId === "" ? null : Number(req.body.profileId);
        const active = req.body.active !== false;
        const password = String(req.body.password || "");
        if (!displayName || !username) return res.status(400).json({ error: "Display name and username are required" });
        if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
        if (profileId !== null && (!Number.isInteger(profileId) || profileId <= 0)) return res.status(400).json({ error: "Invalid access profile" });
        const result = await pool.query(
            `INSERT INTO app_users (display_name, username, password_hash, profile_id, active) VALUES ($1,$2,$3,$4,$5) RETURNING id,display_name,username,profile_id,active,created_at,updated_at`,
            [displayName, username, hashPassword(password), profileId, active]
        );
        res.status(201).json({ success: true, user: result.rows[0] });
    } catch (e) {
        if (e.code === "23505") return res.status(409).json({ error: "A user with this username already exists" });
        res.status(500).json({ error: "Failed to create user" });
    }
});

app.put("/api/access/users/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid user ID" });
        const current = await pool.query(`SELECT * FROM app_users WHERE id=$1`, [id]);
        if (!current.rows.length) return res.status(404).json({ error: "User not found" });
        const old = current.rows[0];
        const displayName = req.body.displayName === undefined ? old.display_name : String(req.body.displayName).trim();
        const username = req.body.username === undefined ? old.username : String(req.body.username).trim();
        const profileId = req.body.profileId === undefined ? old.profile_id : (req.body.profileId === null || req.body.profileId === "" ? null : Number(req.body.profileId));
        const active = req.body.active === undefined ? old.active : Boolean(req.body.active);
        const password = String(req.body.password || "");
        if (!displayName || !username) return res.status(400).json({ error: "Display name and username are required" });
        if (password && password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
        const result = await pool.query(
            password
                ? `UPDATE app_users SET display_name=$1, username=$2, password_hash=$3, profile_id=$4, active=$5, updated_at=CURRENT_TIMESTAMP WHERE id=$6 RETURNING id,display_name,username,profile_id,active,created_at,updated_at`
                : `UPDATE app_users SET display_name=$1, username=$2, profile_id=$3, active=$4, updated_at=CURRENT_TIMESTAMP WHERE id=$5 RETURNING id,display_name,username,profile_id,active,created_at,updated_at`,
            password ? [displayName,username,hashPassword(password),profileId,active,id] : [displayName,username,profileId,active,id]
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (e) {
        if (e.code === "23505") return res.status(409).json({ error: "A user with this username already exists" });
        res.status(500).json({ error: "Failed to update user" });
    }
});

app.delete("/api/access/users/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        const user = await pool.query(`SELECT username FROM app_users WHERE id=$1`, [id]);
        if (!user.rows.length) return res.status(404).json({ error: "User not found" });
        if (user.rows[0].username === "admin") return res.status(400).json({ error: "The admin user cannot be deleted" });
        await pool.query(`DELETE FROM app_users WHERE id=$1`, [id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to delete user" });
    }
});

// =====================================================
// APPLICATION SETTINGS
// =====================================================

async function ensureSettingsTable() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
            id INTEGER PRIMARY KEY,
            settings JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        INSERT INTO app_settings (id, settings)
        VALUES (1, '{}'::jsonb)
        ON CONFLICT (id) DO NOTHING
    `);

    console.log("✅ Application settings ready");
}

app.get(
    "/api/settings",
    async (_, res) => {
        try {
            const result = await pool.query(
                "SELECT settings FROM app_settings WHERE id = 1"
            );
            res.json(result.rows[0]?.settings || {});
        } catch (e) {
            console.error("❌ Settings load error:", e);
            res.status(500).json({ error: "Failed to load settings" });
        }
    }
);

app.put(
    "/api/settings",
    async (req, res) => {
        try {
            const settings = req.body && typeof req.body === "object"
                ? req.body
                : {};

            const result = await pool.query(
                `
                INSERT INTO app_settings (id, settings, updated_at)
                VALUES (1, $1::jsonb, CURRENT_TIMESTAMP)
                ON CONFLICT (id) DO UPDATE
                SET settings = EXCLUDED.settings,
                    updated_at = CURRENT_TIMESTAMP
                RETURNING settings, updated_at
                `,
                [JSON.stringify(settings)]
            );

            res.json({
                success: true,
                settings: result.rows[0].settings,
                updated_at: result.rows[0].updated_at
            });
        } catch (e) {
            console.error("❌ Settings save error:", e);
            res.status(500).json({ error: "Failed to save settings" });
        }
    }
);

// =====================================================
// START SERVER
// =====================================================

async function startServer() {

    try {

        await ensureInvoiceTables();
        await ensureSettingsTable();
        await ensureAccessTables();
        await ensureBusinessTable();
        await ensureBusinessTables();
        await ensureSessionTable();

        app.listen(
            PORT,
            () =>
                console.log(
                    `🚀 Cafe POS server running on http://localhost:${PORT}`
                )
        );

    } catch (error) {

        console.error(
            "❌ Failed to initialize database:",
            error
        );

        process.exit(1);

    }

}

startServer();