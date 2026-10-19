require("dotenv").config();

const fs = require("fs");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const crypto = require("crypto");
const QRCode = require("qrcode");
const os = require("os");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const net = require("net");

const app = express();
// Trust only the single Vercel proxy hop so rate limits use the visitor IP.
app.set("trust proxy", process.env.VERCEL ? 1 : false);
const PORT = Number(process.env.PORT || 3000);

function getLocalNetworkMenuUrl() {
    const candidates = [];
    const interfaces = os.networkInterfaces() || {};
    for (const [name, addresses] of Object.entries(interfaces)) {
        if (/(virtual|vEthernet|docker|wsl|vmware|virtualbox|loopback|vpn)/i.test(name)) continue;
        for (const item of addresses || []) {
            if (item.internal || (item.family !== "IPv4" && item.family !== 4)) continue;
            const parts = String(item.address || "").split(".").map(Number);
            if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) continue;
            const [a, b] = parts;
            const isPrivate = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
            if (!isPrivate) continue;
            const priority = /(wi-?fi|wireless|wlan|ethernet)/i.test(name) ? 0 : 1;
            candidates.push({ address: item.address, priority });
        }
    }
    candidates.sort((left, right) => left.priority - right.priority);
    return candidates.length ? `http://${candidates[0].address}:${PORT}` : null;
}




// =====================================================
// MIDDLEWARE
// =====================================================

const corsAllowedOrigins = new Set([
    "https://cafe-pos-six-gamma.vercel.app",
    "https://cafe-pos-pos-cafe.vercel.app",
    "cafe-pos://app",
    "https://localhost",
    "http://localhost",
    "capacitor://localhost",
    ...String(process.env.CORS_ALLOWED_ORIGINS || "").split(",").map(origin => origin.trim()).filter(Boolean)
]);
app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, false);
        return callback(null, corsAllowedOrigins.has(origin) ? origin : false);
    },
    credentials: true
}));
const publicRateLimitBuckets = new Map();
const loginLockoutFallback = new Map();
let persistentPublicRateLimitAvailable = false;
let persistentLoginLockoutAvailable = false;
function createPublicRateLimiter(scope, windowMs, limit) {
    return async (req, res, next) => {
        const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
        const key = crypto.createHash('sha256').update(scope + ':' + ip).digest('hex');
        if (persistentPublicRateLimitAvailable) {
            try {
                const result = await rawPoolQuery(`
                    INSERT INTO api_rate_limits(bucket_key,scope,window_started_at,hit_count)
                    VALUES($1,$2,CURRENT_TIMESTAMP,1)
                    ON CONFLICT(bucket_key) DO UPDATE SET
                        window_started_at=CASE
                            WHEN api_rate_limits.window_started_at <= CURRENT_TIMESTAMP - ($3::double precision * INTERVAL '1 millisecond') THEN CURRENT_TIMESTAMP
                            ELSE api_rate_limits.window_started_at
                        END,
                        hit_count=CASE
                            WHEN api_rate_limits.window_started_at <= CURRENT_TIMESTAMP - ($3::double precision * INTERVAL '1 millisecond') THEN 1
                            ELSE api_rate_limits.hit_count+1
                        END
                    RETURNING hit_count,window_started_at
                `, [key, scope, windowMs]);
                const bucket = result.rows[0];
                if (Number(bucket.hit_count) > limit) {
                    const resetAt = new Date(bucket.window_started_at).getTime() + windowMs;
                    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))));
                    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
                }
                return next();
            } catch (error) {
                persistentPublicRateLimitAvailable = false;
                console.warn('Persistent rate limit unavailable; using process-local fallback:', error.message);
            }
        }
        const now = Date.now();
        const fallbackKey = scope + ':' + ip;
        let bucket = publicRateLimitBuckets.get(fallbackKey);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            publicRateLimitBuckets.set(fallbackKey, bucket);
        }
        bucket.count += 1;
        if (publicRateLimitBuckets.size > 50000) {
            for (const [entryKey, entry] of publicRateLimitBuckets) if (entry.resetAt <= now) publicRateLimitBuckets.delete(entryKey);
        }
        if (bucket.count > limit) {
            res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
            return res.status(429).json({ error: 'Too many requests. Please try again later.' });
        }
        return next();
    };
}
const publicRateLimiters = {
    login: createPublicRateLimiter('login', 15 * 60 * 1000, 10),
    supportLogin: createPublicRateLimiter('support-login', 15 * 60 * 1000, 5),
    registration: createPublicRateLimiter('registration', 60 * 60 * 1000, 5),
    qrOrder: createPublicRateLimiter('qr-order', 10 * 60 * 1000, 20),
    qrCustomer: createPublicRateLimiter('qr-customer', 10 * 60 * 1000, 10),
    qrTracking: createPublicRateLimiter('qr-tracking', 60 * 1000, 60),
    deviceRegistration: createPublicRateLimiter('device-registration', 60 * 60 * 1000, 10)
};
const publicRateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of publicRateLimitBuckets) if (bucket.resetAt <= now) publicRateLimitBuckets.delete(key);
    for (const [key, bucket] of loginLockoutFallback) if (bucket.lockedUntil <= now && bucket.windowStartedAt <= now - 15 * 60 * 1000) loginLockoutFallback.delete(key);
    rawPoolQuery("DELETE FROM api_rate_limits WHERE window_started_at < CURRENT_TIMESTAMP - INTERVAL '2 days'").catch(() => {});
    rawPoolQuery("DELETE FROM auth_login_attempts WHERE updated_at < CURRENT_TIMESTAMP - INTERVAL '30 days'").catch(() => {});
}, 5 * 60 * 1000);
publicRateLimitCleanup.unref?.();
app.use((req, res, next) => {
    const method = req.method.toUpperCase();
    const route = req.path;
    let limiter = null;
    if (method === 'POST' && route === '/api/auth/login') limiter = publicRateLimiters.login;
    else if (method === 'POST' && route === '/api/support/login') limiter = publicRateLimiters.supportLogin;
    else if (method === 'POST' && route === '/api/public/register-business') limiter = publicRateLimiters.registration;
    else if (method === 'POST' && route === '/api/public/device/register') limiter = publicRateLimiters.deviceRegistration;
    else if (method === 'POST' && /^\/public-menu\/[a-f0-9]{48}\/orders$/i.test(route)) limiter = publicRateLimiters.qrOrder;
    else if (method === 'POST' && /^\/public-menu\/[a-f0-9]{48}\/customers$/i.test(route)) limiter = publicRateLimiters.qrCustomer;
    else if (method === 'GET' && /^\/public-menu\/[a-f0-9]{48}\/orders\/\d+$/i.test(route)) limiter = publicRateLimiters.qrTracking;
    return limiter ? limiter(req, res, next) : next();
});
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: wss: http://127.0.0.1:18181 http://localhost:18181; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    next();
});
const standardJsonParser = express.json({ limit: "100kb" });
const menuImportJsonParser = express.json({ limit: "25mb" });
const businessLogoJsonParser = express.json({ limit: "1mb" });
app.use((req, res, next) => {
    const parser = req.path === "/api/menu/import"
        ? menuImportJsonParser
        : req.path === "/api/business/profile/logo"
            ? businessLogoJsonParser
            : standardJsonParser;
    parser(req, res, next);
});
app.use(express.static(path.join(__dirname, "public")));


// =====================================================
// POSTGRESQL
// =====================================================

const poolOptions = {
    max: Number(process.env.DB_POOL_MAX || (process.env.VERCEL ? 2 : 10)),
    min: 0,
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 8000),
    allowExitOnIdle: true
};

function loadDatabaseSslCa() {
    const certificatePath = String(process.env.DATABASE_SSL_CA_FILE || "").trim();
    if (certificatePath) {
        try {
            return fs.readFileSync(path.resolve(certificatePath), "utf8");
        } catch (error) {
            throw new Error(`Unable to read DATABASE_SSL_CA_FILE: ${error.message}`);
        }
    }
    const certificate = String(process.env.DATABASE_SSL_CA || "").trim();
    return certificate ? certificate.replace(/\\n/g, "\n") : undefined;
}

const databaseSslCa = loadDatabaseSslCa();
const poolConfig = process.env.DATABASE_URL
    ? {
        ...poolOptions,
        connectionString: process.env.DATABASE_URL,
        ssl: {
            ...(databaseSslCa ? { ca: databaseSslCa } : {}),
            rejectUnauthorized: true
        }
    }
    : {
        ...poolOptions,
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT
    };

const pool = new Pool(poolConfig);

// =====================================================
// MULTI-BUSINESS TENANT CONTEXT (PHASE 2A)
// =====================================================
const tenantContext = new AsyncLocalStorage();
let tenantSystemMode = false;
let systemBusinessId = null;

const rawPoolConnect = pool.connect.bind(pool);

const rawPoolQuery = async function (text, values) {
    const client = await rawPoolConnect();
    try {
        return await client.query(text, values);
    } finally {
        client.release();
    }
};

function tenantDatabaseContext(store = tenantContext.getStore()) {
    const requestBusinessId = store?.businessId ? Number(store.businessId) : null;
    const requestSystemMode = store?.systemMode === true;
    const effectiveSystemMode = requestSystemMode || tenantSystemMode;
    const effectiveBusinessId = requestBusinessId || (effectiveSystemMode ? Number(systemBusinessId || 0) : null);
    return {
        businessId: effectiveBusinessId ? String(effectiveBusinessId) : '',
        systemMode: effectiveSystemMode ? 'on' : 'off'
    };
}

async function applyTenantDbContext(client, store = tenantContext.getStore()) {
    const context = tenantDatabaseContext(store);
    await client.query(
        "SELECT set_config('app.business_id', $1, true), set_config('app.system_mode', $2, true)",
        [context.businessId, context.systemMode]
    );
}

function queryCommand(query) {
    const sql = typeof query === 'string' ? query : String(query?.text || '');
    return sql.trim().match(/^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK)\b/i)?.[1]?.toUpperCase() || '';
}

function wrapTenantAwareClient(client, store) {
    const rawQuery = client.query.bind(client);
    const rawRelease = client.release.bind(client);
    let transactionOpen = false;

    client.query = async (...args) => {
        const sql = typeof args[0] === 'string' ? args[0] : String(args[0]?.text || '');
        const command = queryCommand(args[0]);
        if (command === 'BEGIN' || command.startsWith('START')) {
            const result = await rawQuery(...args);
            transactionOpen = true;
            await applyTenantDbContext({ query: (...contextArgs) => rawQuery(...contextArgs) }, store);
            return result;
        }
        if ((command === 'COMMIT' || command === 'END' || command === 'ROLLBACK') && !/^ROLLBACK\s+TO\b/i.test(sql)) {
            const result = await rawQuery(...args);
            transactionOpen = false;
            return result;
        }
        if (transactionOpen) return rawQuery(...args);

        await rawQuery('BEGIN');
        transactionOpen = true;
        try {
            await applyTenantDbContext({ query: (...contextArgs) => rawQuery(...contextArgs) }, store);
            const result = await rawQuery(...args);
            await rawQuery('COMMIT');
            transactionOpen = false;
            return result;
        } catch (error) {
            try { await rawQuery('ROLLBACK'); } catch (_) {}
            transactionOpen = false;
            throw error;
        }
    };

    client.release = error => {
        if (!transactionOpen) return rawRelease(error);
        transactionOpen = false;
        rawQuery('ROLLBACK').then(() => rawRelease(error), () => rawRelease(error || new Error('Could not roll back tenant transaction')));
    };
    return client;
}

function runSystemContext(fn) {
    return tenantContext.run({ systemMode: true }, fn);
}

pool.query = async function (text, values) {
    const client = await rawPoolConnect();
    try {
        await client.query('BEGIN');
        await applyTenantDbContext(client);
        const result = await client.query(text, values);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
};

pool.connect = async function () {
    const client = await rawPoolConnect();
    return wrapTenantAwareClient(client, tenantContext.getStore());
};

pool.on("connect", client => {
    // Keep an error listener on checked-out clients too. node-postgres removes
    // its idle-client listener while a client is checked out, so a dropped
    // socket could otherwise emit an unhandled EventEmitter error and crash
    // the POS process even when the query itself is caught by its caller.
    client.on("error", error => {
        console.error("❌ PostgreSQL client connection error:", error.message);
    });
    console.log("✅ PostgreSQL connected");
});

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
function hashSessionToken(token) {
    return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

async function ensureSessionTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS app_sessions (
            token VARCHAR(128) PRIMARY KEY,
            token_hash VARCHAR(64),
            user_id INTEGER NOT NULL,
            business_id INTEGER,
            device_id VARCHAR(128),
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS business_id INTEGER`);
    await pool.query(`ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS device_id VARCHAR(128)`);
    await pool.query(`ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS token_hash VARCHAR(64)`);

    const legacySessions = await pool.query(`SELECT token FROM app_sessions WHERE token_hash IS NULL`);
    for (const row of legacySessions.rows) {
        const tokenHash = hashSessionToken(row.token);
        await pool.query(`UPDATE app_sessions SET token=$1,token_hash=$1 WHERE token=$2`, [tokenHash, row.token]);
    }
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_app_sessions_token_hash ON app_sessions(token_hash)`);
    await pool.query(`ALTER TABLE app_sessions ALTER COLUMN token_hash SET NOT NULL`);

    await pool.query(`DELETE FROM app_sessions older USING app_sessions newer WHERE older.user_id=newer.user_id AND (older.created_at<newer.created_at OR (older.created_at=newer.created_at AND older.token<newer.token))`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_app_sessions_one_per_user ON app_sessions(user_id)`);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_app_sessions_expires_at
        ON app_sessions(expires_at)
    `);

    await pool.query(`DROP INDEX IF EXISTS idx_app_sessions_user_id`);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_app_sessions_device_id
        ON app_sessions(device_id)
    `);
}

function derivePasswordHash(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(String(password), salt, 64, (error, key) => error ? reject(error) : resolve(key));
    });
}

async function hashPassword(password) {
    const value = String(password);
    if (value.length > 1024) throw new Error("Password must be 1024 characters or fewer");
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = (await derivePasswordHash(value, salt)).toString("hex");
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

async function verifyPassword(password, stored) {
    if (!stored || !String(stored).includes(":")) return false;
    const [salt, expectedHex] = String(stored).split(":");
    try {
        const a = await derivePasswordHash(password, salt);
        const b = Buffer.from(expectedHex, "hex");
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (_) { return false; }
}

function loginIdentityKey(scope, businessId, username) {
    return crypto.createHash("sha256").update(`${scope}:${Number(businessId) || 0}:${String(username || "").trim().toLowerCase()}`).digest("hex");
}

async function ensureLoginAttemptTable() {
    await rawPoolQuery(`CREATE TABLE IF NOT EXISTS api_rate_limits (
        bucket_key VARCHAR(64) PRIMARY KEY,
        scope VARCHAR(80) NOT NULL,
        window_started_at TIMESTAMPTZ NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0
    )`);
    await rawPoolQuery(`CREATE TABLE IF NOT EXISTS auth_login_attempts (
        identity_key CHAR(64) PRIMARY KEY,
        window_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        failure_count INTEGER NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await rawPoolQuery(`CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_updated_at ON auth_login_attempts(updated_at)`);
    persistentPublicRateLimitAvailable = true;
    persistentLoginLockoutAvailable = true;
}

async function getLoginLockout(identityKey) {
    if (!persistentLoginLockoutAvailable) {
        const bucket = loginLockoutFallback.get(identityKey);
        return bucket && bucket.lockedUntil > Date.now() ? bucket.lockedUntil : 0;
    }
    try {
        const result = await rawPoolQuery(`SELECT locked_until FROM auth_login_attempts WHERE identity_key=$1`, [identityKey]);
        const lockedUntil = result.rows[0]?.locked_until ? new Date(result.rows[0].locked_until).getTime() : 0;
        return lockedUntil > Date.now() ? lockedUntil : 0;
    } catch (error) {
        persistentLoginLockoutAvailable = false;
        console.warn("Persistent login lockout unavailable:", error.message);
        const bucket = loginLockoutFallback.get(identityKey);
        return bucket && bucket.lockedUntil > Date.now() ? bucket.lockedUntil : 0;
    }
}

async function recordFailedLogin(identityKey) {
    if (!persistentLoginLockoutAvailable) return recordFailedLoginLocally(identityKey);
    try {
        const result = await rawPoolQuery(`
            INSERT INTO auth_login_attempts(identity_key,window_started_at,failure_count,locked_until,updated_at)
            VALUES($1,CURRENT_TIMESTAMP,1,NULL,CURRENT_TIMESTAMP)
            ON CONFLICT(identity_key) DO UPDATE SET
                failure_count=CASE
                    WHEN auth_login_attempts.window_started_at <= CURRENT_TIMESTAMP - INTERVAL '15 minutes' THEN 1
                    ELSE auth_login_attempts.failure_count+1
                END,
                window_started_at=CASE
                    WHEN auth_login_attempts.window_started_at <= CURRENT_TIMESTAMP - INTERVAL '15 minutes' THEN CURRENT_TIMESTAMP
                    ELSE auth_login_attempts.window_started_at
                END,
                locked_until=CASE
                    WHEN (CASE WHEN auth_login_attempts.window_started_at <= CURRENT_TIMESTAMP - INTERVAL '15 minutes' THEN 1 ELSE auth_login_attempts.failure_count+1 END) >= 5
                        THEN CURRENT_TIMESTAMP + INTERVAL '15 minutes'
                    ELSE NULL
                END,
                updated_at=CURRENT_TIMESTAMP
            RETURNING locked_until
        `, [identityKey]);
        const lockedUntil = result.rows[0]?.locked_until ? new Date(result.rows[0].locked_until).getTime() : 0;
        return lockedUntil > Date.now() ? lockedUntil : 0;
    } catch (error) {
        persistentLoginLockoutAvailable = false;
        console.warn("Persistent login lockout unavailable:", error.message);
        return recordFailedLoginLocally(identityKey);
    }
}

function recordFailedLoginLocally(identityKey) {
    const now = Date.now();
    const bucket = loginLockoutFallback.get(identityKey);
    const next = !bucket || bucket.windowStartedAt <= now - 15 * 60 * 1000
        ? { windowStartedAt: now, failureCount: 1, lockedUntil: 0 }
        : { ...bucket, failureCount: bucket.failureCount + 1 };
    if (next.failureCount >= 5) next.lockedUntil = now + 15 * 60 * 1000;
    loginLockoutFallback.set(identityKey, next);
    return next.lockedUntil > now ? next.lockedUntil : 0;
}

async function clearLoginFailures(identityKey) {
    loginLockoutFallback.delete(identityKey);
    if (!persistentLoginLockoutAvailable) return;
    try { await rawPoolQuery(`DELETE FROM auth_login_attempts WHERE identity_key=$1`, [identityKey]); }
    catch (error) { persistentLoginLockoutAvailable = false; console.warn("Could not clear login failure state:", error.message); }
}

async function createSession(user, device) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const businessId = Number(user.business_id || 0) || null;
    const deviceId = device?.device_id ? String(device.device_id) : null;

    await pool.query(
        `
        INSERT INTO app_sessions (token, token_hash, user_id, business_id, device_id, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (user_id) DO UPDATE SET token=EXCLUDED.token, token_hash=EXCLUDED.token_hash, business_id=EXCLUDED.business_id, device_id=EXCLUDED.device_id, expires_at=EXCLUDED.expires_at, created_at=CURRENT_TIMESTAMP
        `,
        [hashSessionToken(token), hashSessionToken(token), user.id, businessId, deviceId, expiresAt]
    );

    return {
        token,
        userId: user.id,
        businessId,
        deviceId,
        expiresAt: expiresAt.getTime()
    };
}

function getCookie(req, name) {
    const header = String(req.headers.cookie || "");
    for (const part of header.split(";")) {
        const idx = part.indexOf("=");
        if (idx < 0) continue;
        const key = part.slice(0, idx).trim();
        if (key !== name) continue;
        return decodeURIComponent(part.slice(idx + 1).trim());
    }
    return null;
}

function setCookie(res, name, value, options = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path || "/"}`];
    if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
    if (options.httpOnly !== false) parts.push("HttpOnly");
    if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
    if (options.secure !== false && (process.env.NODE_ENV === "production" || options.sameSite === "None")) parts.push("Secure");
    res.append("Set-Cookie", parts.join("; "));
}

function clearCookie(res, name) {
    setCookie(res, name, "", { maxAge: 0, httpOnly: true, sameSite: "None", secure: true });
}

async function getSessionUser(req) {
    const auth = String(req.headers.authorization || "");
    let token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token) token = getCookie(req, "cafe_session") || "";
    if (!token) return null;

    const result = await pool.query(
        `
        SELECT token, user_id, business_id, device_id, expires_at
        FROM app_sessions
        WHERE token_hash = $1
        LIMIT 1
        `,
        [hashSessionToken(token)]
    );

    const session = result.rows[0];
    if (!session) return null;

    const expiresAt = new Date(session.expires_at).getTime();
    if (expiresAt < Date.now()) {
        await pool.query(`DELETE FROM app_sessions WHERE token_hash = $1`, [hashSessionToken(token)]);
        return null;
    }

    return {
        token,
        userId: session.user_id,
        businessId: session.business_id,
        deviceId: session.device_id,
        expiresAt
    };
}

async function loadSessionUser(session) {
    const businessId = Number(session.businessId || 0);
    if (!businessId) return null;

    return tenantContext.run({ businessId }, async () => {
        const result = await pool.query(`
            SELECT u.id, u.display_name, u.username, u.profile_id, u.business_id, u.active,u.permissions_override,
                   u.is_owner,
                   b.business_name, b.business_type, b.owner_name, b.phone AS business_phone,
                   b.email AS business_email, b.address AS business_address, b.city, b.state, b.gstin,
                   b.logo_url, b.currency, b.active AS business_active,
                   p.name AS profile_name, COALESCE(u.permissions_override, p.permissions, '{}'::jsonb) AS permissions
            FROM app_users u
            LEFT JOIN businesses b ON b.id = u.business_id
            LEFT JOIN access_profiles p ON p.id = u.profile_id AND p.business_id = u.business_id
            WHERE u.id = $1 AND u.business_id = $2
        `, [session.userId, businessId]);
        const user = result.rows[0];
        return user && user.active ? user : null;
    });
}

async function getRegisteredDevice(deviceId) {
    if (!deviceId) return null;
    const result = await runSystemContext(() => pool.query(`
        SELECT d.*, row_to_json(l) AS license_data
        FROM registered_devices d
        LEFT JOIN business_licenses l ON l.id = d.license_id
        WHERE d.device_id = $1
        LIMIT 1
    `, [deviceId]));
    return result.rows[0] || null;
}

async function getEffectiveLicense(businessId) {
    const result = await runSystemContext(() => pool.query(`
        SELECT * FROM business_licenses
        WHERE business_id = $1
        ORDER BY id DESC
        LIMIT 1
    `, [Number(businessId)]));
    const license = result.rows[0] || null;
    if (!license) return null;

    const now = Date.now();
    const starts = new Date(license.starts_at).getTime();
    const expires = new Date(license.expires_at).getTime();

    if (license.status === "active" && expires < now) {
        await runSystemContext(() => pool.query(`UPDATE business_licenses SET status='expired', updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [license.id]));
        license.status = "expired";
    }

    if (license.status !== "active") return license;
    if (starts > now || expires < now) return license;
    return license;
}

const SUPPORT_LICENSE_TYPES = ['Trial', 'Sales'];

const SUPPORT_LICENSE_ADDONS = ["Marketing", "Table QR"];

function parseSupportLicenseAddons(value) {
    const source = Array.isArray(value) ? value : String(value || "").split(/[;,]/);
    const selected = new Set();
    for (const entry of source) {
        const normalized = String(entry || "").trim().toLowerCase();
        const canonical = SUPPORT_LICENSE_ADDONS.find(addOn => addOn.toLowerCase() === normalized);
        if (canonical) selected.add(canonical);
        else if (normalized && normalized !== "none") {
            throw Object.assign(new Error(`Unknown license add-on: ${String(entry).slice(0, 60)}`), { status: 400 });
        }
    }
    return SUPPORT_LICENSE_ADDONS.filter(addOn => selected.has(addOn));
}

function normalizeSupportLicenseSelection(licenseTypeInput, addOnInput, fallbackType = "Sales", fallbackAddOn = null) {
    const rawType = String(licenseTypeInput === undefined ? fallbackType : licenseTypeInput || fallbackType).trim();
    const legacyMarketing = rawType.toLowerCase() === "marketing";
    const licenseType = legacyMarketing ? "Sales" : rawType;
    const rawAddons = addOnInput === undefined ? (legacyMarketing ? ["Marketing"] : fallbackAddOn) : addOnInput;
    const addOns = parseSupportLicenseAddons(rawAddons);
    return { licenseType, addOn: addOns.length ? addOns.join(", ") : null };
}

function licenseHasAddon(license, addon) {
    try { return parseSupportLicenseAddons(license?.add_on).includes(addon); }
    catch (_) { return false; }
}

async function businessHasLicenseAddon(businessId, addon) {
    const result = await runSystemContext(() => pool.query(
        `SELECT add_on FROM business_licenses WHERE business_id=$1 AND status='active'
            AND starts_at<=CURRENT_TIMESTAMP AND expires_at>=CURRENT_TIMESTAMP
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [Number(businessId)]
    ));
    return licenseHasAddon(result.rows[0], addon);
}

function normalizeSupportLicenseTerm(licenseTypeInput, durationInput, fallbackPlan = 'Sales', fallbackDuration = null) {
    const rawType = licenseTypeInput === undefined ? fallbackPlan : licenseTypeInput;
    const normalized = String(rawType || 'Sales').trim().toLowerCase();
    const licenseType = SUPPORT_LICENSE_TYPES.find(type => type.toLowerCase() === normalized);
    if (!licenseType) throw Object.assign(new Error('License type must be Trial or Sales'), { status: 400 });

    const allowedDurations = licenseType === 'Trial' ? [1] : [3, 6, 12];
    const durationMonths = Number(durationInput === undefined || durationInput === null || durationInput === ''
        ? (fallbackDuration || (licenseType === 'Trial' ? 1 : 12))
        : durationInput);
    if (!allowedDurations.includes(durationMonths)) {
        throw Object.assign(new Error(licenseType === 'Trial'
            ? 'Trial licenses are valid for 1 month'
            : 'Sales licenses must be valid for 3, 6, or 12 months'), { status: 400 });
    }
    return { licenseType, durationMonths };
}

function addUtcMonthsClamped(date, months) {
    const result = new Date(date.getTime());
    const day = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
    result.setUTCDate(Math.min(day, lastDay));
    return result;
}

async function assertActiveDeviceAndLicense(deviceId, expectedBusinessId = null) {
    const device = await getRegisteredDevice(deviceId);
    if (!device) throw Object.assign(new Error("Device is not registered"), { code: "DEVICE_NOT_REGISTERED" });
    if (device.status !== "active") throw Object.assign(new Error("Device registration has been revoked"), { code: "DEVICE_REVOKED" });
    if (expectedBusinessId && Number(device.business_id) !== Number(expectedBusinessId)) {
        throw Object.assign(new Error("Device is registered to a different business"), { code: "DEVICE_BUSINESS_MISMATCH" });
    }

    let license = device.license_data || null;
    if (!license) throw Object.assign(new Error("No license is assigned to this business"), { code: "LICENSE_MISSING" });

    const now = Date.now();
    const starts = new Date(license.starts_at).getTime();
    const expires = new Date(license.expires_at).getTime();

    if (license.status === "active" && expires < now) {
        await runSystemContext(() => pool.query(
            `UPDATE business_licenses SET status='expired', updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
            [license.id]
        ));
        license = { ...license, status: "expired" };
    }

    if (license.status !== "active") throw Object.assign(new Error(`Business license is ${license.status}`), { code: "LICENSE_INACTIVE" });
    if (starts > now) throw Object.assign(new Error("Business license has not started yet"), { code: "LICENSE_NOT_STARTED" });
    if (expires < now) throw Object.assign(new Error("Business license has expired"), { code: "LICENSE_EXPIRED" });

    if (!device.last_seen_at || Date.now() - new Date(device.last_seen_at).getTime() > 60000) {
        await runSystemContext(() => pool.query(`UPDATE registered_devices SET last_seen_at=CURRENT_TIMESTAMP WHERE id=$1`, [device.id]));
    }
    delete device.license_data;
    return { device, license };
}

function permissionForRequest(req) {
    const path = req.path;
    const method = req.method.toUpperCase();
    if (path.startsWith('/auth/')) return null;
    if (path === '/dashboard/stats') return 'dashboard.view';
    if (path === '/reports/advanced') return req.query?.export === '1' ? 'advanced_reports.export' : 'advanced_reports.view';
    if (path === '/reports/order-categories') return req.query?.export === '1' ? 'reports.export' : 'reports.view';
    if (path === '/reports/sales-summary') return req.query?.export === '1' ? 'reports.export' : 'reports.view';
    if (path === '/customers' && req.query?.export === '1') return 'customers.export';
    if (path.startsWith('/reports/')) return 'reports.view';
    if (path === '/settings') return method === 'GET' ? 'settings.view' : 'settings.edit';
    if (path === '/business/profile/logo') return method === 'PUT' ? 'settings.edit' : 'settings.view';
    if (path === '/settings/sales-channels') return method === 'GET' ? 'settings.view' : 'settings.edit';
    if (path === '/menu-option-sets') return method === 'GET' ? 'menu.view' : 'menu.edit';
    if (path === '/billing-adjustments' || path.startsWith('/billing-adjustments/')) return method === 'GET' ? 'settings.view' : 'settings.edit';
    if (path.startsWith('/system/')) return 'deployment.view';
    if (path === '/license/status') return 'settings.view';
    if (path === '/printers' || path.startsWith('/printers/')) {
        if (path.endsWith('/test') || path.endsWith('/print')) return req.query?.source === 'kot' ? 'kitchen.print' : req.query?.source === 'order' ? 'orders.print_open' : 'printer.print';
        if (method === 'GET') return req.query?.source === 'order' ? 'orders.print_open' : 'printer.view';
        if (method === 'POST') return 'printer.create';
        if (['PUT','PATCH'].includes(method)) return 'printer.edit';
        if (method === 'DELETE') return 'printer.delete';
    }
    if (path === '/access' || path.startsWith('/access/')) {
        if (method === 'GET') return 'access.view';
        if (method === 'POST') return 'access.create';
        if (['PUT','PATCH'].includes(method)) return 'access.edit';
        if (method === 'DELETE') return 'access.delete';
    }
    const groups = [
        ['marketing','marketing'], ['kot-groups','kot_groups'], ['expenses','expenses'], ['loyalty','loyalty'],
        ['advanced-reports','advanced_reports'], ['deployment','deployment'], ['menu','menu'], ['customers','customers'],
        ['tables','tables'], ['devices','devices'], ['reservations','reservations'], ['kot','kitchen'], ['payments','payments'], ['invoices','payments']
    ];
    for (const [prefix,module] of groups) {
        if (path === '/' + prefix || path.startsWith('/' + prefix + '/')) {
            if (module === 'kitchen') {
                if (req.query?.print === '1') return 'kitchen.print';
                if (method === 'GET' && req.query?.orderId !== undefined) return 'orders.view';
                if (method === 'GET' && req.query?.range === 'all' && req.user?.permissions?.['orders.print_open'] === true) return 'orders.print_open';
                return method === 'GET' ? 'kitchen.view' : 'kitchen.edit';
            }
            if (method === 'GET') return module + '.view';
            if (method === 'POST') return module + '.create';
            if (['PUT','PATCH'].includes(method)) return module + '.edit';
            if (method === 'DELETE') return module + '.delete';
        }
    }
    if (path.endsWith('/payment-summary')) return 'payments.view';
    if (/^\/orders\/\d+\/settle$/.test(path) && method === 'POST') return 'payments.create';
    if (/^\/orders\/\d+\/qr-status$/.test(path) && method === 'PUT') return 'kitchen.edit';
    if (path === '/orders' || path.startsWith('/orders/')) {
        if (/^\/orders\/\d+\/cancel$/.test(path) && method === 'PUT') return 'orders.cancel';
        if (/^\/orders\/\d+\/printed$/.test(path)) return 'orders.print_open';
        if (/^\/orders\/\d+\/kot$/.test(path)) return 'kitchen.print';
        if (method === 'GET') return 'orders.view';
        if (method === 'POST') return 'new_order.create';
        if (['PUT','PATCH'].includes(method)) return /^\/orders\/\d+$/.test(path) ? 'orders.edit_open' : 'orders.edit';
        if (method === 'DELETE') return 'orders.delete';
    }
    return null;
}
async function requireAuth(req, res, next) {
    try {
        if (req.path === "/public/device/register" || req.path.startsWith("/support/")) return next();
        const authHeader = String(req.headers.authorization || "");
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : (getCookie(req, "cafe_session") || "");
        if (!token) return res.status(401).json({ error: "Authentication required" });

        // Resolve authentication context in one indexed query instead of three serial lookups.
        const result = await runSystemContext(() => pool.query(`
            WITH device_activity AS (
                UPDATE registered_devices
                SET last_seen_at=CURRENT_TIMESTAMP
                WHERE device_id=(SELECT device_id FROM app_sessions WHERE token_hash=$1 AND expires_at>CURRENT_TIMESTAMP LIMIT 1)
                  AND (last_seen_at IS NULL OR last_seen_at < CURRENT_TIMESTAMP - INTERVAL '1 minute')
                RETURNING id
            )
            SELECT s.token_hash AS token, s.user_id, s.business_id, s.device_id, s.expires_at,
                   u.id, u.display_name, u.username, u.profile_id, u.business_id AS user_business_id,
                   u.active, u.permissions_override, u.is_owner,
                   b.business_name, b.business_type, b.owner_name, b.phone AS business_phone,
                   b.email AS business_email, b.address AS business_address, b.city, b.state, b.gstin,
                   b.currency, b.active AS business_active,
                   p.name AS profile_name, COALESCE(u.permissions_override, p.permissions, '{}'::jsonb) AS permissions,
                   row_to_json(d) AS device_data, row_to_json(l) AS license_data
            FROM app_sessions s
            JOIN app_users u ON u.id=s.user_id AND u.business_id=s.business_id
            LEFT JOIN businesses b ON b.id=u.business_id
            LEFT JOIN access_profiles p ON p.id=u.profile_id AND p.business_id=u.business_id
            LEFT JOIN registered_devices d ON d.device_id=s.device_id
            LEFT JOIN business_licenses l ON l.id=d.license_id
            CROSS JOIN (SELECT COUNT(*) FROM device_activity) activity_touch
            WHERE s.token_hash=$1
            LIMIT 1
        `, [hashSessionToken(token)]));
        const row = result.rows[0];
        if (!row || new Date(row.expires_at).getTime() < Date.now()) {
            if (row) await runSystemContext(() => pool.query("DELETE FROM app_sessions WHERE token_hash=$1", [hashSessionToken(token)]));
            return res.status(401).json({ error: "Authentication required" });
        }
        const user = {
            id: row.id, display_name: row.display_name, username: row.username, profile_id: row.profile_id,
            business_id: row.user_business_id, active: row.active, permissions_override: row.permissions_override, is_owner: row.is_owner === true,
            business_name: row.business_name, business_type: row.business_type, owner_name: row.owner_name,
            business_phone: row.business_phone, business_email: row.business_email, business_address: row.business_address,
            city: row.city, state: row.state, gstin: row.gstin, currency: row.currency,
            business_active: row.business_active, profile_name: row.profile_name, permissions: row.permissions
        };
        if (!user.active) return res.status(401).json({ error: "Session is invalid or user is inactive" });
        if (!user.business_id || user.business_active === false) return res.status(403).json({ error: "Business account is inactive or not assigned" });

        const device = row.device_data;
        const license = row.license_data;
        let invalid = null;
        if (!device) invalid = { code: "DEVICE_NOT_REGISTERED", message: "Device is not registered" };
        else if (device.status !== "active") invalid = { code: "DEVICE_REVOKED", message: "Device registration has been revoked" };
        else if (Number(device.business_id) !== Number(user.business_id)) invalid = { code: "DEVICE_BUSINESS_MISMATCH", message: "Device is registered to a different business" };
        else if (!license) invalid = { code: "LICENSE_MISSING", message: "No license is assigned to this business" };
        if (!invalid && license.status === "active" && new Date(license.expires_at).getTime() < Date.now()) {
            await runSystemContext(() => pool.query("UPDATE business_licenses SET status='expired', updated_at=CURRENT_TIMESTAMP WHERE id=$1", [license.id]));
            license.status = "expired";
        }
        if (!invalid && license.status !== "active") invalid = { code: "LICENSE_INACTIVE", message: "Business license is " + license.status };
        if (!invalid && new Date(license.starts_at).getTime() > Date.now()) invalid = { code: "LICENSE_NOT_STARTED", message: "Business license has not started yet" };
        if (!invalid && new Date(license.expires_at).getTime() < Date.now()) invalid = { code: "LICENSE_EXPIRED", message: "Business license has expired" };
        if (invalid) {
            const map = {
                DEVICE_NOT_REGISTERED: [403, "This device is not registered. Enter a valid registration key first."],
                DEVICE_REVOKED: [403, "This device registration has been revoked."],
                DEVICE_BUSINESS_MISMATCH: [403, "This device belongs to a different business."],
                LICENSE_MISSING: [403, "No license is assigned to this business."],
                LICENSE_INACTIVE: [403, "Business license is " + (license?.status || "inactive") + "."],
                LICENSE_NOT_STARTED: [403, "Business license has not started yet."],
                LICENSE_EXPIRED: [403, "Business license has expired. Please contact support."]
            };
            const [status, message] = map[invalid.code] || [403, invalid.message];
            return res.status(status).json({ error: message, code: invalid.code });
        }
        req.user = user;
        req.sessionToken = row.token;
        req.device = device;
        req.license = license;
        const restrictedAddon = req.path.startsWith("/marketing") || req.path.startsWith("/loyalty")
            ? "Marketing"
            : (req.path === "/menu/public-settings" || req.path.startsWith("/menu/public-settings/") || /^\/menu\/\d+\/qr-stock$/.test(req.path)
                ? "Table QR" : null);
        if (restrictedAddon && !licenseHasAddon(req.license, restrictedAddon)) {
            return res.status(403).json({ error: restrictedAddon + " is a paid add-on that is not active for this business", code: "LICENSE_ADDON_REQUIRED", addon: restrictedAddon });
        }
        return tenantContext.run({ businessId: Number(user.business_id) }, () => {
            const required = permissionForRequest(req);
            if (!required) return res.status(403).json({ error: 'Permission denied: no permission mapping exists for this endpoint' });
            const permissions = user.permissions && typeof user.permissions === "object" ? user.permissions : {};
            const hasRequestedPermission = required === "orders.cancel"
                ? ["orders.edit_open", "orders.edit", "orders.cancel_closed"].some(key => permissions[key] === true)
                : permissions[required] === true || (required === "orders.edit_open" && ["orders.edit", "orders.edit_after_print", "orders.edit_closed"].some(key => permissions[key] === true));
            const ownerDefaults = user.is_owner === true && user.permissions_override === null;
            if (!ownerDefaults && !hasRequestedPermission) {
                return res.status(403).json({ error: "Permission denied: " + required });
            }
            return next();
        });
    } catch (e) {
        console.error("Auth middleware error:", e);
        res.status(500).json({ error: "Authentication service error" });
    }
}
// =====================================================
// INVOICE DATABASE SETUP
// =====================================================

async function ensureInvoiceTables() {
    console.log("2/7 ensureInvoiceTables");

    await pool.query(`CREATE TABLE IF NOT EXISTS invoice_number_counters (
        business_id INTEGER PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
        next_number BIGINT NOT NULL DEFAULT 1 CHECK(next_number > 0),
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

    const check = await pool.query(`
        SELECT
            to_regclass('public.invoice_number_seq') AS sequence,
            to_regclass('public.invoices') AS invoices
    `);

    const existing = check.rows[0];

    if (existing?.sequence && existing?.invoices) {
        console.log("✅ Invoice tables already exist");
        console.log("✅ ensureInvoiceTables complete");
        return;
    }

    console.log("🔧 Creating invoice database objects...");

    await pool.query(`
        CREATE SEQUENCE IF NOT EXISTS invoice_number_seq
        START WITH 1
        INCREMENT BY 1
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS invoices (
            id SERIAL PRIMARY KEY,
            invoice_number VARCHAR(50) NOT NULL,
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

    console.log("✅ Invoice tables created");
    console.log("✅ ensureInvoiceTables complete");
}

// =====================================================
// BUSINESS EXTENSIONS (STEP 15-19)
// =====================================================

async function ensureBusinessTables() {

    
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pax INTEGER`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS sales_channel_key VARCHAR(64)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS sales_channel_name VARCHAR(120)`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS gstin VARCHAR(40)`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS birth_date DATE`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS address TEXT`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS city VARCHAR(100)`);
    await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS state VARCHAR(100)`);

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
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS sales_channels JSONB`);
    await pool.query(`UPDATE menu m SET sales_channels=COALESCE((SELECT jsonb_agg(channel->>'key') FROM app_settings s CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.settings->'posSalesChannels')='array' THEN s.settings->'posSalesChannels' ELSE '[]'::jsonb END) channel WHERE s.business_id=m.business_id),'["dine_in","takeaway","delivery","online"]'::jsonb) WHERE m.sales_channels IS NULL`);
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS image_url TEXT`);
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS option_set_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS qr_available BOOLEAN NOT NULL DEFAULT TRUE`);
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS sku VARCHAR(80)`);
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`);
    await pool.query(`UPDATE menu SET sku='SKU-' || LPAD(id::text,8,'0') WHERE sku IS NULL OR BTRIM(sku)=''`);
    await pool.query(`ALTER TABLE menu ALTER COLUMN sku SET NOT NULL`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_business_sku_unique ON menu(business_id, upper(sku))`);
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
    await pool.query(`CREATE TABLE IF NOT EXISTS public_menu_settings (
        business_id INTEGER PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
        token VARCHAR(64) NOT NULL UNIQUE,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        price_channel VARCHAR(64) NOT NULL DEFAULT 'online',
        public_base_url TEXT,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`ALTER TABLE public_menu_settings ALTER COLUMN price_channel TYPE VARCHAR(64)`);
    await pool.query("ALTER TABLE public_menu_settings ADD COLUMN IF NOT EXISTS public_base_url TEXT");
    await pool.query(`CREATE TABLE IF NOT EXISTS public_menu_push_subscriptions (
        id SERIAL PRIMARY KEY,
        business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        subscription JSONB NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (business_id, endpoint)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_public_menu_push_subscriptions_business ON public_menu_push_subscriptions(business_id, created_at DESC)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS marketing_push_campaigns (
        id SERIAL PRIMARY KEY,
        business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        title VARCHAR(120) NOT NULL,
        message VARCHAR(500) NOT NULL,
        target_url TEXT NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'sending',
        subscriber_count INTEGER NOT NULL DEFAULT 0,
        sent_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        sent_at TIMESTAMP
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_marketing_push_campaigns_business ON marketing_push_campaigns(business_id, created_at DESC)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS public_tracking_token VARCHAR(64)`);
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_id INTEGER REFERENCES menu_variants(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unit VARCHAR(20)`);
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(6,2) NOT NULL DEFAULT 5`);
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tax_mode VARCHAR(20) NOT NULL DEFAULT 'exclusive'`);
    await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '[]'::jsonb`);

    await pool.query(`CREATE TABLE IF NOT EXISTS kot_groups (id SERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL UNIQUE, description TEXT, station VARCHAR(60) NOT NULL DEFAULT 'Kitchen', sort_order INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`ALTER TABLE kot_groups ADD COLUMN IF NOT EXISTS printer_id INTEGER`);
    await pool.query(`ALTER TABLE kot_groups ADD COLUMN IF NOT EXISTS category_names JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE kot_groups ADD COLUMN IF NOT EXISTS item_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE menu ADD COLUMN IF NOT EXISTS kot_group_id INTEGER REFERENCES kot_groups(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE kot ADD COLUMN IF NOT EXISTS kot_group_id INTEGER REFERENCES kot_groups(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE kot ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE kot ADD COLUMN IF NOT EXISTS order_item_id INTEGER REFERENCES order_items(id) ON DELETE CASCADE`);
    await pool.query(`
        WITH ranked_kot AS (
            SELECT id,order_id,item_name,quantity,
                   ROW_NUMBER() OVER (PARTITION BY order_id,item_name,quantity ORDER BY id) AS rn
            FROM kot WHERE order_item_id IS NULL
        ), ranked_items AS (
            SELECT id,order_id,item_name,quantity,
                   ROW_NUMBER() OVER (PARTITION BY order_id,item_name,quantity ORDER BY id) AS rn
            FROM order_items
        )
        UPDATE kot k SET order_item_id=oi.id
        FROM ranked_kot rk JOIN ranked_items oi
          ON oi.order_id=rk.order_id AND oi.item_name=rk.item_name AND oi.quantity=rk.quantity AND oi.rn=rk.rn
        WHERE k.id=rk.id
    `);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount NUMERIC(12,2) NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_charge NUMERIC(12,2) NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bill_printed_at TIMESTAMP`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS non_chargeable_reason VARCHAR(120)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason VARCHAR(300)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by_user_id INTEGER`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP`);
    await pool.query(`CREATE TABLE IF NOT EXISTS order_activity (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        event_type VARCHAR(100) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        actor VARCHAR(160) NOT NULL DEFAULT 'System',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_activity_order_time ON order_activity(order_id, created_at DESC)`);
    await pool.query(`
        UPDATE orders o
        SET cancelled_at = COALESCE(
            (SELECT MAX(a.created_at) FROM order_activity a WHERE a.order_id=o.id AND a.event_type='Order cancelled'),
            o.updated_at,
            o.created_at
        )
        WHERE o.status='Cancelled' AND o.cancelled_at IS NULL
    `);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS marketing_deal_id VARCHAR(120)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS marketing_deal_name VARCHAR(120)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_adjustment_id VARCHAR(120)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_adjustment_name VARCHAR(120)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS charge_adjustment_id VARCHAR(120)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS charge_adjustment_name VARCHAR(120)`);
    await pool.query(`UPDATE orders SET sales_channel_key=CASE WHEN public_tracking_token IS NOT NULL THEN 'online' WHEN LOWER(COALESCE(order_type,''))='dine-in' THEN 'dine_in' ELSE 'takeaway' END WHERE sales_channel_key IS NULL OR BTRIM(sales_channel_key)=''`);
    await pool.query(`UPDATE orders SET sales_channel_name=CASE WHEN sales_channel_key='dine_in' THEN 'Dine' WHEN sales_channel_key='takeaway' THEN 'Takeaway' WHEN sales_channel_key='delivery' THEN 'Delivery' WHEN sales_channel_key='online' OR public_tracking_token IS NOT NULL THEN 'Slash' ELSE COALESCE(NULLIF(sales_channel_name,''),order_type) END WHERE sales_channel_name IS NULL OR BTRIM(sales_channel_name)='' OR public_tracking_token IS NOT NULL OR sales_channel_key IN ('dine_in','takeaway','delivery','online')`);
    await pool.query(`
        UPDATE app_settings AS s
        SET settings=jsonb_set(
            s.settings,
            '{posSalesChannels}',
            (
                SELECT COALESCE(jsonb_agg(
                    CASE channel->>'key'
                        WHEN 'dine_in' THEN jsonb_set(channel, '{label}', '"Dine"'::jsonb, true)
                        WHEN 'takeaway' THEN jsonb_set(channel, '{label}', '"Takeaway"'::jsonb, true)
                        WHEN 'delivery' THEN jsonb_set(channel, '{label}', '"Delivery"'::jsonb, true)
                        WHEN 'online' THEN jsonb_set(channel, '{label}', '"Slash"'::jsonb, true)
                        ELSE channel
                    END ORDER BY ordinal
                ), '[]'::jsonb)
                FROM jsonb_array_elements(s.settings->'posSalesChannels') WITH ORDINALITY AS saved(channel, ordinal)
            ),
            true
        )
        WHERE jsonb_typeof(s.settings->'posSalesChannels')='array'
          AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(s.settings->'posSalesChannels') AS saved(channel)
              WHERE (channel->>'key'='dine_in' AND channel->>'label' IS DISTINCT FROM 'Dine')
                 OR (channel->>'key'='takeaway' AND channel->>'label' IS DISTINCT FROM 'Takeaway')
                 OR (channel->>'key'='delivery' AND channel->>'label' IS DISTINCT FROM 'Delivery')
                 OR (channel->>'key'='online' AND channel->>'label' IS DISTINCT FROM 'Slash')
          )
    `);


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
    await pool.query(`ALTER TABLE expenses ALTER COLUMN expense_date SET DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date)`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS loyalty_settings (
            id SERIAL PRIMARY KEY,
            business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
            points_per_currency NUMERIC(10,4) NOT NULL DEFAULT 1,
            currency_per_point NUMERIC(10,4) NOT NULL DEFAULT 1,
            min_redeem_points INTEGER NOT NULL DEFAULT 100,
            welcome_points INTEGER NOT NULL DEFAULT 0,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`ALTER TABLE loyalty_settings ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`);
    await pool.query(`ALTER TABLE loyalty_settings DROP CONSTRAINT IF EXISTS loyalty_settings_id_check`);
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS loyalty_settings_id_seq`);
    await pool.query(`ALTER TABLE loyalty_settings ALTER COLUMN id SET DEFAULT nextval('loyalty_settings_id_seq')`);
    await pool.query(`SELECT setval('loyalty_settings_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM loyalty_settings),1),1))`);
    await pool.query(`UPDATE loyalty_settings SET business_id=$1 WHERE business_id IS NULL`, [Number(systemBusinessId)]);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_settings_business_unique ON loyalty_settings(business_id)`);
    await pool.query(`
        INSERT INTO loyalty_settings(business_id,points_per_currency,currency_per_point,min_redeem_points,welcome_points,enabled)
        SELECT b.id,source.points_per_currency,source.currency_per_point,source.min_redeem_points,source.welcome_points,source.enabled
        FROM businesses b
        CROSS JOIN (SELECT points_per_currency,currency_per_point,min_redeem_points,welcome_points,enabled
                    FROM loyalty_settings WHERE business_id=$1 ORDER BY id LIMIT 1) source
        ON CONFLICT(business_id) DO NOTHING
    `, [Number(systemBusinessId)]);
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

async function getLoyaltySettings(businessId) {
    const r = await pool.query(`SELECT * FROM loyalty_settings WHERE business_id=$1 LIMIT 1`, [Number(businessId)]);
    return r.rows[0] || { points_per_currency: 1, currency_per_point: 1, min_redeem_points: 100, welcome_points: 0, enabled: true };
}

async function awardLoyaltyForPayment(paymentId, orderId, amount) {
    try {
        const order = (await pool.query(`SELECT customer_id,business_id FROM orders WHERE id=$1`, [orderId])).rows[0];
        if (!order?.customer_id) return;
        const settings = await getLoyaltySettings(order.business_id);
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

// HOME
// =====================================================

app.get("/", async (req, res) => {
    try {
        const deviceId = getCookie(req, "cafe_device_id");
        if (deviceId) {
            const device = await getRegisteredDevice(deviceId);
            if (device && device.status === "active") {
                return res.sendFile(path.join(__dirname, "public", "index.html"));
            }
        }
        return res.sendFile(path.join(__dirname, "public", "device-registration.html"));
    } catch (e) {
        console.error("Home route error:", e);
        return res.sendFile(path.join(__dirname, "public", "device-registration.html"));
    }
});
app.get("/device-registration", (_, res) => res.sendFile(path.join(__dirname, "public", "device-registration.html")));
app.get("/devices", (_, res) => res.sendFile(path.join(__dirname, "public", "devices.html")));
app.get("/support", (_, res) => res.sendFile(path.join(__dirname, "public", "support.html")));
app.get("/register-business", (_, res) => res.sendFile(path.join(__dirname, "public", "register-business.html")));



// =====================================================
// BUSINESS / REGISTRATION
// =====================================================
app.post('/api/public/register-business', async (req, res) => {
    if (process.env.PUBLIC_BUSINESS_REGISTRATION_ENABLED !== 'true') return res.status(404).json({ error: 'Public business registration is disabled' });
    const registrationSecret = String(process.env.PUBLIC_BUSINESS_REGISTRATION_KEY || '');
    const presentedSecret = String(req.get('x-business-registration-key') || '');
    if (registrationSecret.length < 32 || presentedSecret.length !== registrationSecret.length ||
        !crypto.timingSafeEqual(Buffer.from(presentedSecret), Buffer.from(registrationSecret))) {
        return res.status(404).json({ error: 'Public business registration is disabled' });
    }
    try {
        return await runSystemContext(async () => {
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

        // Business authentication is handled by app_users. Legacy business.password_hash
        // columns are kept nullable by ensureBusinessTable() for backwards compatibility.
        const business = (await client.query(`
            INSERT INTO businesses (business_code,business_name,business_type,owner_name,phone,email,address,city,state,gstin,logo_url,currency)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            RETURNING *
        `, [makeBusinessCode(b.businessName),b.businessName,b.businessType,b.ownerName,b.phone,b.email,b.address,b.city,b.state,b.gstin,b.logoUrl,b.currency])).rows[0];

        await seedBusinessAccessProfiles(business.id, client);
        const adminProfile = (await client.query(`SELECT id FROM access_profiles WHERE business_id=$1 AND name='Admin' LIMIT 1`, [business.id])).rows[0];

        const user = (await client.query(`
            INSERT INTO app_users (display_name,username,password_hash,profile_id,business_id,active,is_owner)
            VALUES ($1,$2,$3,$4,$5,TRUE,TRUE)
            RETURNING id,display_name,username,profile_id,business_id,active
        `, [b.ownerName, username, await hashPassword(password), adminProfile.id, business.id])).rows[0];

        await client.query('COMMIT');
        try { await seedTenantDefaults(business.id); }
        catch (seedError) { console.error('⚠️ Could not seed tenant defaults:', seedError.message); }
        const license = await ensureTrialLicense(business.id);
        const initialKey = await createDeviceRegistrationKey(business.id, {
            deviceName: 'Initial Device',
            createdByType: 'system',
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
        });
        res.status(201).json({ success: true, business, user, license, initialRegistrationKey: initialKey.rawKey });
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
    } catch (e) {
        console.error('Business registration wrapper error:', e);
        if (!res.headersSent) res.status(500).json({ error: 'Could not create business profile' });
    }
});

app.get('/api/public/device-business', async (req,res)=>{
    try {
        const deviceId=getCookie(req,'cafe_device_id');
        if(!deviceId) return res.json({businessName:''});
        const result=await runSystemContext(()=>pool.query(`
            SELECT b.business_name AS "businessName"
            FROM registered_devices d
            JOIN businesses b ON b.id=d.business_id
            WHERE d.device_id=$1 AND d.status='active' AND b.active=TRUE
            LIMIT 1
        `,[deviceId]));
        res.json(result.rows[0]||{businessName:''});
    } catch(e) {
        console.error('Device business lookup error:',e);
        res.status(500).json({error:'Could not load business name'});
    }
});
// AUTH ROUTES
// =====================================================
app.post("/api/auth/login", async (req,res)=>{
    try {
        const username=String(req.body.username||"").trim().toLowerCase();
        const password=String(req.body.password||"");
        if(!username||!password) return res.status(400).json({error:"Username and password are required"});
        if(password.length>1024) return res.status(400).json({error:"Password must be 1024 characters or fewer"});

        const deviceId = getCookie(req, "cafe_device_id");
        if (!deviceId) {
            return res.status(403).json({ error: "This device is not registered. Enter a registration key first.", code: "DEVICE_NOT_REGISTERED" });
        }

        let deviceLicense;
        try {
            deviceLicense = await assertActiveDeviceAndLicense(deviceId);
        } catch (e) {
            return res.status(403).json({
                error: e.message || "Device or license validation failed",
                code: e.code || "AUTH_VALIDATION_FAILED"
            });
        }

        const businessId = Number(deviceLicense.device.business_id);
        const identityKey = loginIdentityKey("business", businessId, username);
        const existingLockout = await getLoginLockout(identityKey);
        if (existingLockout) {
            res.setHeader("Retry-After", String(Math.max(1, Math.ceil((existingLockout - Date.now()) / 1000))));
            return res.status(429).json({ error: "Too many failed sign-in attempts. Try again later." });
        }
        const r = await tenantContext.run({ businessId }, () => pool.query(`
            SELECT u.id,u.display_name,u.username,u.profile_id,u.business_id,u.active,u.password_hash,u.permissions_override,u.is_owner,
                b.business_code,b.business_name,b.business_type,b.owner_name,b.phone AS business_phone,b.email AS business_email,
                b.address AS business_address,b.city,b.state,b.gstin,b.logo_url,b.currency,b.active AS business_active,
                p.name AS profile_name,COALESCE(u.permissions_override,p.permissions,'{}'::jsonb) AS permissions
            FROM app_users u
            LEFT JOIN businesses b ON b.id=u.business_id
            LEFT JOIN access_profiles p ON p.id=u.profile_id AND p.business_id=u.business_id
            WHERE LOWER(u.username)=$1 AND u.business_id=$2
            LIMIT 1`,[username,businessId]));
        const user=r.rows[0];
        const passwordValid = user?.active ? await verifyPassword(password,user.password_hash) : false;
        if(!passwordValid) {
            const lockedUntil = await recordFailedLogin(identityKey);
            if (lockedUntil) {
                res.setHeader("Retry-After", String(Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000))));
                return res.status(429).json({error:"Too many failed sign-in attempts. Try again later."});
            }
            return res.status(401).json({error:"Invalid username or password"});
        }
        await clearLoginFailures(identityKey);
        delete user.password_hash;
        const session = await createSession(user, deviceLicense.device);
        setCookie(res, "cafe_session", session.token, { maxAge: Math.floor(SESSION_TTL_MS / 1000), httpOnly: true, sameSite: "None", secure: true });
        res.json({ success: true, user, device: deviceLicense.device, license: deviceLicense.license, expiresAt: session.expiresAt });
    }catch(e){console.error("Login error:",e);res.status(500).json({error:"Login failed"});}
});

app.get("/api/auth/heartbeat", async (req, res) => {
    try {
        const session = await getSessionUser(req);
        if (!session) return res.status(401).json({ error: "Session is no longer active" });
        return res.json({ active: true, expiresAt: session.expiresAt });
    } catch (error) {
        console.error("Session heartbeat error:", error);
        return res.status(500).json({ error: "Could not verify session" });
    }
});
app.get("/api/auth/me",async(req,res)=>{
    try{
        const session = await getSessionUser(req);
        if(!session)return res.status(401).json({error:"Not logged in"});
        const user=await loadSessionUser(session);
        if(!user)return res.status(401).json({error:"Session is invalid"});
        const {device,license} = await assertActiveDeviceAndLicense(session.deviceId, user.business_id);
        res.json({user,device,license,expiresAt: session.expiresAt});
    } catch(e){res.status(403).json({error:e.message || "Could not read session", code:e.code || "AUTH_VALIDATION_FAILED"});}
});

app.post("/api/auth/logout", async (req, res) => {
    try {
        const session = await getSessionUser(req);
        if (session) await pool.query(`DELETE FROM app_sessions WHERE token_hash = $1`, [hashSessionToken(session.token)]);
        clearCookie(res, "cafe_session");
        res.json({ success: true });
    } catch (e) {
        console.error("Logout error:", e);
        res.status(500).json({ error: "Logout failed" });
    }
});

// The opaque URL exposes only a published guest menu. POS controls remain behind authentication.
app.get("/restaurant/:token", (req, res) => {
    if (!/^[a-f0-9]{48}$/i.test(String(req.params.token || ""))) return res.status(404).send("Menu not found");
    res.sendFile(path.join(__dirname, "public", "restaurant-menu.html"));
});

app.get("/restaurant/:token/manifest.webmanifest", async (req, res) => {
    const token = String(req.params.token || "");
    if (!/^[a-f0-9]{48}$/i.test(token)) return res.status(404).json({ error: "Menu not found" });
    try {
        const result = await runSystemContext(() => pool.query(
            "SELECT s.business_id, s.enabled, b.business_name FROM public_menu_settings s JOIN businesses b ON b.id=s.business_id WHERE s.token=$1 LIMIT 1",
            [token]
        ));
        const publication = result.rows[0];
        if (!publication?.enabled || !(await businessHasLicenseAddon(publication.business_id, "Table QR"))) return res.status(404).json({ error: "Menu not found" });
        const name = String(publication.business_name || "Cafe & Restaurant").slice(0, 80);
        res.set("Cache-Control", "public, max-age=0, must-revalidate").type("application/manifest+json").json({
            id: `/restaurant/${token}`,
            name: `${name} · Slash QR Menu`,
            short_name: name.slice(0, 30),
            description: `Browse the menu at ${name}, powered by Slash.`,
            start_url: `/restaurant/${token}`,
            scope: "/",
            display: "standalone",
            background_color: "#f5f3ec",
            theme_color: "#25222f",
            icons: [
                { src: "/qr-menu-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
                { src: "/qr-menu-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
                { src: "/qr-menu-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }
            ]
        });
    } catch (error) {
        console.error("Guest menu manifest error:", error);
        res.status(500).json({ error: "Could not load menu app details" });
    }
});

app.get("/public-menu/:token/push-config", async (req, res) => {
    const token = String(req.params.token || "");
    if (!/^[a-f0-9]{48}$/i.test(token)) return res.status(404).json({ error: "Menu not found" });
    try {
        const result = await runSystemContext(() => pool.query("SELECT business_id, enabled FROM public_menu_settings WHERE token=$1 LIMIT 1", [token]));
        const publication = result.rows[0];
        if (!publication?.enabled || !(await businessHasLicenseAddon(publication.business_id, "Table QR"))) return res.status(404).json({ error: "Menu not found" });
        const marketingEnabled = await businessHasLicenseAddon(publication.business_id, "Marketing");
        const configured = marketingEnabled && Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
        res.set("Cache-Control", "no-store").json({ configured, marketingEnabled, publicKey: configured ? process.env.VAPID_PUBLIC_KEY : null });
    } catch (error) {
        console.error("Guest push configuration error:", error);
        res.status(500).json({ error: "Could not load notification settings" });
    }
});

app.post("/public-menu/:token/push-subscriptions", async (req, res) => {
    const token = String(req.params.token || "");
    if (!/^[a-f0-9]{48}$/i.test(token)) return res.status(404).json({ error: "Menu not found" });
    const subscription = req.body?.subscription;
    const endpoint = String(subscription?.endpoint || "");
    let endpointUrl;
    try { endpointUrl = new URL(endpoint); } catch (_) { return res.status(400).json({ error: "Invalid push subscription" }); }
    const host = endpointUrl.hostname.toLowerCase();
    const allowedPushHost = host === "fcm.googleapis.com" || host.endsWith(".fcm.googleapis.com") ||
        host === "updates.push.services.mozilla.com" || host.endsWith(".push.services.mozilla.com") ||
        host === "web.push.apple.com" || host.endsWith(".web.push.apple.com") || host.endsWith(".notify.windows.com");
    if (endpointUrl.protocol !== "https:" || !allowedPushHost || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return res.status(400).json({ error: "Invalid push subscription" });
    }
    try {
        const access = await runSystemContext(() => pool.query("SELECT business_id, enabled FROM public_menu_settings WHERE token=$1 LIMIT 1", [token]));
        const publication = access.rows[0];
        if (!publication?.enabled || !(await businessHasLicenseAddon(publication.business_id, "Table QR"))) return res.status(404).json({ error: "Menu not found" });
        if (!(await businessHasLicenseAddon(publication.business_id, "Marketing"))) return res.status(403).json({ error: "Promotional messages are not enabled for this cafe" });
        const businessId = Number(publication.business_id);
        await tenantContext.run({ businessId }, () => pool.query(`
            INSERT INTO public_menu_push_subscriptions(business_id, endpoint, subscription)
            VALUES($1,$2,$3::jsonb)
            ON CONFLICT(business_id, endpoint) DO UPDATE SET subscription=EXCLUDED.subscription, updated_at=CURRENT_TIMESTAMP
        `, [businessId, endpoint, JSON.stringify(subscription)]));
        res.status(201).json({ success: true });
    } catch (error) {
        console.error("Guest push subscription save error:", error);
        res.status(500).json({ error: "Could not save notification preference" });
    }
});
const MARKETING_SCHEDULE_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function marketingDealScheduleUnavailableReason(deal, now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
        weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const dayKey = ({ Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" })[values.weekday];
    const dayIndex = MARKETING_SCHEDULE_WEEKDAYS.indexOf(dayKey);
    const previousDay = MARKETING_SCHEDULE_WEEKDAYS[(dayIndex + 6) % 7];
    const today = values.year + "-" + values.month + "-" + values.day;
    if (deal?.startDate && String(deal.startDate) > today) return "The deal has not started yet.";
    if (deal?.endDate && String(deal.endDate) < today) return "The deal has ended.";

    const days = Array.isArray(deal?.days) && deal.days.length
        ? deal.days.map(day => String(day).toLowerCase()).filter(day => MARKETING_SCHEDULE_WEEKDAYS.includes(day))
        : MARKETING_SCHEDULE_WEEKDAYS;
    const startTime = String(deal?.startTime || "").trim();
    const endTime = String(deal?.endTime || "").trim();
    if (Boolean(startTime) !== Boolean(endTime)) return "Both deal times must be set.";
    if (!startTime) return days.includes(dayKey) ? "" : "The deal is not available today.";

    const parseTime = value => {
        const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
        return match ? Number(match[1]) * 60 + Number(match[2]) : null;
    };
    const start = parseTime(startTime);
    const end = parseTime(endTime);
    if (start === null || end === null || start === end) return "Deal hours are invalid.";
    const minute = Number(values.hour) * 60 + Number(values.minute);
    const inWindow = start < end
        ? days.includes(dayKey) && minute >= start && minute < end
        : (days.includes(dayKey) && minute >= start) || (days.includes(previousDay) && minute < end);
    return inWindow ? "" : "The deal is outside its available days or hours.";
}

const DEFAULT_SALES_CHANNELS = [
    { key: "dine_in", label: "Dine", orderType: "Dine-in", qrMenu: false },
    { key: "takeaway", label: "Takeaway", orderType: "Takeaway", qrMenu: false },
    { key: "delivery", label: "Delivery", orderType: "Takeaway", qrMenu: false },
    { key: "online", label: "Slash", orderType: "Takeaway", qrMenu: true }
];

function normalizeSalesChannels(value) {
    const source = Array.isArray(value) ? value : DEFAULT_SALES_CHANNELS;
    const fixedLabels = { dine_in: "Dine", takeaway: "Takeaway", delivery: "Delivery", online: "Slash" };
    const channels = [];
    const seen = new Set();
    for (const entry of source.slice(0, 40)) {
        const key = String(entry?.key || "").trim().toLowerCase();
        const label = String(fixedLabels[key] || entry?.label || "").trim().slice(0, 60);
        const orderType = entry?.orderType === "Dine-in" ? "Dine-in" : entry?.orderType === "Takeaway" ? "Takeaway" : "";
        if (!/^[a-z][a-z0-9_]{1,19}$/.test(key) || !label || !orderType || seen.has(key)) continue;
        seen.add(key);
        channels.push({ key, label, orderType, qrMenu: entry?.qrMenu === true });
    }
    return channels;
}

function salesChannelsForSettings(settings) {
    return normalizeSalesChannels(settings?.posSalesChannels);
}

function resolveSaleChannel(settings, channelKey, orderType = null) {
    const channels = salesChannelsForSettings(settings);
    const key = String(channelKey || "").trim().toLowerCase();
    const channel = channels.find(entry => entry.key === key);
    if (!channel) throw Object.assign(new Error("Choose an active sale channel."), { status: 400 });
    if (orderType && channel.orderType !== orderType) {
        throw Object.assign(new Error("This sale channel does not match the selected order type."), { status: 400 });
    }
    return channel;
}

function menuItemChannels(item, settings) {
    return Array.isArray(item?.sales_channels)
        ? item.sales_channels.map(value => String(value).trim().toLowerCase()).filter(Boolean)
        : salesChannelsForSettings(settings).map(channel => channel.key);
}

function assertMenuItemAvailableOnChannel(item, settings, channelKey) {
    if (!menuItemChannels(item, settings).includes(String(channelKey || "").toLowerCase())) {
        throw Object.assign(new Error("This menu item is not available on the selected sale channel."), { status: 409 });
    }
}

function assertMarketingDealAvailableForBilling(settings, dealId, channelKey) {
    const id = String(dealId || "").replace(/^marketing:/, "");
    const deal = (Array.isArray(settings?.marketingDeals) ? settings.marketingDeals : [])
        .find(item => String(item?.id) === id);
    if (!deal || deal.active === false) throw new Error("The selected marketing deal is no longer available.");
    const dealChannels = Array.isArray(deal.channels) ? deal.channels.map(value => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_")) : [];
    if (dealChannels.length && !dealChannels.includes(String(channelKey || "").toLowerCase())) {
        throw Object.assign(new Error("The selected marketing deal is not available on this sale channel."), { status: 400 });
    }
    const unavailable = marketingDealScheduleUnavailableReason(deal);
    if (unavailable) throw new Error("The selected marketing deal cannot be used now. " + unavailable);
}

async function assertBillingAdjustmentAvailableForChannel(db, businessId, adjustmentId, channelKey) {
    if (!adjustmentId) return;
    const id = Number(adjustmentId);
    if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error("The selected discount or charge is invalid."), { status: 400 });
    const result = await db.query("SELECT applies_to,active FROM billing_adjustments WHERE id=$1 AND business_id=$2 LIMIT 1", [id, Number(businessId)]);
    const rule = result.rows[0];
    if (!rule || rule.active === false) throw Object.assign(new Error("The selected discount or charge is no longer active."), { status: 400 });
    const applies = String(rule.applies_to || "all").toLowerCase().replace(/[\s-]+/g, "_");
    if (applies !== "all" && applies !== String(channelKey || "").toLowerCase()) {
        throw Object.assign(new Error("The selected discount or charge is not available on this sale channel."), { status: 400 });
    }
}

function defaultSaleChannelForOrderType(settings, orderType) {
    const channels = salesChannelsForSettings(settings).filter(channel => channel.orderType === orderType);
    const preferenceKey = orderType === "Dine-in" ? "tableView" : "newOrder";
    const preferred = settings?.posChannelPreferences?.[preferenceKey]?.defaultChannel;
    return channels.find(channel => channel.key === preferred)?.key || channels.find(channel => channel.key === (orderType === "Dine-in" ? "dine_in" : "takeaway"))?.key || channels[0]?.key;
}

function publicOnlinePromotions(settings, adjustmentRows = [], channelKey = "online") {
    const marketing = (Array.isArray(settings?.marketingDeals) ? settings.marketingDeals : []).filter(deal => {
        const channels = Array.isArray(deal.channels) ? deal.channels.map(value => String(value).toLowerCase().replace(/[\s-]+/g, "_")) : [];
        return String(deal?.id || "").trim() && deal?.active !== false && (!channels.length || channels.includes(String(channelKey).toLowerCase()));
    }).map(deal => ({
        id: `marketing:${String(deal.id)}`, source: "marketing", sourceId: String(deal.id), name: String(deal.name || "QR Menu offer").slice(0, 120),
        description: String(deal.description || "").slice(0, 240), type: String(deal.type || "Deal").slice(0, 80), valueType: String(deal.valueType || "amount"),
        value: Number.isFinite(Number(deal.value)) ? Number(deal.value) : 0,
        buyQuantity: Math.max(1, Number(deal.buyQuantity) || 1), getQuantity: Math.max(1, Number(deal.getQuantity) || 1),
        category: String(deal.category || ""), itemId: deal.itemId || null, itemIds: Array.isArray(deal.itemIds) ? deal.itemIds.map(String) : [],
        startDate: deal.startDate || null, endDate: deal.endDate || null,
        days: Array.isArray(deal.days) ? deal.days.map(day => String(day).toLowerCase()) : [],
        startTime: deal.startTime || null, endTime: deal.endTime || null
    }));
    const adjustments = adjustmentRows.filter(rule => {
        const kind = String(rule.kind || rule.type || "discount").toLowerCase();
        const applies = String(rule.applies_to || "all").toLowerCase().replace(/-/g, "_");
        return rule.active !== false && kind === "discount" && ["all", String(channelKey).toLowerCase()].includes(applies) && Number(rule.value) > 0;
    }).map(rule => ({
        id: `adjustment:${Number(rule.id)}`, source: "adjustment", sourceId: String(rule.id), name: String(rule.name || "QR Menu discount").slice(0, 120),
        description: String(rule.description || "").slice(0, 240), type: "discount",
        valueType: ["percent", "percentage"].includes(String(rule.calculation || rule.value_type || "").toLowerCase()) ? "percent" : "amount",
        value: Number(rule.value), category: "", itemId: null, itemIds: []
    }));
    return [...marketing, ...adjustments];
}

app.get("/public-menu/:token", async (req, res) => {
    const token = String(req.params.token || "");
    if (!/^[a-f0-9]{48}$/i.test(token)) return res.status(404).json({ error: "Menu not found" });
    try {
        const access = await runSystemContext(() => pool.query(
            "SELECT business_id, enabled, price_channel FROM public_menu_settings WHERE token=$1 LIMIT 1",
            [token]
        ));
        const publication = access.rows[0];
        if (!publication || !publication.enabled || !(await businessHasLicenseAddon(publication.business_id, "Table QR"))) return res.status(404).json({ error: "Menu not found" });
        const businessId = Number(publication.business_id);
        const data = await tenantContext.run({ businessId }, async () => {
            const [businessResult, settingsResult, categoryResult, menuResult, variantResult, tableResult, adjustmentResult] = await Promise.all([
                pool.query("SELECT business_name, logo_url, currency FROM businesses WHERE id=$1 LIMIT 1", [businessId]),
                pool.query("SELECT settings FROM app_settings WHERE business_id=$1 LIMIT 1", [businessId]),
                pool.query("SELECT name FROM menu_categories WHERE business_id=$1 AND active=TRUE ORDER BY sort_order, name", [businessId]),
                pool.query("SELECT id, name, description, category, price, channel_prices, sales_channels, image_url, qr_available, tax_rate, tax_mode, option_set_ids FROM menu WHERE business_id=$1 AND available=TRUE ORDER BY category, name, id", [businessId]),
                pool.query("SELECT id, menu_id, name, price, unit, channel_prices FROM menu_variants WHERE business_id=$1 AND available=TRUE ORDER BY menu_id, id", [businessId]),
                pool.query("SELECT table_number FROM restaurant_tables WHERE business_id=$1 ORDER BY table_number", [businessId]),
                pool.query("SELECT id,name,COALESCE(to_jsonb(ba)->>'type',to_jsonb(ba)->>'kind','discount') AS kind,COALESCE(to_jsonb(ba)->>'value_type',to_jsonb(ba)->>'calculation','amount') AS calculation,value,applies_to,description,active FROM billing_adjustments ba WHERE business_id=$1 AND active=TRUE", [businessId])
            ]);
            const business = businessResult.rows[0] || {};
            const settings = settingsResult.rows[0]?.settings || {};
            const qrChannels = salesChannelsForSettings(settings).filter(channel => channel.qrMenu);
            const priceChannel = qrChannels.find(channel => channel.key === publication.price_channel)?.key || qrChannels.find(channel => channel.key === "online")?.key || qrChannels[0]?.key || "online";
            const configuredOptionSets = Array.isArray(settings.menuOptionSets) ? settings.menuOptionSets : [];
            const optionSetsById = new Map(configuredOptionSets.map(set => [String(set.id), set]));
            const itemsById = new Map();
            const items = menuResult.rows.map(item => {
                if (!menuItemChannels(item, settings).includes(priceChannel)) return null;
                const prices = item.channel_prices && typeof item.channel_prices === "object" ? item.channel_prices : {};
                const entry = {
                    id: String(item.id),
                    name: item.name,

                    description: String(item.description || ""),
                    category: item.category || "Menu",
                    price: Number(prices[priceChannel] ?? item.price ?? 0),
                    imageUrl: item.image_url || "",
                    inStock: item.qr_available !== false,
                    taxRate: Number(item.tax_rate || 0),
                    taxMode: item.tax_mode === "inclusive" ? "inclusive" : "exclusive",
                    optionSets: (Array.isArray(item.option_set_ids) ? item.option_set_ids : []).map(id => optionSetsById.get(String(id))).filter(Boolean).map(set => ({
                        id: String(set.id), name: String(set.name || "Options"), minSelections: Math.max(0, Number(set.minSelections) || 0),
                        maxSelections: Math.max(1, Number(set.maxSelections) || 1),
                        options: (Array.isArray(set.options) ? set.options : []).map(option => ({ id: String(option.id), name: String(option.name || "Choice"), price: Math.max(0, Number(option.price) || 0) }))
                    })),
                    variants: []
                };
                itemsById.set(Number(item.id), entry);
                return entry;
            }).filter(Boolean);
            for (const variant of variantResult.rows) {
                const item = itemsById.get(Number(variant.menu_id));
                if (!item) continue;
                const prices = variant.channel_prices && typeof variant.channel_prices === "object" ? variant.channel_prices : {};
                item.variants.push({
                    id: String(variant.id),
                    name: variant.name,
                    unit: variant.unit || "",
                    price: Number(prices[priceChannel] ?? variant.price ?? item.price)
                });
            }
            return {
                restaurantName: String(settings.restaurantName || business.business_name || "Cafe & Restaurant"),
                logoUrl: String(settings.logoUrl || business.logo_url || ""),
                currency: String(settings.currency || business.currency || "₹"),
                priceChannel,
            priceChannelLabel: qrChannels.find(channel => channel.key === priceChannel)?.label || "Slash",
                gstCalculationEnabled: settings.gstCalculationEnabled !== false,
                onlinePromotions: publicOnlinePromotions(settings, adjustmentResult.rows, priceChannel),
                categories: categoryResult.rows.map(row => row.name),
                items,
                tables: tableResult.rows.map(row => String(row.table_number))
            };
        });
        res.set("Cache-Control", "no-store");
        res.json(data);
    } catch (error) {
        console.error("Public restaurant menu error:", error);
        res.status(500).json({ error: "Could not load menu" });
    }
});

function normalizeQrGuestCustomer(value){
    const source=value&&typeof value==="object"?value:{};
    const name=String(source.name||"").trim();
    const rawPhone=String(source.phone||"").trim();
    const digits=rawPhone.replace(/\D/g,"");
    const phone=(rawPhone.startsWith("+")?"+":"")+digits;
    const email=String(source.email||"").trim();
    const birthDate=String(source.birthDate||source.birth_date||"").trim();
    if(!name||name.length>100)throw Object.assign(new Error("Enter your name (up to 100 characters)."),{status:400});
    if(!/^\+?[\d\s().-]+$/.test(rawPhone)||digits.length<6||digits.length>15)throw Object.assign(new Error("Enter a valid phone or WhatsApp number."),{status:400});
    if(email&&(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))throw Object.assign(new Error("Enter a valid email address or leave it blank."),{status:400});
    if(birthDate){
        const parsed=new Date(birthDate+"T00:00:00.000Z");
        if(!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)||Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==birthDate||parsed.getTime()>Date.now())throw Object.assign(new Error("Enter a valid birthday or leave it blank."),{status:400});
    }
    return{name,phone,email:email||null,birthDate:birthDate||null};
}

async function upsertQrGuestCustomer(queryable,businessId,customer){
    const phoneDigits=customer.phone.replace(/\D/g,"");
    const existing=await queryable.query("SELECT id FROM customers WHERE business_id=$1 AND regexp_replace(phone,'[^0-9]','','g')=$2 ORDER BY id LIMIT 1",[businessId,phoneDigits]);
    if(existing.rows.length){
        const updated=await queryable.query(`UPDATE customers SET name=COALESCE(NULLIF(BTRIM(name),''),$1),email=COALESCE(NULLIF(BTRIM(email),''),$2),birth_date=COALESCE(birth_date,$3) WHERE id=$4 AND business_id=$5 RETURNING id,name,phone,email,birth_date`,[customer.name,customer.email,customer.birthDate,existing.rows[0].id,businessId]);
        return updated.rows[0];
    }
    const created=await queryable.query("INSERT INTO customers(name,phone,email,birth_date,business_id) VALUES($1,$2,$3,$4,$5) RETURNING id,name,phone,email,birth_date",[customer.name,customer.phone,customer.email,customer.birthDate,businessId]);
    return created.rows[0];
}

app.post("/public-menu/:token/customers", async (req,res)=>{
    const token=String(req.params.token||"");
    if(!/^[a-f0-9]{48}$/i.test(token))return res.status(404).json({error:"Menu not found"});
    try{
        const details=normalizeQrGuestCustomer(req.body);
        const access=await runSystemContext(()=>pool.query("SELECT business_id,enabled FROM public_menu_settings WHERE token=$1 LIMIT 1",[token]));
        const publication=access.rows[0];
        if(!publication||!publication.enabled||!(await businessHasLicenseAddon(publication.business_id,"Table QR")))return res.status(404).json({error:"This QR menu is not currently accepting orders"});
        const businessId=Number(publication.business_id);
        const customer=await tenantContext.run({businessId},()=>upsertQrGuestCustomer(pool,businessId,details));
        res.status(200).json({success:true,customer});
    }catch(error){
        if(error.status)return res.status(error.status).json({error:error.message});
        console.error("Save public QR guest details error:",error);
        res.status(500).json({error:"Could not save your details"});
    }
});

app.post("/public-menu/:token/orders", async (req, res) => {
    const token = String(req.params.token || "");
    if (!/^[a-f0-9]{48}$/i.test(token)) return res.status(404).json({ error: "Menu not found" });
    const linkTableNumber = String(req.query?.table || "").trim();
    const tableNumber = String(req.body?.tableNumber || req.body?.table_number || "").trim();
    const requestedOrderType = String(req.body?.orderType || "dine-in").toLowerCase();
    if (req.body?.promotionId || req.body?.marketingDealId || (req.body?.discount !== undefined && Number(req.body.discount) !== 0)) return res.status(400).json({ error: "Offers are display-only and cannot be applied to QR orders." });
    if (!['dine-in', 'takeaway'].includes(requestedOrderType)) return res.status(400).json({ error: "Choose Dine in or Takeaway" });
    const orderType = requestedOrderType === "takeaway" ? "Takeaway" : "Dine-in";
    const assignedTableNumber = orderType === "Dine-in" ? tableNumber : null;
    const trackingToken = crypto.randomBytes(24).toString("hex");
    const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];
    let guestCustomerDetails;
    try{guestCustomerDetails=normalizeQrGuestCustomer(req.body?.customer);}
    catch(error){return res.status(error.status||400).json({error:error.message||"Enter your details before ordering"});}
    if (!linkTableNumber || tableNumber !== linkTableNumber || !tableNumber || tableNumber.length > 60 || /[\u0000-\u001f\u007f]/.test(tableNumber)) {
        return res.status(400).json({ error: "This order link does not have a valid table number" });
    }
    if (!requestedItems.length || requestedItems.length > 30) {
        return res.status(400).json({ error: "Choose between 1 and 30 menu items" });
    }
    try {
        const access = await runSystemContext(() => pool.query(
            "SELECT business_id, enabled, price_channel FROM public_menu_settings WHERE token=$1 LIMIT 1",
            [token]
        ));
        const publication = access.rows[0];
        if (!publication || !publication.enabled || !(await businessHasLicenseAddon(publication.business_id, "Table QR"))) return res.status(404).json({ error: "This QR menu is not currently accepting orders" });
        const businessId = Number(publication.business_id);
        const result = await tenantContext.run({ businessId }, async () => {
            const client = await rawPoolConnect();
            try {
                await client.query("BEGIN");
                await applyTenantDbContext(client);
                const businessSettingsResult = await client.query("SELECT settings FROM app_settings WHERE business_id=$1 LIMIT 1", [businessId]);
                const businessSettings = businessSettingsResult.rows[0]?.settings || {};
                const qrChannels = salesChannelsForSettings(businessSettings).filter(channel => channel.qrMenu);
                const priceChannel = qrChannels.find(channel => channel.key === publication.price_channel)?.key || qrChannels.find(channel => channel.key === "online")?.key || qrChannels[0]?.key || "online";
                const tableResult = await client.query(
                    "SELECT table_number FROM restaurant_tables WHERE business_id=$1 AND table_number::text=$2 FOR UPDATE",
                    [businessId, tableNumber]
                );
                if (!tableResult.rows.length) throw Object.assign(new Error("This QR link does not match a table in this POS"), { status: 400 });
                const guestCustomer=await upsertQrGuestCustomer(client,businessId,guestCustomerDetails);

                const linesByKey = new Map();
                for (const source of requestedItems) {
                    const itemId = Number(source?.itemId ?? source?.menuId);
                    const variantId = Number(source?.variantId) || null;
                    const quantity = Number(source?.quantity);
                    if (!Number.isInteger(itemId) || itemId <= 0 || !Number.isInteger(quantity) || quantity < 1 || quantity > 30 ||
                        (source?.variantId && (!Number.isInteger(variantId) || variantId <= 0))) {
                        throw Object.assign(new Error("One of the order items is invalid"), { status: 400 });
                    }
                    const selectedOptions = cleanOrderOptions(source?.options);
                    const optionSignature = JSON.stringify(selectedOptions.map(set => [set.setId, set.options.map(option => option.id).sort()]).sort((a, b) => a[0].localeCompare(b[0])));
                    const key = itemId + ":" + (variantId || 0) + ":" + optionSignature;
                    const current = linesByKey.get(key) || { itemId, variantId, quantity: 0, options: selectedOptions };
                    current.quantity += quantity;
                    if (current.quantity > 30) throw Object.assign(new Error("Choose up to 30 of each menu item"), { status: 400 });
                    linesByKey.set(key, current);
                }
                const requestedLines = [...linesByKey.values()];
                const itemIds = [...new Set(requestedLines.map(line => line.itemId))];
                const menuResult = await client.query(
                    "SELECT id,name,category,price,channel_prices,sales_channels,qr_available,unit,tax_rate,tax_mode,option_set_ids FROM menu WHERE business_id=$1 AND id=ANY($2::int[]) AND available=TRUE AND qr_available=TRUE",
                    [businessId, itemIds]
                );
                const menuById = new Map(menuResult.rows.map(item => [Number(item.id), item]));
                if (menuById.size !== itemIds.length) {
                    throw Object.assign(new Error("A selected menu item is no longer available"), { status: 409 });
                }
                const variantIds = requestedLines.map(line => line.variantId).filter(Boolean);
                const variantResult = variantIds.length ? await client.query(
                    "SELECT id,menu_id,name,price,unit,channel_prices FROM menu_variants WHERE business_id=$1 AND id=ANY($2::int[]) AND available=TRUE",
                    [businessId, variantIds]
                ) : { rows: [] };
                const variantById = new Map(variantResult.rows.map(variant => [Number(variant.id), variant]));
                const orderLines = [];
                for (const line of requestedLines) {
                    const item = menuById.get(line.itemId);
                    if (item) assertMenuItemAvailableOnChannel(item, businessSettings, priceChannel);
                    const variant = line.variantId ? variantById.get(line.variantId) : null;
                    if (!item || (line.variantId && (!variant || Number(variant.menu_id) !== line.itemId))) {
                        throw Object.assign(new Error("A selected size is no longer available"), { status: 409 });
                    }
                    const prices = item.channel_prices && typeof item.channel_prices === "object" ? item.channel_prices : {};
                    const variantPrices = variant?.channel_prices && typeof variant.channel_prices === "object" ? variant.channel_prices : {};
                    const price = Number(variant ? (variantPrices[priceChannel] ?? variant.price) : (prices[priceChannel] ?? item.price));
                    if (!Number.isFinite(price) || price < 0) throw Object.assign(new Error("A menu price is invalid"), { status: 400 });
                    const normalizedOptions = await normalizeOrderItemOptions(client, businessId, item, line.options, undefined, undefined);
                    const finalPrice = price + normalizedOptions.addOnPrice;
                    orderLines.push({
                        menuId: line.itemId,
                        variantId: variant ? line.variantId : null,
                        itemName: item.name + (variant ? " · " + variant.name : ""),
                        price: finalPrice,
                        quantity: line.quantity,
                        lineTotal: finalPrice * line.quantity,
                        options: normalizedOptions.options,
                        unit: variant?.unit || item.unit || "ea",
                        category: String(item.category || "Menu"),
                        taxRate: businessSettings.gstCalculationEnabled === false ? 0 : Math.max(0, Number(item.tax_rate || 0)),
                        taxMode: item.tax_mode === "inclusive" ? "inclusive" : "exclusive"
                    });
                }
                const lineNets = orderLines.map(line => { const gross = line.price * line.quantity; return line.taxMode === "inclusive" && line.taxRate ? gross / (1 + line.taxRate / 100) : gross; });
                const subtotal = lineNets.reduce((sum, value) => sum + value, 0);
                const discount = 0;
                const discounts = orderLines.map(() => 0);
                const gst = orderLines.reduce((sum, line, index) => sum + lineNets[index] * line.taxRate / 100, 0);
                const total = orderLines.reduce((sum, line, index) => sum + lineNets[index] + lineNets[index] * line.taxRate / 100, 0);
                const orderNumber = "QR-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();
                const note = String(req.body?.notes || "").trim().slice(0, 300);
                const qrChannel = qrChannels.find(channel => channel.key === priceChannel);
                const orderResult = await client.query(
                    "INSERT INTO orders(order_number,order_type,table_number,subtotal,gst,total,payment_method,status,notes,pax,public_tracking_token,discount,marketing_deal_id,marketing_deal_name,discount_adjustment_id,discount_adjustment_name,customer_id,sales_channel_key,sales_channel_name) VALUES($1,$2,$3,$4,$5,$6,'Unpaid','Pending',$7,1,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id,order_number,table_number,total,status",
                    [orderNumber, orderType, assignedTableNumber, subtotal, gst, total, note || "QR order", trackingToken, 0, null, null, null, null, guestCustomer.id, priceChannel, qrChannel?.label || "Slash"]
                );
                const order = orderResult.rows[0];
                const itemValues = [];
                const itemRows = orderLines.map((line, index) => {
                    const offset = index * 11;
                    itemValues.push(order.id,line.menuId,line.variantId,line.itemName,line.price,line.quantity,line.lineTotal,line.unit,line.taxRate,line.taxMode,JSON.stringify(line.options || []));
                    return "($" + (offset+1) + ",$" + (offset+2) + ",$" + (offset+3) + ",$" + (offset+4) + ",$" + (offset+5) + ",$" + (offset+6) + ",$" + (offset+7) + ",$" + (offset+8) + ",$" + (offset+9) + ",$" + (offset+10) + ",$" + (offset+11) + "::jsonb)";
                });
                await client.query(
                    "INSERT INTO order_items(order_id,menu_id,variant_id,item_name,price,quantity,line_total,unit,tax_rate,tax_mode,options) VALUES " + itemRows.join(","),
                    itemValues
                );
                if (businessSettings.kotEnabled !== false) await createKOTForOrder(client, businessId, order.id);
                if (orderType === "Dine-in") {
                    await client.query("UPDATE restaurant_tables SET status='Occupied' WHERE business_id=$1 AND table_number::text=$2", [businessId, tableNumber]);
                }
                await client.query("COMMIT");
                return { success: true, orderId: order.id, orderNumber: order.order_number, tableNumber: order.table_number, sourceTableNumber: tableNumber, orderType, total: Number(order.total), status: order.status, trackingToken };
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            } finally {
                client.release();
            }
        });
        res.status(201).json(result);
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        console.error("Place QR table order error:", error);
        res.status(500).json({ error: "Could not place the QR order" });
    }
});

app.get("/public-menu/:token/orders/:orderId", async (req, res) => {
    const token = String(req.params.token || "");
    const orderId = Number(req.params.orderId);
    const trackingToken = String(req.query?.tracking || "");
    if (!/^[a-f0-9]{48}$/i.test(token) || !Number.isInteger(orderId) || orderId <= 0 || !/^[a-f0-9]{48}$/i.test(trackingToken)) {
        return res.status(404).json({ error: "Order not found" });
    }
    try {
        const access = await runSystemContext(() => pool.query("SELECT business_id, enabled FROM public_menu_settings WHERE token=$1 LIMIT 1", [token]));
        const publication = access.rows[0];
        if (!publication || !(await businessHasLicenseAddon(publication.business_id, "Table QR"))) return res.status(404).json({ error: "Order not found" });
        const businessId = Number(publication.business_id);
        const data = await tenantContext.run({ businessId }, async () => {
            const orderResult = await pool.query(`SELECT o.id, o.order_number, o.order_type, o.table_number, o.status, o.subtotal, o.gst, o.total, o.created_at,
                    COALESCE(paid.amount_collected,0) AS amount_collected,
                    GREATEST(o.total-COALESCE(paid.amount_collected,0),0) AS amount_due,
                    COALESCE(paid.amount_collected,0) >= o.total AS is_paid
                FROM orders o
                LEFT JOIN LATERAL (
                    SELECT SUM(amount) AS amount_collected
                    FROM payments
                    WHERE business_id=o.business_id AND order_id=o.id AND payment_status='Success'
                ) paid ON TRUE
                WHERE o.business_id=$1 AND o.id=$2 AND o.public_tracking_token=$3 AND o.order_number LIKE 'QR-%' LIMIT 1`,
                [businessId, orderId, trackingToken]);
            const order = orderResult.rows[0];
            if (!order) return null;
            const lines = await pool.query("SELECT item_name, quantity, price, line_total, options FROM order_items WHERE business_id=$1 AND order_id=$2 ORDER BY id", [businessId, orderId]);
            return { ...order, items: lines.rows };
        });
        if (!data) return res.status(404).json({ error: "Order not found" });
        res.set("Cache-Control", "no-store").json({ order: { ...data, subtotal: Number(data.subtotal || 0), gst: Number(data.gst || 0), total: Number(data.total || 0), amount_collected: Number(data.amount_collected || 0), amount_due: Number(data.amount_due || 0), is_paid: data.is_paid === true, items: data.items.map(item => ({ ...item, quantity: Number(item.quantity || 0), price: Number(item.price || 0), line_total: Number(item.line_total || 0) })) } });
    } catch (error) {
        console.error("Public QR order status error:", error);
        res.status(500).json({ error: "Could not load this order" });
    }
});
app.use("/api", requireAuth);

// =====================================================
// MENU
// =====================================================
// =====================================================
// MENU CATEGORIES
// =====================================================

app.get("/api/menu/public-settings", async (req, res) => {
    try {
        const businessId = Number(req.user.business_id);
        await pool.query(
            "INSERT INTO public_menu_settings(business_id, token) VALUES($1,$2) ON CONFLICT (business_id) DO NOTHING",
            [businessId, crypto.randomBytes(24).toString("hex")]
        );
        const result = await pool.query(
            "SELECT enabled, price_channel, token, public_base_url FROM public_menu_settings WHERE business_id=$1",
            [businessId]
        );
        const settings = result.rows[0];
        const appSettingsResult = await pool.query("SELECT settings FROM app_settings WHERE business_id=$1 LIMIT 1", [businessId]);
        const qrMenuChannels = salesChannelsForSettings(appSettingsResult.rows[0]?.settings || {}).filter(channel => channel.qrMenu);
        const selectedQrChannel = qrMenuChannels.find(channel => channel.key === settings.price_channel) || qrMenuChannels.find(channel => channel.key === "online") || qrMenuChannels[0];
        const requestHost = String(req.hostname || "").toLowerCase();
        const localNetworkUrl = ["localhost", "127.0.0.1", "::1"].includes(requestHost) ? getLocalNetworkMenuUrl() : null;
        res.json({
            enabled: settings.enabled,
            priceChannel: selectedQrChannel?.key || "online",
            priceChannelLabel: selectedQrChannel?.label || "Slash",
            qrMenuChannels,
            token: settings.token,
            publicBaseUrl: settings.public_base_url || "",
            localNetworkUrl
        });
    } catch (error) {
        console.error("Load public menu settings error:", error);
        res.status(500).json({ error: "Could not load restaurant menu settings" });
    }
});

app.put("/api/menu/public-settings", async (req, res) => {
    const businessId = Number(req.user.business_id);
    const enabled = req.body.enabled === true;
    const requestedPriceChannel = String(req.body.priceChannel || "online").trim().toLowerCase();
    const hasPublicBaseUrl = Object.prototype.hasOwnProperty.call(req.body || {}, "publicBaseUrl");
    let publicBaseUrl = null;
    if (hasPublicBaseUrl) {
        const rawBaseUrl = String(req.body.publicBaseUrl || "").trim();
        if (rawBaseUrl) {
            try {
                const parsed = new URL(rawBaseUrl);
                if (!["http:", "https:"].includes(parsed.protocol) ||
                    parsed.username || parsed.password || parsed.pathname !== "/" ||
                    parsed.search || parsed.hash) {
                    return res.status(400).json({ error: "Enter only the website address, such as https://your-cafe-domain.com" });
                }
                publicBaseUrl = parsed.origin;
            } catch (_) {
                return res.status(400).json({ error: "Enter a valid website address, such as https://your-cafe-domain.com" });
            }
        }
    }
    try {
        const appSettingsResult = await pool.query("SELECT settings FROM app_settings WHERE business_id=$1 LIMIT 1", [businessId]);
        const qrMenuChannels = salesChannelsForSettings(appSettingsResult.rows[0]?.settings || {}).filter(channel => channel.qrMenu);
        if (!qrMenuChannels.some(channel => channel.key === requestedPriceChannel)) return res.status(400).json({ error: "Choose an active QR Menu sale channel." });
        const priceChannel = requestedPriceChannel;
        const result = await pool.query(
            `INSERT INTO public_menu_settings(business_id, token, enabled, price_channel, public_base_url)
             VALUES($1,$2,$3,$4,CASE WHEN $5 THEN $6 ELSE NULL END)
             ON CONFLICT (business_id) DO UPDATE
             SET enabled=EXCLUDED.enabled,
                 price_channel=EXCLUDED.price_channel,
                 public_base_url=CASE WHEN $5 THEN EXCLUDED.public_base_url ELSE public_menu_settings.public_base_url END,
                 updated_at=CURRENT_TIMESTAMP
             RETURNING enabled, price_channel, token, public_base_url`,
            [businessId, crypto.randomBytes(24).toString("hex"), enabled, priceChannel, hasPublicBaseUrl, publicBaseUrl]
        );
        const settings = result.rows[0];
        const requestHost = String(req.hostname || "").toLowerCase();
        const localNetworkUrl = ["localhost", "127.0.0.1", "::1"].includes(requestHost) ? getLocalNetworkMenuUrl() : null;
        res.json({
            success: true,
            enabled: settings.enabled,
            priceChannel: settings.price_channel,
            priceChannelLabel: qrMenuChannels.find(channel => channel.key === settings.price_channel)?.label || "Slash",
            qrMenuChannels,
            token: settings.token,
            publicBaseUrl: settings.public_base_url || "",
            localNetworkUrl
        });
    } catch (error) {
        console.error("Save public menu settings error:", error);
        res.status(500).json({ error: "Could not save restaurant menu settings" });
    }
});

app.post("/api/menu/public-settings/qr", async (req, res) => {
    const businessId = Number(req.user?.business_id);
    const targetUrlText = String(req.body?.url || "").trim();
    try {
        const settings = await pool.query(
            "SELECT token FROM public_menu_settings WHERE business_id=$1",
            [businessId]
        );
        if (!settings.rows.length) return res.status(404).json({ error: "Guest menu link not found" });

        let targetUrl;
        try {
            targetUrl = new URL(targetUrlText);
        } catch (_) {
            return res.status(400).json({ error: "The guest menu link is not valid" });
        }
        const expectedPath = `/restaurant/${settings.rows[0].token}`;
        const queryEntries = [...targetUrl.searchParams.entries()];
        if (!(["http:", "https:"].includes(targetUrl.protocol) &&
            !targetUrl.username && !targetUrl.password && !targetUrl.hash &&
            targetUrl.pathname === expectedPath) ||
            queryEntries.length > 1 ||
            queryEntries.some(([key, value]) => key !== "table" || !value.trim() || value.length > 60 || /[\u0000-\u001f\u007f]/.test(value))) {
            return res.status(400).json({ error: "Choose the guest menu link for this POS account" });
        }
        if (queryEntries.length) {
            const tableNumber = queryEntries[0][1].trim();
            const tableResult = await pool.query(
                "SELECT id FROM restaurant_tables WHERE business_id=$1 AND table_number::text=$2 LIMIT 1",
                [businessId, tableNumber]
            );
            if (!tableResult.rows.length) return res.status(400).json({ error: "Choose a table configured in this POS account" });
        }

        const dataUrl = await QRCode.toDataURL(targetUrl.toString(), {
            errorCorrectionLevel: "M",
            margin: 3,
            width: 640,
            color: { dark: "#111827", light: "#FFFFFF" }
        });
        res.json({ dataUrl });
    } catch (error) {
        console.error("Generate restaurant menu QR error:", error);
        res.status(500).json({ error: "Could not generate the guest menu QR code" });
    }
});

app.get("/api/menu/categories", async (req, res) => {
    try {
        const businessId = Number(req.user.business_id);
        const result = await pool.query(`
            SELECT
                id,
                name,
                sort_order,
                active,
                created_at,
                updated_at
            FROM menu_categories
            WHERE business_id = $1
            ORDER BY sort_order ASC, name ASC, id ASC
        `, [businessId]);

        res.json(result.rows);
    } catch (e) {
        console.error("Load menu categories error:", e);
        res.status(500).json({ error: "Failed to load menu categories" });
    }
});


app.post("/api/menu/categories", async (req, res) => {
    try {
        const businessId = Number(req.user.business_id);
        const name = String(req.body.name || "").trim();
        const sortOrder = Number(req.body.sortOrder || 0);
        const active = req.body.active !== false;

        if (!name) {
            return res.status(400).json({ error: "Category name is required" });
        }

        const result = await pool.query(`
            INSERT INTO menu_categories
            (name, sort_order, active, business_id)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `, [
            name,
            Number.isFinite(sortOrder) ? sortOrder : 0,
            active,
            businessId
        ]);

        res.status(201).json(result.rows[0]);
    } catch (e) {
        console.error("Create menu category error:", e);
        if (e.code === "23505") return res.status(409).json({ error: "Menu category already exists" });
        res.status(500).json({ error: "Failed to create menu category" });
    }
});


app.put("/api/menu/categories/:id", async (req, res) => {
    try {
        const businessId = Number(req.user.business_id);
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid category ID" });

        const name = String(req.body.name || "").trim();
        const sortOrder = Number(req.body.sortOrder || 0);
        const active = req.body.active !== false;
        if (!name) return res.status(400).json({ error: "Category name is required" });

        const result = await pool.query(`
            UPDATE menu_categories
            SET name = $1,
                sort_order = $2,
                active = $3,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $4
              AND business_id = $5
            RETURNING *
        `, [
            name,
            Number.isFinite(sortOrder) ? sortOrder : 0,
            active,
            id,
            businessId
        ]);

        if (!result.rows.length) return res.status(404).json({ error: "Menu category not found" });
        res.json(result.rows[0]);
    } catch (e) {
        console.error("Update menu category error:", e);
        if (e.code === "23505") return res.status(409).json({ error: "Menu category already exists" });
        res.status(500).json({ error: "Failed to update menu category" });
    }
});


app.delete("/api/menu/categories/:id", async (req, res) => {
    try {
        const businessId = Number(req.user.business_id);
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid category ID" });

        const result = await pool.query(`
            DELETE FROM menu_categories
            WHERE id = $1
              AND business_id = $2
            RETURNING id
        `, [id, businessId]);

        if (!result.rows.length) return res.status(404).json({ error: "Menu category not found" });
        res.json({ success: true });
    } catch (e) {
        console.error("Delete menu category error:", e);
        res.status(500).json({ error: "Failed to delete menu category" });
    }
});

app.get(
    "/api/menu",
    async (req, res) => {
        try {
            const businessId = Number(req.user.business_id);
            const result = await pool.query(
                `SELECT m.*, kg.name AS kot_group_name, kg.station AS kot_group_station
                 FROM menu m
                 LEFT JOIN kot_groups kg ON kg.id=m.kot_group_id AND kg.business_id=$1
                 WHERE m.business_id=$1
                 ORDER BY m.category, m.name, m.id`,
                [businessId]
            );
            const items = result.rows;
            const variants = await pool.query(`
                SELECT mv.id, mv.menu_id, mv.name, mv.sku, mv.price, mv.unit, mv.channel_prices, mv.available
                FROM menu_variants mv
                INNER JOIN menu m ON m.id=mv.menu_id AND m.business_id=$1
                WHERE mv.business_id=$1
                ORDER BY mv.menu_id, mv.id
            `, [businessId]);
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
    for (const key of Object.keys(src)) {
        if (!/^[a-z][a-z0-9_]{1,19}$/.test(key)) continue;
        const n = Number(src[key]);
        if (Number.isFinite(n) && n >= 0) result[key] = n;
    }
    return result;
}

function cleanMenuSalesChannels(value, settings) {
    const allowed = new Set(salesChannelsForSettings(settings).map(channel => channel.key));
    if (value === undefined || value === null) return [...allowed];
    if (!Array.isArray(value)) throw Object.assign(new Error("Choose at least one active sale channel for this item."), { status: 400 });
    const selected = [...new Set(value.map(key => String(key || "").trim().toLowerCase()))];
    if (!selected.length || selected.some(key => !allowed.has(key))) {
        throw Object.assign(new Error("Choose one or more currently active sale channels for this item."), { status: 400 });
    }
    return selected;
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

function cleanMenuSku(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    if (raw.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(raw)) {
        throw Object.assign(new Error("SKU must be up to 80 characters and use letters, numbers, dots, underscores, slashes or hyphens."), { status: 400 });
    }
    return raw.toUpperCase();
}

function generateMenuSku() {
    return `SKU-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
}

async function generateUniqueMenuSku(queryable, businessId) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const sku = generateMenuSku();
        const existing = await queryable.query("SELECT 1 FROM menu WHERE business_id=$1 AND UPPER(sku)=UPPER($2) LIMIT 1", [businessId, sku]);
        if (!existing.rows.length) return sku;
    }
    throw Object.assign(new Error("Could not generate a unique SKU. Try saving the item again."), { status: 503 });
}

function menuSkuErrorResponse(error, fallback) {
    if (error?.code === "23505" && error?.constraint === "idx_menu_business_sku_unique") {
        return { status: 409, message: "That SKU is already used by another menu item in this cafe. Choose a different SKU or leave it blank to generate one." };
    }
    return { status: error?.status || 500, message: error?.status ? error.message : fallback };
}

function cleanMenuImage(value, existingValue = null) {
    if (value === null || value === undefined || value === "") return null;
    const image = String(value);
    if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) {
        throw Object.assign(new Error("Choose a JPG, PNG or WebP image."), { status: 400 });
    }
    if (image !== existingValue && Buffer.from(image.slice(image.indexOf(",") + 1), "base64").length > 200 * 1024) {
        throw Object.assign(new Error("Menu item images must be 200 KB or smaller after compression."), { status: 413 });
    }
    return image;
}

function cleanMenuOptionSetIds(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(id => String(id || "").trim()).filter(id => /^[a-zA-Z0-9_-]{1,80}$/.test(id)))].slice(0, 30);
}

function cleanOrderOptions(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 30).map(set => ({
        setId: String(set?.setId || "").slice(0, 80),
        setName: String(set?.setName || "").trim().slice(0, 100),
        options: (Array.isArray(set?.options) ? set.options : []).slice(0, 50).map(option => ({
            id: String(option?.id || "").slice(0, 80),
            name: String(option?.name || "").trim().slice(0, 100),
            price: Math.max(0, Number(option?.price || 0))
        })).filter(option => option.name && Number.isFinite(option.price))
    })).filter(set => set.setName && set.options.length);
}

async function normalizeOrderItemOptions(db, businessId, menuItem, value, suppliedBasePrice, suppliedPrice) {
    const submitted = cleanOrderOptions(value);
    const assignedIds = Array.isArray(menuItem?.option_set_ids) ? menuItem.option_set_ids.map(String) : [];
    if (!assignedIds.length) {
        if (submitted.length) throw new Error("This item does not have those options available.");
        return { options: [], addOnPrice: 0 };
    }
    const settingsResult = await db.query("SELECT settings->'menuOptionSets' AS sets FROM app_settings WHERE business_id=$1", [businessId]);
    const allSets = Array.isArray(settingsResult.rows[0]?.sets) ? settingsResult.rows[0].sets : [];
    const configured = allSets.filter(set => assignedIds.includes(String(set.id)));
    const selectedBySet = new Map(submitted.map(set => [String(set.setId), set]));
    const options = [];
    let addOnPrice = 0;
    for (const set of configured) {
        const selected = selectedBySet.get(String(set.id));
        const choices = Array.isArray(selected?.options) ? selected.options : [];
        const min = Math.max(0, Number(set.minSelections) || 0);
        const max = Math.max(1, Number(set.maxSelections) || 1);
        if (choices.length < min || choices.length > max) throw new Error(`Choose ${min === max ? min : `${min} to ${max}`} option${max === 1 ? "" : "s"} for ${set.name}.`);
        const authoritative = [];
        for (const choice of choices) {
            const saved = (set.options || []).find(option => String(option.id) === String(choice.id));
            if (!saved) throw new Error(`An option for ${set.name} is no longer available.`);
            const price = Math.max(0, Number(saved.price) || 0);
            addOnPrice += price;
            authoritative.push({ id: String(saved.id), name: String(saved.name), price });
        }
        if (authoritative.length) options.push({ setId: String(set.id), setName: String(set.name), options: authoritative });
        selectedBySet.delete(String(set.id));
    }
    if (selectedBySet.size) throw new Error("One of the selected options is not available for this item.");
    const basePrice = Number(suppliedBasePrice);
    const finalPrice = Number(suppliedPrice);
    if (Number.isFinite(basePrice) && Number.isFinite(finalPrice) && Math.abs((basePrice + addOnPrice) - finalPrice) > 0.02) {
        throw new Error("Item total does not match the selected option prices. Reopen the item and choose its options again.");
    }
    return { options, addOnPrice };
}

async function replaceMenuVariants(client, menuId, variants) {
    const businessId = Number(tenantContext.getStore()?.businessId || 0);
    if (!businessId) throw new Error("Business context is missing");

    const owner = await client.query(
        `SELECT id FROM menu WHERE id=$1 AND business_id=$2 LIMIT 1`,
        [menuId, businessId]
    );
    if (!owner.rows.length) throw new Error("Menu item not found for current business");

    await client.query(`DELETE FROM menu_variants WHERE menu_id=$1 AND business_id=$2`, [menuId, businessId]);
    for (const v of variants) {
        await client.query(`
            INSERT INTO menu_variants(menu_id,name,sku,price,unit,channel_prices,available,business_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        `, [menuId, v.name, v.sku, v.price, v.unit, JSON.stringify(v.channelPrices), v.available, businessId]);
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
            const imageUrl = cleanMenuImage(req.body.imageUrl);
            const optionSetIds = cleanMenuOptionSetIds(req.body.optionSetIds);
            const requestedSku = cleanMenuSku(req.body.sku);
            const sku = requestedSku || await generateUniqueMenuSku(client, Number(req.user.business_id));
            const description = String(req.body.description || "").trim().slice(0, 2000);
            if (!name || !Number.isFinite(price) || price < 0 || !category) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: "Name, price and category are required" });
            }
            const businessId = Number(req.user.business_id);
            const settingsResult = await client.query("SELECT settings FROM app_settings WHERE business_id=$1 LIMIT 1", [businessId]);
            const salesChannels = cleanMenuSalesChannels(req.body.salesChannels, settingsResult.rows[0]?.settings || {});
            const result = await client.query(`
                INSERT INTO menu(name,price,category,available,kot_group_id,nature,unit,tax_rate,cgst_rate,sgst_rate,igst_rate,tax_mode,tax_label,channel_prices,image_url,option_set_ids,business_id,sku,description,sales_channels)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
                RETURNING *
            `, [name, price, category, available, kotGroupId, nature, unit, tax.taxRate, tax.cgstRate, tax.sgstRate, tax.igstRate, taxMode, tax.taxLabel, JSON.stringify(channelPrices), imageUrl, JSON.stringify(optionSetIds), businessId, sku, description, JSON.stringify(salesChannels)]);
            await replaceMenuVariants(client, result.rows[0].id, variants);
            await client.query('COMMIT');
            res.status(201).json({ success: true, menu: result.rows[0] });
        } catch (e) {
            await client.query('ROLLBACK');
            console.error(e);
            const failure = menuSkuErrorResponse(e, "Failed to add menu item");
            res.status(failure.status).json({ error: failure.message });
        } finally { client.release(); }
    }
);

app.post("/api/menu/import", async (req, res) => {
    const rows = req.body?.items;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: "Choose at least one valid menu item to import." });
    if (rows.length > 500) return res.status(400).json({ error: "Import up to 500 menu items at a time." });
    const mode = ["insert", "update", "upsert"].includes(req.body?.mode) ? req.body.mode : "insert";

    const businessId = Number(req.user?.business_id);
    if (!Number.isInteger(businessId) || businessId <= 0) return res.status(403).json({ error: "A valid business account is required to import menu items." });
    const client = await pool.connect();
    const skipped = [];
    const warnings = [];
    const seenNames = new Set();
    const seenSkus = new Set();
    let imported = 0;
    let updated = 0;
    let categoriesCreated = 0;
    try {
        await client.query("BEGIN");
        await client.query(`SELECT set_config('app.business_id',$1,TRUE),set_config('app.system_mode','off',TRUE)`, [String(businessId)]);
        const channelSettingsResult = await client.query("SELECT settings FROM app_settings WHERE business_id=$1 LIMIT 1", [businessId]);
        const channelSettings = channelSettingsResult.rows[0]?.settings || {};
        for (let index = 0; index < rows.length; index += 1) {
            const source = rows[index] && typeof rows[index] === "object" ? rows[index] : {};
            const name = String(source.name || "").trim();
            const category = String(source.category || "").trim();
            const price = Number(source.price);
            let requestedSku;
            try { requestedSku = cleanMenuSku(source.sku); }
            catch (error) {
                skipped.push({ row: Number(source.rowNumber) || index + 2, name, reason: error.message });
                continue;
            }
            if (!name || !category || !Number.isFinite(price) || price < 0) {
                skipped.push({ row: Number(source.rowNumber) || index + 2, name, reason: "Item name, category and a non-negative price are required." });
                continue;
            }

            const nameKey = name.toLocaleLowerCase();
            if (seenNames.has(nameKey)) {
                skipped.push({ row: Number(source.rowNumber) || index + 2, name, reason: "This item name appears more than once in the spreadsheet." });
                continue;
            }
            seenNames.add(nameKey);

            const existing = await client.query(
                `SELECT id,sku,description,available,kot_group_id,nature,unit,tax_rate,cgst_rate,sgst_rate,igst_rate,tax_mode,tax_label,channel_prices,sales_channels
                 FROM menu WHERE business_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`,
                [businessId, name]
            );
            const current = existing.rows[0] || null;
            if (current && mode === "insert") {
                skipped.push({ row: Number(source.rowNumber) || index + 2, name, reason: "An item with this name already exists for this business." });
                continue;
            }
            if (!current && mode === "update") {
                skipped.push({ row: Number(source.rowNumber) || index + 2, name, reason: "No existing item with this name was found to update." });
                continue;
            }

            const skuKey = requestedSku ? requestedSku.toLocaleUpperCase() : "";
            if (skuKey && seenSkus.has(skuKey)) {
                skipped.push({ row: Number(source.rowNumber) || index + 2, name, reason: "This SKU appears more than once in the spreadsheet." });
                continue;
            }
            if (skuKey) {
                const duplicateSku = await client.query(
                    "SELECT id FROM menu WHERE business_id=$1 AND UPPER(sku)=UPPER($2) AND ($3::int IS NULL OR id<>$3) LIMIT 1",
                    [businessId, requestedSku, current?.id || null]
                );
                if (duplicateSku.rows.length) {
                    skipped.push({ row: Number(source.rowNumber) || index + 2, name, reason: "This SKU is already assigned to another item in this cafe." });
                    continue;
                }
                seenSkus.add(skuKey);
            }

            const categoryResult = await client.query(
                `SELECT id FROM menu_categories WHERE business_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`,
                [businessId, category]
            );
            if (!categoryResult.rows.length) {
                await client.query(
                    `INSERT INTO menu_categories(name,sort_order,active,business_id) VALUES($1,0,TRUE,$2)`,
                    [category, businessId]
                );
                categoriesCreated += 1;
            }

            const kotGroupId = current?.kot_group_id || null;

            const nature = ["Goods", "Service"].includes(source.nature) ? source.nature : current?.nature || "Goods";
            const unit = String(source.unit || current?.unit || "ea").trim().slice(0, 20) || "ea";
            const available = source.available === null || source.available === undefined ? current?.available !== false : source.available !== false;
            const taxSource = {
                ...source,
                taxRate: source.taxRate ?? current?.tax_rate ?? 5,
                cgstRate: source.taxRate === null || source.taxRate === undefined ? current?.cgst_rate : undefined,
                sgstRate: source.taxRate === null || source.taxRate === undefined ? current?.sgst_rate : undefined,
                igstRate: source.taxRate === null || source.taxRate === undefined ? current?.igst_rate : undefined,
                taxLabel: source.taxRate === null || source.taxRate === undefined ? current?.tax_label : undefined
            };
            const tax = normaliseTaxPayload(taxSource);
            const taxMode = ["inclusive", "exclusive"].includes(source.taxMode) ? source.taxMode : current?.tax_mode || "exclusive";
            const channelPrices = cleanChannelPrices({ ...(current?.channel_prices || {}), ...(source.channelPrices || {}) });
            const salesChannels = cleanMenuSalesChannels(source.salesChannels == null ? current?.sales_channels : source.salesChannels, channelSettings);
            const sku = requestedSku || current?.sku || await generateUniqueMenuSku(client, businessId);
            const description = String(source.description || current?.description || "").trim().slice(0, 2000);
            if (current) {
                await client.query(`
                    UPDATE menu SET name=$1,price=$2,category=$3,available=$4,kot_group_id=$5,nature=$6,unit=$7,
                        tax_rate=$8,cgst_rate=$9,sgst_rate=$10,igst_rate=$11,tax_mode=$12,tax_label=$13,channel_prices=$14,sku=$15,description=$16,sales_channels=$17
                    WHERE id=$18 AND business_id=$19
                `, [name, price, category, available, kotGroupId, nature, unit, tax.taxRate, tax.cgstRate, tax.sgstRate, tax.igstRate, taxMode, tax.taxLabel, JSON.stringify(channelPrices), sku, description, JSON.stringify(salesChannels), current.id, businessId]);
                updated += 1;
            } else {
                await client.query(`
                    INSERT INTO menu(name,price,category,available,kot_group_id,nature,unit,tax_rate,cgst_rate,sgst_rate,igst_rate,tax_mode,tax_label,channel_prices,business_id,sku,description,sales_channels)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                `, [name, price, category, available, kotGroupId, nature, unit, tax.taxRate, tax.cgstRate, tax.sgstRate, tax.igstRate, taxMode, tax.taxLabel, JSON.stringify(channelPrices), businessId, sku, description, JSON.stringify(salesChannels)]);
                imported += 1;
            }
        }
        await client.query("COMMIT");
        res.status(201).json({ success: true, imported, updated, categoriesCreated, skipped, warnings });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Menu import error:", error);
        const failure = menuSkuErrorResponse(error, "Menu import failed");
        res.status(failure.status).json({ error: failure.message });
    } finally {
        client.release();
    }
});

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
            const tax = normaliseTaxPayload(req.body);
            const taxMode = ['inclusive','exclusive'].includes(req.body.taxMode) ? req.body.taxMode : 'exclusive';
            const channelPrices = cleanChannelPrices(req.body.channelPrices);
            const variants = cleanVariants(req.body.variants);
            const currentImage = await client.query("SELECT image_url,sku,description,sales_channels,kot_group_id FROM menu WHERE id=$1 AND business_id=$2 FOR UPDATE", [req.params.id, Number(req.user.business_id)]);
            if (!currentImage.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Menu item not found" }); }
            const kotGroupId = req.body.kotGroupId === undefined ? currentImage.rows[0].kot_group_id : (req.body.kotGroupId ? Number(req.body.kotGroupId) : null);
            const settingsResult = await client.query("SELECT settings FROM app_settings WHERE business_id=$1 LIMIT 1", [Number(req.user.business_id)]);
            const salesChannels = cleanMenuSalesChannels(req.body.salesChannels === undefined ? currentImage.rows[0].sales_channels : req.body.salesChannels, settingsResult.rows[0]?.settings || {});
            const imageUrl = cleanMenuImage(req.body.imageUrl, currentImage.rows[0].image_url);
            const optionSetIds = cleanMenuOptionSetIds(req.body.optionSetIds);
            const sku = req.body.sku === undefined ? currentImage.rows[0].sku : cleanMenuSku(req.body.sku) || await generateUniqueMenuSku(client, Number(req.user.business_id));
            const description = req.body.description === undefined ? currentImage.rows[0].description : String(req.body.description || "").trim().slice(0, 2000);
            if (!name || !Number.isFinite(price) || price < 0 || !category) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: "Name, price and category are required" });
            }
            const result = await client.query(`
                UPDATE menu SET name=$1, price=$2, category=$3, kot_group_id=$4,
                    nature=$5, unit=$6, tax_rate=$7, cgst_rate=$8, sgst_rate=$9, igst_rate=$10,
                    tax_mode=$11, tax_label=$12, channel_prices=$13, image_url=$14, option_set_ids=$15, sku=$16, description=$17, sales_channels=$18
                WHERE id=$19 AND business_id=$20 RETURNING *
            `, [name, price, category, kotGroupId, nature, unit, tax.taxRate, tax.cgstRate, tax.sgstRate, tax.igstRate, taxMode, tax.taxLabel, JSON.stringify(channelPrices), imageUrl, JSON.stringify(optionSetIds), sku, description, JSON.stringify(salesChannels), req.params.id, Number(req.user.business_id)]);
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
            const failure = menuSkuErrorResponse(e, "Failed to update menu item");
            res.status(failure.status).json({ error: failure.message });
        } finally { client.release(); }
    }
);


app.patch("/api/menu/:id/prices", async (req, res) => {
    const id = Number(req.params.id);
    const businessId = Number(req.user.business_id);
    const price = Number(req.body.price);
    const channelPrices = cleanChannelPrices(req.body.channelPrices);
    const variantPrices = Array.isArray(req.body.variants) ? req.body.variants : [];
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(price) || price < 0) {
        return res.status(400).json({ error: "Enter a valid item price" });
    }
    if (variantPrices.some(row => !Number.isInteger(Number(row.id)) || !Number.isFinite(Number(row.price)) || Number(row.price) < 0)) {
        return res.status(400).json({ error: "Enter valid prices for every variant" });
    }
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query(
            "UPDATE menu SET price=$1, channel_prices=$2 WHERE id=$3 AND business_id=$4 RETURNING id, price, channel_prices",
            [price, JSON.stringify(channelPrices), id, businessId]
        );
        if (!result.rows.length) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Menu item not found" });
        }
        for (const variant of variantPrices) {
            const updated = await client.query(
                "UPDATE menu_variants SET price=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND menu_id=$3 AND business_id=$4 RETURNING id",
                [Number(variant.price), Number(variant.id), id, businessId]
            );
            if (!updated.rows.length) throw Object.assign(new Error("A menu variant could not be found"), { status: 400 });
        }
        await client.query("COMMIT");
        res.json({ success: true, menu: result.rows[0] });
    } catch (error) {
        await client.query("ROLLBACK");
        res.status(error.status || 500).json({ error: error.status ? error.message : "Could not update menu prices" });
    } finally {
        client.release();
    }
});

app.patch("/api/menu/:id/qr-stock", async (req, res) => {
    const id = Number(req.params.id);
    const businessId = Number(req.user.business_id);
    if (!Number.isInteger(id) || id <= 0 || typeof req.body.inStock !== "boolean") {
        return res.status(400).json({ error: "Choose whether this item is in stock for the QR menu" });
    }
    try {
        const result = await pool.query(
            "UPDATE menu SET qr_available=$1 WHERE id=$2 AND business_id=$3 RETURNING id, qr_available",
            [req.body.inStock, id, businessId]
        );
        if (!result.rows.length) return res.status(404).json({ error: "Menu item not found" });
        res.json({ success: true, item: result.rows[0] });
    } catch (error) {
        console.error("Update QR menu stock error:", error);
        res.status(500).json({ error: "Could not update QR menu stock" });
    }
});

app.get("/api/menu/:id/variants", async (req,res)=>{
    try {
        const businessId = Number(req.user.business_id);
        const r = await pool.query(`
            SELECT mv.*
            FROM menu_variants mv
            INNER JOIN menu m ON m.id=mv.menu_id AND m.business_id=$2
            WHERE mv.menu_id=$1 AND mv.business_id=$2
            ORDER BY mv.id
        `, [req.params.id, businessId]);
        res.json(r.rows);
    } catch(e){ res.status(500).json({error:"Failed to load variants"}); }
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
                      AND business_id = $2
                    RETURNING *
                    `,
                    [req.params.id, Number(req.user.business_id)]
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
                      AND business_id = $2
                    RETURNING *
                    `,
                    [req.params.id, Number(req.user.business_id)]
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
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT *
                FROM restaurant_tables
                WHERE business_id = $1
                ORDER BY id
            `, [Number(req.user.business_id)]);
            res.json(result.rows);
        } catch (e) {
            res.status(500).json({ error: "Failed to load tables" });
        }
    }
);


app.post(
    "/api/tables",
    async (req, res) => {
        try {
            const businessId = Number(req.user.business_id);
            const n = req.body.tableNumber || req.body.table_number;
            const c = Number(req.body.capacity) || 4;
            if (!n) return res.status(400).json({ error: "Table number is required" });

            const result = await pool.query(`
                INSERT INTO restaurant_tables (table_number, capacity, status, business_id)
                VALUES ($1,$2,'Available',$3)
                RETURNING *
            `, [n, c, businessId]);

            res.status(201).json({ success: true, table: result.rows[0] });
        } catch (e) {
            if (e.code === "23505") return res.status(409).json({ error: "Table number already exists" });
            res.status(500).json({ error: "Failed to add table" });
        }
    }
);


app.put(
    "/api/tables/:id",
    async (req, res) => {
        try {
            const businessId = Number(req.user.business_id);
            const n = req.body.tableNumber || req.body.table_number;
            const c = Number(req.body.capacity) || 4;
            if (!n) return res.status(400).json({ error: "Table number is required" });

            const result = await pool.query(`
                UPDATE restaurant_tables
                SET table_number = $1, capacity = $2
                WHERE id = $3 AND business_id = $4
                RETURNING *
            `, [n, c, req.params.id, businessId]);

            if (!result.rows.length) return res.status(404).json({ error: "Table not found" });
            res.json({ success: true, table: result.rows[0] });
        } catch (e) {
            if (e.code === "23505") return res.status(409).json({ error: "Table number already exists" });
            res.status(500).json({ error: "Failed to update table" });
        }
    }
);


app.put(
    "/api/tables/:id/status",
    async (req, res) => {
        try {
            const allowed = ["Available", "Occupied", "Reserved"];
            if (!allowed.includes(req.body.status)) return res.status(400).json({ error: "Invalid table status" });

            const result = await pool.query(`
                UPDATE restaurant_tables
                SET status = $1
                WHERE id = $2 AND business_id = $3
                RETURNING *
            `, [req.body.status, req.params.id, Number(req.user.business_id)]);

            if (!result.rows.length) return res.status(404).json({ error: "Table not found" });
            res.json({ success: true, table: result.rows[0] });
        } catch (e) {
            res.status(500).json({ error: "Failed to update table status" });
        }
    }
);


app.delete(
    "/api/tables/:id",
    async (req, res) => {
        try {
            const businessId = Number(req.user.business_id);
            const tableResult = await pool.query(`
                SELECT * FROM restaurant_tables
                WHERE id = $1 AND business_id = $2
            `, [req.params.id, businessId]);

            if (!tableResult.rows.length) return res.status(404).json({ error: "Table not found" });
            const table = tableResult.rows[0];
            if (table.status === "Occupied") {
                return res.status(400).json({ error: `${table.table_number} is currently occupied. Please make it Available before deleting.` });
            }

            const orders = await pool.query(`
                SELECT COUNT(*) AS count
                FROM orders
                WHERE table_number = $1 AND business_id = $2
            `, [table.table_number, businessId]);
            if (Number(orders.rows[0].count) > 0) {
                return res.status(400).json({ error: `${table.table_number} has existing orders. It cannot be deleted because historical order data must be preserved.` });
            }

            const reservations = await pool.query(`
                SELECT COUNT(*) AS count
                FROM reservations
                WHERE table_number = $1 AND business_id = $2
            `, [table.table_number, businessId]);
            if (Number(reservations.rows[0].count) > 0) {
                return res.status(400).json({ error: `${table.table_number} has reservation records. It cannot be deleted.` });
            }

            await pool.query(`DELETE FROM restaurant_tables WHERE id = $1 AND business_id = $2`, [req.params.id, businessId]);
            res.json({ success: true, table });
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: "Failed to delete table" });
        }
    }
);


// =====================================================
// ORDERS
// =====================================================

function orderActivityActorLabel(req) {
    return String(req?.user?.display_name || req?.user?.username || "Staff").trim().slice(0, 160) || "Staff";
}

async function recordOrderActivity(db, orderId, eventType, description, req) {
    const businessId = Number(req?.user?.business_id || 0);
    if (!businessId || !Number(orderId)) return;
    const actor = orderActivityActorLabel(req);
    await db.query(`
        INSERT INTO order_activity(order_id,event_type,description,actor,business_id)
        SELECT o.id,$2,$3,$4,$5
        FROM orders o
        WHERE o.id=$1 AND o.business_id=$5
    `, [Number(orderId), String(eventType).slice(0, 100), String(description || ""), actor, businessId]);
}

async function createKOTForOrder(db, businessId, orderId) {
    const items = await db.query(`
        SELECT oi.id AS order_item_id,oi.menu_id,oi.item_name,oi.quantity,oi.options,m.category,m.kot_group_id
        FROM order_items oi
        LEFT JOIN menu m ON m.id=oi.menu_id AND m.business_id=$2
        WHERE oi.order_id=$1
          AND NOT EXISTS (SELECT 1 FROM kot k WHERE k.business_id=$2 AND k.order_item_id=oi.id)
        ORDER BY oi.id
    `, [Number(orderId), Number(businessId)]);
    if (!items.rows.length) return 0;
    const groups = await db.query(`SELECT id,category_names,item_ids,sort_order FROM kot_groups WHERE business_id=$1 AND active=TRUE ORDER BY sort_order,id`, [Number(businessId)]);
    const activeGroupIds = new Set(groups.rows.map(group => Number(group.id)));
    const values=[];
    const rows=items.rows.map((item,index)=>{
        const itemRoute=groups.rows.find(group=>Number(item.menu_id)>0&&Array.isArray(group.item_ids)&&group.item_ids.map(Number).includes(Number(item.menu_id)));
        const categoryRoute=groups.rows.find(group=>item.category&&Array.isArray(group.category_names)&&group.category_names.some(category=>String(category).toLowerCase()===String(item.category).toLowerCase()));
        const legacyGroup=activeGroupIds.has(Number(item.kot_group_id))?Number(item.kot_group_id):null;
        const groupId=Number(itemRoute?.id||categoryRoute?.id||legacyGroup)||null;
        const offset=index*7;
        values.push(Number(orderId),String(item.item_name||"Item"),Number(item.quantity||0),"Pending",groupId,JSON.stringify(item.options||[]),Number(item.order_item_id));
        return `($${offset+1},$${offset+2},$${offset+3},$${offset+4},$${offset+5},$${offset+6}::jsonb,$${offset+7})`;
    });
    await db.query(`INSERT INTO kot(order_id,item_name,quantity,status,kot_group_id,options,order_item_id) VALUES ${rows.join(",")}`,values);
    return items.rows.length;
}

async function calculatePosOrderTotals(db, businessId, sourceItems, orderType, settings, discountValue, serviceChargeValue, channelKey = null) {
    if (!Array.isArray(sourceItems) || !sourceItems.length) throw new Error("At least one order item is required.");
    const items = sourceItems.map(source => {
        const menuId = Number(source?.menuId ?? source?.menu_id ?? source?.id);
        const quantity = Number(source?.quantity);
        const variantId = Number(source?.variantId ?? source?.variant_id) || null;
        if (!Number.isInteger(menuId) || menuId <= 0 || !Number.isInteger(quantity) || quantity <= 0 || quantity > 999 ||
            (variantId !== null && (!Number.isInteger(variantId) || variantId <= 0))) {
            throw new Error("Invalid order item information.");
        }
        return { source, menuId, variantId, quantity, options: cleanOrderOptions(source?.options) };
    });
    const menuIds = [...new Set(items.map(item => item.menuId))];
    const menuRows = await db.query(`
        SELECT id,name,price,channel_prices,sales_channels,unit,tax_rate,tax_mode,category,kot_group_id,option_set_ids
        FROM menu WHERE business_id=$1 AND id=ANY($2::int[]) AND available=TRUE
    `, [Number(businessId), menuIds]);
    const menuById = new Map(menuRows.rows.map(row => [Number(row.id), row]));
    if (menuById.size !== menuIds.length) throw new Error("One of the menu items is no longer available for this business.");
    const variantIds = [...new Set(items.map(item => item.variantId).filter(Boolean))];
    const variantRows = variantIds.length ? await db.query(`
        SELECT id,menu_id,name,price,channel_prices,unit
        FROM menu_variants WHERE business_id=$1 AND id=ANY($2::int[]) AND available=TRUE
    `, [Number(businessId), variantIds]) : { rows: [] };
    const variantsById = new Map(variantRows.rows.map(row => [Number(row.id), row]));
    const saleChannel = resolveSaleChannel(settings, channelKey || defaultSaleChannelForOrderType(settings, orderType), orderType);
    const channel = saleChannel.key;
    for (const item of items) {
        const menu = menuById.get(item.menuId);
        assertMenuItemAvailableOnChannel(menu, settings, channel);
        const variant = item.variantId ? variantsById.get(item.variantId) : null;
        if (item.variantId && (!variant || Number(variant.menu_id) !== item.menuId)) throw new Error("One of the selected item sizes is no longer available.");
        const menuPrices = menu.channel_prices && typeof menu.channel_prices === "object" ? menu.channel_prices : {};
        const variantPrices = variant?.channel_prices && typeof variant.channel_prices === "object" ? variant.channel_prices : {};
        const basePrice = Number(variant ? (variantPrices[channel] ?? variant.price) : (menuPrices[channel] ?? menu.price));
        if (!Number.isFinite(basePrice) || basePrice < 0) throw new Error("One of the menu prices is invalid.");
        const optionData = await normalizeOrderItemOptions(db, businessId, menu, item.options);
        item.name = String(menu.name || "Item") + (variant?.name ? ` - ${variant.name}` : "");
        item.price = basePrice + optionData.addOnPrice;
        item.unit = variant?.unit || menu.unit || "ea";
        item.taxRate = settings.gstCalculationEnabled === false ? 0 : Math.max(0, Number(menu.tax_rate || 0));
        item.taxMode = menu.tax_mode === "inclusive" ? "inclusive" : "exclusive";
        item.options = optionData.options;
        item.kotGroupId = Number(menu.kot_group_id) || null;
        item.category = String(menu.category || "");
    }
    const lineNets = items.map(item => {
        const gross = item.price * item.quantity;
        return item.taxMode === "inclusive" && item.taxRate > 0 ? gross / (1 + item.taxRate / 100) : gross;
    });
    const subtotal = Math.round(lineNets.reduce((sum, value) => sum + value, 0) * 100) / 100;
    const discount = discountValue === undefined || discountValue === null ? 0 : Number(discountValue);
    const serviceCharge = serviceChargeValue === undefined || serviceChargeValue === null ? 0 : Number(serviceChargeValue);
    if (!Number.isFinite(discount) || discount < 0 || discount > subtotal + 0.01) throw new Error("Discount must be between 0 and the order subtotal.");
    if (!Number.isFinite(serviceCharge) || serviceCharge < 0) throw new Error("Service charge is invalid.");
    let discountRemaining = Math.min(discount, subtotal);
    let discountAssigned = 0;
    let gst = 0;
    items.forEach((item, index) => {
        const lineDiscount = index === items.length - 1
            ? Math.min(lineNets[index], discountRemaining)
            : Math.min(lineNets[index], subtotal > 0 ? discount * lineNets[index] / subtotal : 0);
        discountRemaining = Math.max(0, discountRemaining - lineDiscount);
        discountAssigned += lineDiscount;
        gst += Math.max(0, lineNets[index] - lineDiscount) * item.taxRate / 100;
    });
    gst = Math.round(gst * 100) / 100;
    const total = Math.round((Math.max(0, subtotal - discountAssigned) + serviceCharge + gst) * 100) / 100;
    return { items, subtotal, gst, total, discount, serviceCharge };
}

app.post(
    "/api/orders",
    async (req, res) => {

        const b = req.body;

        let orderNumber = "";

        const orderType =
            b.orderType ||
            b.order_type;

        const tableNumber =
            b.tableNumber ||
            b.table_number;
        const pax = orderType === "Dine-in" ? Number(b.pax) || 1 : null;

        let subtotal = 0;
        let gst = 0;
        let total = 0;

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
        const orderStatus = requestedStatus === "Open" ? "Open" : "Pending";
        const createKotRequested = b.createKot !== false;


        if (
            !orderType ||
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
            const businessId = Number(req.user.business_id);
            const settingsRow = await client.query("SELECT settings FROM app_settings WHERE business_id=$1 LIMIT 1", [businessId]);
            const businessSettings = settingsRow.rows[0]?.settings || {};
            const saleChannel = resolveSaleChannel(businessSettings, b.saleChannelKey || defaultSaleChannelForOrderType(businessSettings, orderType), orderType);
            if (b.marketingDealId) assertMarketingDealAvailableForBilling(businessSettings, b.marketingDealId, saleChannel.key);
            await assertBillingAdjustmentAvailableForChannel(client, businessId, b.discountAdjustmentId, saleChannel.key);
            await assertBillingAdjustmentAvailableForChannel(client, businessId, b.chargeAdjustmentId, saleChannel.key);
            const createKot = createKotRequested && businessSettings.kotEnabled !== false;
            const orderPrefix = String(businessSettings.orderPrefix || "ORD-").slice(0, 24);
            orderNumber = orderPrefix + Date.now().toString().slice(-8) + crypto.randomBytes(2).toString("hex").toUpperCase();

            if (orderType === "Dine-in") {

                const tableResult =
                    await client.query(
                        `
                        SELECT *
                        FROM restaurant_tables
                        WHERE table_number = $1 AND business_id = $2
                        FOR UPDATE
                        `,
                        [tableNumber, Number(req.user.business_id)]
                    );

                const table =
                    tableResult.rows[0];


                if (!table) {

                    throw new Error(
                        "Selected table does not exist"
                    );

                }

                if (!Number.isInteger(pax) || pax < 1 || (Number(table.capacity) > 0 && pax > Number(table.capacity))) {
                    throw new Error(`Number of guests must be between 1 and ${Number(table.capacity) || "the table capacity"}`);
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


            const normalizedItems = items.map(item => {
                const rawMenuId = item.menuId ?? item.menu_id ?? item.id ?? null;
                const parsedMenuId = Number(rawMenuId);
                const menuId = Number.isInteger(parsedMenuId) && parsedMenuId > 0 ? parsedMenuId : null;
                const quantity = Number(item.quantity);
                const name = String(item.name || item.item_name || "").trim();
                if (!name || !Number.isFinite(quantity) || quantity <= 0 || quantity > 999 || !menuId) {
                    throw new Error("Invalid order item information");
                }
                return {
                    source: item, name, price: 0, quantity, menuId,
                    variantId: Number(item.variantId ?? item.variant_id) || null,
                    options: cleanOrderOptions(item.options),
                    basePrice: 0
                };
            });
            const menuIds = [...new Set(normalizedItems.map(item => item.menuId).filter(Boolean))];
            const menuMetadata = menuIds.length ? await client.query(
                `SELECT id,name,price,channel_prices,sales_channels,available,unit,tax_rate,tax_mode,kot_group_id,category,option_set_ids FROM menu WHERE id=ANY($1::int[]) AND business_id=$2 AND available=TRUE`,
                [menuIds, businessId]
            ) : { rows: [] };
            const menuMetadataById = new Map(menuMetadata.rows.map(item => [Number(item.id), item]));
            if (menuMetadataById.size !== menuIds.length) throw new Error("One of the menu items is no longer available for this business.");
            const variantIds = [...new Set(normalizedItems.map(item => item.variantId).filter(Boolean))];
            const variantRows = variantIds.length ? await client.query(
                `SELECT id,menu_id,price,channel_prices,unit FROM menu_variants WHERE id=ANY($1::int[]) AND business_id=$2 AND available=TRUE`,
                [variantIds, businessId]
            ) : { rows: [] };
            const variantsById = new Map(variantRows.rows.map(item => [Number(item.id), item]));
            const priceChannel = saleChannel.key;
            for (const item of normalizedItems) {
                const metadata = menuMetadataById.get(item.menuId);
                assertMenuItemAvailableOnChannel(metadata, businessSettings, priceChannel);
                const variant = item.variantId ? variantsById.get(item.variantId) : null;
                if (item.variantId && (!variant || Number(variant.menu_id) !== Number(item.menuId))) throw new Error("One of the selected item sizes is no longer available.");
                const menuPrices = metadata.channel_prices && typeof metadata.channel_prices === "object" ? metadata.channel_prices : {};
                const variantPrices = variant?.channel_prices && typeof variant.channel_prices === "object" ? variant.channel_prices : {};
                const catalogPrice = Number(variant
                    ? (variantPrices[priceChannel] ?? variant.price)
                    : (menuPrices[priceChannel] ?? metadata.price));
                if (!Number.isFinite(catalogPrice) || catalogPrice < 0) throw new Error("One of the menu prices is invalid.");
                item.unit = variant?.unit || metadata.unit || null;
                item.taxRate = businessSettings.gstCalculationEnabled === false ? 0 : Math.max(0, Number(metadata.tax_rate || 0));
                item.taxMode = metadata.tax_mode === "inclusive" ? "inclusive" : "exclusive";
                item.category = String(metadata.category || "");
                item.basePrice = catalogPrice;
                const normalizedOptions = await normalizeOrderItemOptions(client, businessId, metadata, item.source.options);
                item.options = normalizedOptions.options;
                item.price = item.basePrice + normalizedOptions.addOnPrice;
            }
            const lineNetAmounts = normalizedItems.map(item => {
                const gross = item.price * item.quantity;
                return item.taxMode === "inclusive" && item.taxRate > 0 ? gross / (1 + item.taxRate / 100) : gross;
            });
            subtotal = Math.round(lineNetAmounts.reduce((sum, value) => sum + value, 0) * 100) / 100;
            const discount = Number(b.discount || 0);
            const serviceCharge = Number(b.serviceCharge || 0);
            if (!Number.isFinite(discount) || discount < 0 || discount > subtotal + 0.01) throw new Error("Discount must be between 0 and the order subtotal.");
            if (!Number.isFinite(serviceCharge) || serviceCharge < 0) throw new Error("Service charge is invalid.");
            let discountRemaining = Math.min(discount, subtotal);
            let discountAssigned = 0;
            gst = 0;
            normalizedItems.forEach((item, index) => {
                const lineNet = lineNetAmounts[index];
                const lineDiscount = index === normalizedItems.length - 1
                    ? Math.min(lineNet, discountRemaining)
                    : Math.min(lineNet, subtotal > 0 ? discount * lineNet / subtotal : 0);
                discountRemaining = Math.max(0, discountRemaining - lineDiscount);
                discountAssigned += lineDiscount;
                gst += Math.max(0, lineNet - lineDiscount) * item.taxRate / 100;
            });
            gst = Math.round(gst * 100) / 100;
            total = Math.round((Math.max(0, subtotal - discountAssigned) + serviceCharge + gst) * 100) / 100;
            const routeGroups = await client.query(`SELECT id,category_names,item_ids,sort_order FROM kot_groups WHERE business_id=$1 AND active=TRUE ORDER BY sort_order,id`, [businessId]);
            for (const item of normalizedItems) {
                const itemRoute = routeGroups.rows.find(group => Array.isArray(group.item_ids) && group.item_ids.map(Number).includes(Number(item.menuId)));
                const categoryRoute = routeGroups.rows.find(group => Array.isArray(group.category_names) && group.category_names.some(category => String(category).toLowerCase() === item.category.toLowerCase()));
                const legacyGroup = Number(menuMetadataById.get(item.menuId)?.kot_group_id) || null;
                item.kotGroupId = Number(itemRoute?.id || categoryRoute?.id || legacyGroup) || null;
            }
            const kotGroupIds = [...new Set(normalizedItems.map(item => item.kotGroupId).filter(Boolean))];
            const validKotGroupIds = kotGroupIds.length ? await client.query(
                `SELECT id FROM kot_groups WHERE id=ANY($1::int[]) AND business_id=$2 AND active=TRUE`,
                [kotGroupIds, businessId]
            ) : { rows: [] };
            const validKotSet = new Set(validKotGroupIds.rows.map(item => Number(item.id)));
            normalizedItems.forEach(item => { if (!validKotSet.has(item.kotGroupId)) item.kotGroupId = null; });


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
                        notes,
                        marketing_deal_id,
                        marketing_deal_name,
                        discount_adjustment_id,
                        discount_adjustment_name,
                        charge_adjustment_id,
                        charge_adjustment_name,
                        pax,
                        sales_channel_key,
                        sales_channel_name
                    )
                    VALUES
                    (
                        $1,$2,$3,$4,$5,$6,$7,$12,$8,$9,$10,$11,$13,$14,$15,$16,$17,$18,$19,$20,$21
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
                        discount,
                        serviceCharge,
                        b.notes ? String(b.notes).slice(0, 1000) : null,
                        orderStatus,
                        b.marketingDealId ? String(b.marketingDealId).slice(0, 120) : null,
                        b.marketingDealName ? String(b.marketingDealName).slice(0, 120) : null,
                        b.discountAdjustmentId ? String(b.discountAdjustmentId).slice(0, 120) : null,
                        b.discountAdjustmentName ? String(b.discountAdjustmentName).slice(0, 120) : null,
                        b.chargeAdjustmentId ? String(b.chargeAdjustmentId).slice(0, 120) : null,
                        b.chargeAdjustmentName ? String(b.chargeAdjustmentName).slice(0, 120) : null,
                        pax,
                        saleChannel.key,
                        saleChannel.label
                    ]
                );


            const order =
                orderResult.rows[0];

            let checkoutResult = null;


            const itemValues = [];
            const itemRows = normalizedItems.map((item, index) => {
                const offset = index * 11;
                itemValues.push(order.id,item.menuId,item.variantId,item.name,item.price,item.quantity,item.price*item.quantity,item.unit,item.taxRate,item.taxMode,JSON.stringify(item.options));
                return `($${offset+1},$${offset+2},$${offset+3},$${offset+4},$${offset+5},$${offset+6},$${offset+7},$${offset+8},$${offset+9},$${offset+10},$${offset+11}::jsonb)`;
            });
            await client.query(`
                INSERT INTO order_items(order_id,menu_id,variant_id,item_name,price,quantity,line_total,unit,tax_rate,tax_mode,options)
                VALUES ${itemRows.join(",")}
            `, itemValues);
            if (createKot) await createKOTForOrder(client, businessId, order.id);


            if (orderType === "Dine-in") {

                await client.query(
                    `
                    UPDATE restaurant_tables
                    SET status = 'Occupied'
                    WHERE table_number = $1 AND business_id = $2
                    `,
                    [tableNumber, Number(req.user.business_id)]
                );

            }

            await recordOrderActivity(client, order.id, "Order created", `Order created with status ${orderStatus}.`, req);
            if (b.marketingDealId && b.marketingDealName && Number(b.discount || 0) > 0) {
                await recordOrderActivity(client, order.id, "Marketing deal applied", `${String(b.marketingDealName).slice(0, 120)} · Discount ${Number(b.discount || 0).toFixed(2)}.`, req);
            }

            if (b.checkout && typeof b.checkout === "object") {
                checkoutResult = await settleOrderWithClient(client, req, order.id, businessId, {
                    ...b.checkout,
                    createKot: false
                });
            }

            await client.query("COMMIT");

            if (checkoutResult) awardSettlementLoyalty(checkoutResult.insertedPayments, order.id);

            const response = { success: true, order: checkoutResult?.order || order };
            if (checkoutResult) {
                response.invoice = checkoutResult.invoice;
                response.paymentSummary = checkoutResult.paymentSummary;
            }
            res.status(201).json(response);

        } catch (e) {

            await client.query(
                "ROLLBACK"
            );

            console.error(e);

            res.status(e.status || 400).json({
                error: e.message
            });

        } finally {

            client.release();

        }

    }
);

app.post("/api/orders/:id/printed", async (req,res)=>{
    try {
        const result=await pool.query(`UPDATE orders SET bill_printed_at=COALESCE(bill_printed_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND business_id=$2 AND status='Completed' RETURNING id,bill_printed_at`,[Number(req.params.id),Number(req.user.business_id)]);
        if(!result.rows.length)return res.status(404).json({error:"Completed order not found"});
        res.json({success:true,billPrintedAt:result.rows[0].bill_printed_at});
    } catch(e) {
        res.status(500).json({error:"Could not record the bill print"});
    }
});

app.post("/api/orders/:id/kot", async (req,res)=>{
    const businessId=Number(req.user?.business_id),orderId=Number(req.params.id);
    if(!Number.isInteger(orderId)||orderId<=0)return res.status(400).json({error:"Invalid order"});
    const client=await rawPoolConnect();
    try{
        await client.query("BEGIN");
        await applyTenantDbContext(client);
        const order=await client.query("SELECT id FROM orders WHERE id=$1 AND business_id=$2 FOR UPDATE",[orderId,businessId]);
        if(!order.rows.length){await client.query("ROLLBACK");return res.status(404).json({error:"Order not found"});}
        const settings=await client.query("SELECT settings FROM app_settings WHERE business_id=$1 LIMIT 1",[businessId]);
        if(settings.rows[0]?.settings?.kotEnabled===false){await client.query("ROLLBACK");return res.status(409).json({error:"Kitchen ticket generation is disabled in Settings."});}
        const created=createKOTForOrder(client,businessId,orderId);
        await created;
        await client.query("COMMIT");
        res.json({success:true});
    }catch(error){
        await client.query("ROLLBACK").catch(()=>{});
        console.error("Ensure order KOT error:",error);
        res.status(500).json({error:"Could not prepare the KOT for printing"});
    }finally{client.release();}
});


app.get("/api/orders/qr-notifications", async (req, res) => {
    const businessId = Number(req.user.business_id);
    const rawAfterId = req.query.afterId;
    let afterId = null;
    if (rawAfterId !== undefined) {
        afterId = Number(rawAfterId);
        if (!Number.isSafeInteger(afterId) || afterId < 0) return res.status(400).json({ error: "Invalid order cursor" });
    }
    try {
        const result = await pool.query(`
            WITH latest AS (
                SELECT COALESCE(MAX(id),0)::bigint AS latest_order_id
                FROM orders WHERE business_id=$1
            ), new_qr_orders AS (
                SELECT id,order_number,table_number,total,created_at
                FROM orders
                WHERE business_id=$1 AND order_number LIKE 'QR-%'
                  AND (
                    ($2::bigint IS NOT NULL AND id>$2)
                    OR ($2::bigint IS NULL AND LOWER(COALESCE(status,'')) IN ('pending','preparing'))
                  )
                ORDER BY id
            )
            SELECT latest.latest_order_id,
                   COALESCE(json_agg(json_build_object(
                       'id',new_qr_orders.id,
                       'order_number',new_qr_orders.order_number,
                       'table_number',new_qr_orders.table_number,
                       'total',new_qr_orders.total,
                       'created_at',new_qr_orders.created_at
                   ) ORDER BY new_qr_orders.id) FILTER (WHERE new_qr_orders.id IS NOT NULL),'[]'::json) AS orders
            FROM latest LEFT JOIN new_qr_orders ON TRUE
            GROUP BY latest.latest_order_id
        `, [businessId, afterId]);
        const row = result.rows[0] || {};
        res.json({ latestOrderId: Number(row.latest_order_id || 0), orders: row.orders || [] });
    } catch (error) {
        console.error("QR order notification poll failed:", error);
        res.status(500).json({ error: "Failed to check for new QR orders" });
    }
});

app.put("/api/orders/:id/qr-status", async (req, res) => {
    const businessId = Number(req.user?.business_id || 0);
    const orderId = Number(req.params.id);
    const nextStatus = String(req.body?.status || "").trim();
    if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: "Invalid order ID." });
    if (!["Preparing", "Ready"].includes(nextStatus)) return res.status(400).json({ error: "Choose Accept or Mark Ready." });
    const client = await rawPoolConnect();
    try {
        await client.query("BEGIN");
        await applyTenantDbContext(client);
        const found = await client.query("SELECT id,order_number,public_tracking_token,status FROM orders WHERE id=$1 AND business_id=$2 FOR UPDATE", [orderId, businessId]);
        const order = found.rows[0];
        if (!order) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Order not found." }); }
        if (!order.public_tracking_token && !/^QR-/i.test(String(order.order_number || ""))) { await client.query("ROLLBACK"); return res.status(409).json({ error: "This workflow is only available for QR orders." }); }
        const currentStatus = String(order.status || "").trim().toLowerCase();
        const targetStatus = nextStatus.toLowerCase();
        if (currentStatus !== targetStatus) {
            const validNext = currentStatus === "pending" ? "preparing" : currentStatus === "preparing" ? "ready" : null;
            if (validNext !== targetStatus) {
                await client.query("ROLLBACK");
                return res.status(409).json({ error: currentStatus === "ready" ? "This QR order is already ready for checkout." : "QR orders must be accepted before they can be marked ready." });
            }
            await client.query("UPDATE orders SET status=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND business_id=$3", [nextStatus, orderId, businessId]);
            const kotStatus = nextStatus === "Preparing" ? "Preparing" : "Ready";
            await client.query("UPDATE kot SET status=$1 WHERE order_id=$2 AND business_id=$3 AND status IN ('Pending','Preparing')", [kotStatus, orderId, businessId]);
            await recordOrderActivity(client, orderId, nextStatus === "Preparing" ? "QR order accepted" : "QR order marked ready", nextStatus === "Preparing" ? "QR order accepted and sent to preparation." : "QR order marked ready for checkout.", req);
        }
        await client.query("COMMIT");
        res.json({ success: true, status: nextStatus });
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("QR order workflow update failed:", error);
        res.status(500).json({ error: "Could not update the QR order." });
    } finally { client.release(); }
});

app.get(
    "/api/orders",
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT o.*,COALESCE(NULLIF(o.sales_channel_name,''),CASE WHEN o.public_tracking_token IS NOT NULL THEN 'Slash ' || o.order_type ELSE o.order_type END) AS sale_channel,
                           c.name AS customer_name,c.phone AS customer_phone,c.email AS customer_email,
                           c.gstin AS customer_gstin,c.birth_date AS customer_birth_date,
                           c.address AS customer_address,c.city AS customer_city,c.state AS customer_state,
                           COALESCE((
                               SELECT json_agg(DISTINCT p.payment_method)
                               FROM payments p
                               WHERE p.order_id=o.id AND p.business_id=o.business_id AND p.payment_status='Success'
                           ), '[]'::json) AS payment_modes
                    FROM orders o
                    LEFT JOIN customers c ON c.id=o.customer_id AND c.business_id=o.business_id
                    WHERE o.business_id = $1
                    ORDER BY o.created_at DESC
                    `
                    , [Number(req.user.business_id)]
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

app.get("/api/orders/:id/activity", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id,event_type,description,actor,created_at
            FROM order_activity
            WHERE order_id=$1 AND business_id=$2
            ORDER BY created_at DESC,id DESC
        `, [Number(req.params.id), Number(req.user.business_id)]);
        const activities = result.rows.map(activity => {
            const actor = String(activity.actor || "Staff");
            const description = String(activity.description || "").replace(
                /Cancelled by user ID \d+/gi,
                () => `Cancelled by ${actor}`
            );
            return { ...activity, actor, description };
        });
        res.json({ activities });
    } catch (error) {
        console.error("Order activity load error:", error);
        res.status(500).json({ error: "Failed to load order activity" });
    }
});


app.get("/api/orders/:id/payment-summary", async (req,res)=>{
    try {
        const orderId=Number(req.params.id);
        const businessId=Number(req.user.business_id);
        const result=await pool.query(`
            SELECT o.total,o.payment_method,
                   COALESCE(summary.amount_collected,0) AS amount_collected,
                   COALESCE(summary.allocations,'[]'::json) AS allocations
            FROM orders o
            LEFT JOIN LATERAL (
                SELECT COALESCE(SUM(method_amount),0) AS amount_collected,
                       COALESCE(json_agg(json_build_object('method',payment_method,'amount',method_amount) ORDER BY payment_method),'[]'::json) AS allocations
                FROM (
                    SELECT payment_method,SUM(amount) AS method_amount
                    FROM payments
                    WHERE order_id=o.id AND business_id=o.business_id AND payment_status='Success'
                    GROUP BY payment_method
                ) payment_totals
            ) summary ON TRUE
            WHERE o.id=$1 AND o.business_id=$2
        `,[orderId,businessId]);
        if(!result.rows.length) return res.status(404).json({error:'Order not found'});
        const total=Number(result.rows[0].total||0);
        const amountCollected=Number(result.rows[0].amount_collected||0);
        const nonChargeable = /non.?chargeable/i.test(String(result.rows[0].payment_method || ""));
        res.json({total,amountCollected,amountDue:nonChargeable?0:Math.max(0,total-amountCollected),allocations:result.rows[0].allocations||[]});
    } catch(e) {
        console.error('Order payment summary error:',e);
        res.status(500).json({error:'Failed to load payment summary'});
    }
});

async function nextInvoiceSequenceNumber(client, businessId) {
    const result = await client.query(`
        INSERT INTO invoice_number_counters(business_id,next_number)
        VALUES($1,2)
        ON CONFLICT(business_id) DO UPDATE
        SET next_number=invoice_number_counters.next_number+1,updated_at=CURRENT_TIMESTAMP
        RETURNING next_number-1 AS number
    `, [Number(businessId)]);
    return Number(result.rows[0]?.number || 1);
}

async function settleOrderWithClient(client, req, orderId, businessId, body = {}) {
    const normalizedOrderId = Number(orderId);
    if (!Number.isInteger(normalizedOrderId) || normalizedOrderId <= 0) throw Object.assign(new Error("Invalid order ID"), { status: 400 });
    const orderResult = await client.query(
        `SELECT o.*,COALESCE(paid.collected,0) AS collected_before,COALESCE(paid.allocations,'[]'::json) AS allocations,COALESCE(config.settings,'{}'::jsonb) AS checkout_settings
         FROM orders o
         LEFT JOIN LATERAL (
             SELECT COALESCE(SUM(t.amount),0) AS collected,
                    COALESCE(json_agg(json_build_object('method',t.payment_method,'amount',t.amount) ORDER BY t.payment_method),'[]'::json) AS allocations
             FROM (
                 SELECT payment_method,SUM(amount) AS amount
                 FROM payments
                 WHERE order_id=o.id AND business_id=o.business_id AND payment_status='Success'
                 GROUP BY payment_method
             ) t
         ) paid ON TRUE
         LEFT JOIN LATERAL (SELECT settings FROM app_settings WHERE business_id=o.business_id LIMIT 1) config ON TRUE
         WHERE o.id=$1 AND o.business_id=$2 FOR UPDATE OF o`,
        [normalizedOrderId, businessId]
    );
    const order = orderResult.rows[0];
    if (!order) throw new Error("Order not found");
    const isQrOnlineOrder = Boolean(order.public_tracking_token) || /^QR-/i.test(String(order.order_number || ""));
    if (isQrOnlineOrder && String(order.status || "").trim().toLowerCase() !== "ready") {
        throw Object.assign(new Error("QR orders must be accepted and marked ready before checkout."), { status: 409 });
    }
    const collectedBefore = Number(order.collected_before || 0);
    const billTotal = Math.max(0, Number(order.total || 0));
    const remaining = Math.max(0, Math.round((billTotal - collectedBefore) * 100) / 100);
    const nonChargeable = body.nonChargeable === true;
    const checkoutSettings = order.checkout_settings || {};
    const allowedReasons = Array.isArray(checkoutSettings.nonChargeableReasons)
        ? checkoutSettings.nonChargeableReasons.map(reason => String(reason || "").trim().slice(0, 100)).filter(Boolean).slice(0, 30)
        : ["Complimentary", "Staff meal", "Customer recovery", "Promotion"];
    const nonChargeableReason = String(body.nonChargeableReason || "").trim().slice(0, 100);
    if (nonChargeable && (!nonChargeableReason || !allowedReasons.includes(nonChargeableReason))) {
        throw Object.assign(new Error(allowedReasons.length ? "Choose a valid non-chargeable reason." : "Add non-chargeable reasons in Settings before completing this bill."), { status: 400 });
    }
    const keepOpen = body.keepOpen === true && !nonChargeable;
    const methodLabel = String(body.paymentMethod || "").trim().slice(0, 50) || (nonChargeable ? "Non-chargeable" : "Payment");
    const payments = nonChargeable ? [{ method: "Non-chargeable", amount: 0 }] : (Array.isArray(body.payments) ? body.payments : []);
    const normalizedPayments = payments.map(payment => ({
        method: String(payment?.method || "").trim().slice(0, 50),
        amount: Math.round(Number(payment?.amount) * 100) / 100
    }));
    if (!nonChargeable && (!normalizedPayments.length || normalizedPayments.some(payment => !payment.method || !Number.isFinite(payment.amount) || payment.amount < 0))) {
        throw new Error("Add a valid payment method and amount.");
    }
    // A full-payment checkout is an intent to settle the current server-side balance.
    // Reuse the server's freshly recalculated due amount to avoid stale client totals
    // after an order edit; split and partial payments still require exact amounts.
    if (!nonChargeable && !keepOpen && String(body.paymentMode || "").toLowerCase() === "full" && normalizedPayments.length === 1) {
        normalizedPayments[0].amount = remaining;
    }
    const currentAmount = Math.round(normalizedPayments.reduce((sum, payment) => sum + payment.amount, 0) * 100) / 100;
    if (!nonChargeable && keepOpen && (currentAmount <= 0 || currentAmount >= remaining)) {
        throw new Error("A partial payment must be greater than zero and less than the remaining balance.");
    }
    if (!nonChargeable && !keepOpen && Math.abs(currentAmount - remaining) > 0.01) {
        throw new Error(`Payments total ${currentAmount.toFixed(2)}, but the remaining balance is ${remaining.toFixed(2)}. Refresh the payment details or correct the split amounts.`);
    }

    let insertedPayments = [];
    if (normalizedPayments.length) {
        const values = [];
        const rows = normalizedPayments.map((payment, index) => {
            const offset = index * 5;
            values.push(normalizedOrderId, order.order_number, payment.amount, payment.method, businessId);
            return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},'Success',NULL,$${offset + 5})`;
        });
        const inserted = await client.query(`
            INSERT INTO payments(order_id,order_number,amount,payment_method,payment_status,transaction_id,business_id)
            VALUES ${rows.join(",")}
            RETURNING id,amount,payment_method,payment_status,created_at
        `, values);
        insertedPayments = inserted.rows;
    }

    const nextStatus = keepOpen ? (isQrOnlineOrder ? order.status : "Open") : "Completed";
    const orderUpdate = await client.query(`
        UPDATE orders SET payment_method=$1,status=$2,non_chargeable_reason=$3,updated_at=CURRENT_TIMESTAMP
        WHERE id=$4 AND business_id=$5 RETURNING *
    `, [methodLabel, nextStatus, nonChargeable ? nonChargeableReason : null, normalizedOrderId, businessId]);
    const savedOrder = orderUpdate.rows[0];
    if (!keepOpen && body.createKot === true && order.checkout_settings?.kotEnabled !== false) await createKOTForOrder(client, businessId, normalizedOrderId);
    const paymentDescription = nonChargeable
        ? `Non-chargeable sale recorded · ${nonChargeableReason}.`
        : normalizedPayments.map(payment => `${payment.method}: ${payment.amount.toFixed(2)}`).join(" · ");
    await recordOrderActivity(client, normalizedOrderId, "Payment recorded", paymentDescription, req);
    if (!keepOpen) await recordOrderActivity(client, normalizedOrderId, "Order completed", "Sale completed.", req);

    if (!keepOpen && savedOrder.order_type === "Dine-in" && savedOrder.table_number) {
        await client.query(`UPDATE restaurant_tables SET status='Available' WHERE table_number=$1 AND business_id=$2`, [savedOrder.table_number, businessId]);
    }

    const status = nonChargeable ? "Non-chargeable" : keepOpen ? "Partially Paid" : "Paid";
    const invoiceMethod = methodLabel;
    const invoiceResult = await client.query(`SELECT * FROM invoices WHERE order_id=$1 FOR UPDATE`, [normalizedOrderId]);
    let invoice = invoiceResult.rows[0] || null;
    let customerId = body.customerId ?? savedOrder.customer_id ?? null;
    if (customerId !== null) {
        customerId = Number(customerId);
        if (!Number.isInteger(customerId) || customerId <= 0) throw new Error("Invalid customer ID");
        const customer = await client.query(`SELECT id FROM customers WHERE id=$1 AND business_id=$2`, [customerId, businessId]);
        if (!customer.rows.length) throw new Error("Customer not found");
    }
    if (invoice) {
        const updatedInvoice = await client.query(`UPDATE invoices SET customer_id=COALESCE($1,customer_id),payment_method=$2,status=$3 WHERE id=$4 RETURNING *`, [customerId, invoiceMethod, status, invoice.id]);
        invoice = updatedInvoice.rows[0];
    } else {
        const sequence = await nextInvoiceSequenceNumber(client, businessId);
        const invoiceNumber = String(checkoutSettings.invoicePrefix || "INV-").slice(0, 24) + String(sequence).padStart(6, "0");
        const createdInvoice = await client.query(`
            INSERT INTO invoices(invoice_number,order_id,customer_id,invoice_date,subtotal,gst,total,payment_method,status)
            VALUES($1,$2,$3,CURRENT_TIMESTAMP,$4,$5,$6,$7,$8) RETURNING *
        `, [invoiceNumber, normalizedOrderId, customerId, Number(savedOrder.subtotal), Number(savedOrder.gst), Number(savedOrder.total), invoiceMethod, status]);
        invoice = createdInvoice.rows[0];
    }

    const allocationTotals = new Map();
    for (const allocation of (Array.isArray(order.allocations) ? order.allocations : [])) {
        const method = String(allocation.method || "Payment");
        allocationTotals.set(method, (allocationTotals.get(method) || 0) + Number(allocation.amount || 0));
    }
    for (const payment of normalizedPayments) {
        allocationTotals.set(payment.method, (allocationTotals.get(payment.method) || 0) + Number(payment.amount || 0));
    }
    const allocations = [...allocationTotals.entries()]
        .map(([method, amount]) => ({ method, amount: Math.round(amount * 100) / 100 }))
        .sort((left, right) => left.method.localeCompare(right.method));
    const amountCollected = Math.round(allocations.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
    const amountDue = nonChargeable ? 0 : Math.max(0, Math.round((billTotal - amountCollected) * 100) / 100);
    return {
        order: savedOrder,
        invoice,
        paymentSummary: { total: billTotal, amountCollected, amountDue, allocations },
        insertedPayments
    };
}

function awardSettlementLoyalty(insertedPayments, orderId) {
    for (const payment of insertedPayments || []) {
        if (Number(payment.amount) > 0) awardLoyaltyForPayment(payment.id, orderId, Number(payment.amount));
    }
}

app.post("/api/orders/:id/settle", async (req, res) => {
    const client = await pool.connect();
    const businessId = Number(req.user?.business_id);
    try {
        const orderId = Number(req.params.id);
        if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: "Invalid order ID" });
        await client.query("BEGIN");
        const result = await settleOrderWithClient(client, req, orderId, businessId, req.body || {});
        await client.query("COMMIT");
        awardSettlementLoyalty(result.insertedPayments, orderId);
        delete result.insertedPayments;
        res.json({ success: true, ...result });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Order settlement error:", error);
        res.status(error.status || (error.message === "Order not found" ? 404 : 400)).json({ error: error.message || "Failed to settle order" });
    } finally {
        client.release();
    }
});
app.get("/api/orders/:id", async (req, res) => {
    try {
        const orderId = Number(req.params.id);
        const businessId = Number(req.user.business_id);
        const orderQuery = pool.query(
            "SELECT o.*,COALESCE(NULLIF(o.sales_channel_name,''),CASE WHEN o.public_tracking_token IS NOT NULL THEN 'Slash ' || o.order_type ELSE o.order_type END) AS sale_channel,c.name AS customer_name,c.phone AS customer_phone,c.email AS customer_email,c.gstin AS customer_gstin,c.birth_date AS customer_birth_date,c.address AS customer_address,c.city AS customer_city,c.state AS customer_state,COALESCE(summary.amount_collected,0) AS amount_collected,COALESCE(summary.allocations,'[]'::json) AS payment_allocations FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN LATERAL (SELECT COALESCE(SUM(t.amount),0) AS amount_collected,COALESCE(json_agg(json_build_object('method',t.payment_method,'amount',t.amount) ORDER BY t.payment_method),'[]'::json) AS allocations FROM (SELECT payment_method,SUM(amount) AS amount FROM payments WHERE order_id=o.id AND business_id=o.business_id AND payment_status='Success' GROUP BY payment_method) t) summary ON TRUE WHERE o.id=$1 AND o.business_id=$2",
            [orderId, businessId]
        );
        const itemsQuery = pool.query(
            "SELECT oi.*,m.category FROM order_items oi LEFT JOIN menu m ON m.id=oi.menu_id AND m.business_id=$2 WHERE oi.order_id=$1 ORDER BY oi.id",
            [orderId, businessId]
        );
        const [orderResult, itemsResult] = await Promise.all([orderQuery, itemsQuery]);
        if (!orderResult.rows.length) return res.status(404).json({ error: "Order not found" });
        const row = orderResult.rows[0];
        const amountCollected = Number(row.amount_collected || 0);
        const allocations = Array.isArray(row.payment_allocations) ? row.payment_allocations : [];
        const nonChargeable = /non.?chargeable/i.test(String(row.payment_method || ""));
        const paymentSummary = {
            total: Number(row.total || 0),
            amountCollected,
            amountDue: nonChargeable ? 0 : Math.max(0, Math.round((Number(row.total || 0) - amountCollected) * 100) / 100),
            allocations
        };
        delete row.amount_collected;
        delete row.payment_allocations;
        res.json({ order: row, items: itemsResult.rows, paymentSummary });
    } catch (error) {
        console.error("Order detail load error:", error);
        res.status(500).json({ error: "Failed to load order" });
    }
});

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
                pax,
                paymentMethod,
                customerId,
                discount,
                serviceCharge,
                discountAdjustmentId,
                discountAdjustmentName,
                chargeAdjustmentId,
                chargeAdjustmentName,
                marketingDealId,
                marketingDealName,
                saleChannelKey,
                notes,
                createKot,
                items
            } = req.body;

            if (!orderType) {
                throw new Error("Order type is required");
            }

            const existingResult = await client.query(
                `
                SELECT *
                FROM orders
                WHERE id = $1 AND business_id = $2
                FOR UPDATE
                `,
                [orderId, Number(req.user.business_id)]
            );

            const existingOrder = existingResult.rows[0];

            if (!existingOrder) {
                throw new Error("Order not found");
            }
            const permissions = req.user.permissions && typeof req.user.permissions === "object" ? req.user.permissions : {};
            const adminDefaults = req.user.is_owner === true && req.user.permissions_override === null;
            const canEditClosed = adminDefaults || permissions["orders.edit_closed"] === true;
            const canEditAfterPrint = adminDefaults || permissions["orders.edit_after_print"] === true;
            const canEditOpen = adminDefaults || permissions["orders.edit_open"] === true || permissions["orders.edit"] === true;
            const orderSettingsRow = await client.query("SELECT settings FROM app_settings WHERE business_id=$1 LIMIT 1", [Number(req.user.business_id)]);
            const orderSettings = orderSettingsRow.rows[0]?.settings || {};
            const saleChannel = resolveSaleChannel(orderSettings, saleChannelKey || existingOrder.sales_channel_key || defaultSaleChannelForOrderType(orderSettings, orderType), orderType);
            if (marketingDealId) assertMarketingDealAvailableForBilling(orderSettings, marketingDealId, saleChannel.key);
            await assertBillingAdjustmentAvailableForChannel(client, Number(req.user.business_id), discountAdjustmentId, saleChannel.key);
            await assertBillingAdjustmentAvailableForChannel(client, Number(req.user.business_id), chargeAdjustmentId, saleChannel.key);
            const calculation = await calculatePosOrderTotals(client, Number(req.user.business_id), items, orderType, orderSettings, discount, serviceCharge, saleChannel.key);
            const normalizedItems = calculation.items;
            const appliedSubtotal = calculation.subtotal;
            const appliedGst = calculation.gst;
            const appliedTotal = calculation.total;
            const appliedDiscount = calculation.discount;
            const appliedServiceCharge = calculation.serviceCharge;
            const shouldCreateKot = createKot === true && orderSettings.kotEnabled !== false;
            if (existingOrder.status === "Cancelled") throw new Error("Cancelled orders cannot be edited.");
            if (existingOrder.status === "Completed") {
                if (existingOrder.bill_printed_at ? !(canEditAfterPrint || canEditClosed) : !canEditClosed) {
                    throw Object.assign(new Error(existingOrder.bill_printed_at ? "You do not have permission to edit a printed bill." : "Only the business owner or a user with closed-bill editing can edit this closed bill."), { status: 403 });
                }
            } else if (!canEditOpen) {
                throw Object.assign(new Error("You do not have permission to edit open orders."), { status: 403 });
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
                    WHERE table_number = $1 AND business_id = $2
                    `,
                    [existingOrder.table_number, Number(req.user.business_id)]
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
                    WHERE table_number = $1 AND business_id = $2
                    FOR UPDATE
                    `,
                    [tableNumber, Number(req.user.business_id)]
                );

                const table = tableResult.rows[0];

                if (!table) {
                    throw new Error("Selected table does not exist");
                }

                const partySize = Number(pax) || 1;
                if (!Number.isInteger(partySize) || partySize < 1 || (Number(table.capacity) > 0 && partySize > Number(table.capacity))) {
                    throw new Error(`Number of guests must be between 1 and ${Number(table.capacity) || "the table capacity"}`);
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
                    notes = $10,
                    marketing_deal_id = $11,
                    marketing_deal_name = $12,
                    discount_adjustment_id = $13,
                    discount_adjustment_name = $14,
                    charge_adjustment_id = $15,
                    charge_adjustment_name = $16,
                    pax = $17,
                    sales_channel_key = $18,
                    sales_channel_name = $19
                WHERE id = $20 AND business_id = $21
                RETURNING *
                `,
                [
                    orderType,
                    tableNumber || null,
                    appliedSubtotal,
                    appliedGst,
                    appliedTotal,
                    paymentMethod || null,
                    customerId ? Number(customerId) : null,
                    appliedDiscount,
                    appliedServiceCharge,
                    notes ? String(notes).slice(0, 1000) : null,
                    marketingDealId ? String(marketingDealId).slice(0, 120) : null,
                    marketingDealName ? String(marketingDealName).slice(0, 120) : null,
                    discountAdjustmentId ? String(discountAdjustmentId).slice(0, 120) : null,
                    discountAdjustmentName ? String(discountAdjustmentName).slice(0, 120) : null,
                    chargeAdjustmentId ? String(chargeAdjustmentId).slice(0, 120) : null,
                    chargeAdjustmentName ? String(chargeAdjustmentName).slice(0, 120) : null,
                    orderType === "Dine-in" ? (Number(pax) || 1) : null,
                    saleChannel.key,
                    saleChannel.label,
                    orderId,
                    Number(req.user.business_id)
                ]
            );

            const updatedOrder = updatedOrderResult.rows[0];

            /*
             * Replace order items.
             */
            await client.query(
                `
                DELETE FROM order_items
                WHERE order_id = $1 AND business_id = $2
                `,
                [orderId, Number(req.user.business_id)]
            );

            const itemValues = [];
            const itemRows = normalizedItems.map((item, index) => {
                const offset = index * 11;
                itemValues.push(orderId,item.menuId,item.variantId,item.name,item.price,item.quantity,item.price*item.quantity,item.unit,item.taxRate,item.taxMode,JSON.stringify(item.options));
                return `($${offset+1},$${offset+2},$${offset+3},$${offset+4},$${offset+5},$${offset+6},$${offset+7},$${offset+8},$${offset+9},$${offset+10},$${offset+11}::jsonb)`;
            });
            await client.query(`
                INSERT INTO order_items(order_id,menu_id,variant_id,item_name,price,quantity,line_total,unit,tax_rate,tax_mode,options)
                VALUES ${itemRows.join(",")}
            `, itemValues);
            if (shouldCreateKot && existingOrder.status !== "Completed") await createKOTForOrder(client, Number(req.user.business_id), orderId);

            if (existingOrder.status === "Completed") {
                await client.query(`UPDATE invoices SET subtotal=$1,gst=$2,total=$3 WHERE order_id=$4`, [appliedSubtotal, appliedGst, appliedTotal, orderId]);
            }

            /*
             * Mark selected dine-in table occupied.
             */
            if (orderType === "Dine-in" && tableNumber) {
                await client.query(
                    `
                    UPDATE restaurant_tables
                    SET status = 'Occupied'
                    WHERE table_number = $1 AND business_id = $2
                    `,
                    [tableNumber, Number(req.user.business_id)]
                );
            }

            await recordOrderActivity(client, updatedOrder.id, existingOrder.status === "Completed" ? "Closed bill edited" : "Order updated", `Order details saved. New total: ${appliedTotal.toFixed(2)}.`, req);
            if (marketingDealId && marketingDealName && appliedDiscount > 0) {
                await recordOrderActivity(client, updatedOrder.id, "Marketing deal applied", `${String(marketingDealName).slice(0, 120)} · Discount ${appliedDiscount.toFixed(2)}.`, req);
            }

            let checkoutResult = null;
            if (req.body.checkout && typeof req.body.checkout === "object") {
                checkoutResult = await settleOrderWithClient(client, req, orderId, Number(req.user.business_id), req.body.checkout);
            }

            await client.query("COMMIT");

            if (checkoutResult) awardSettlementLoyalty(checkoutResult.insertedPayments, orderId);

            const response = { success: true, order: checkoutResult?.order || updatedOrder };
            if (checkoutResult) {
                response.invoice = checkoutResult.invoice;
                response.paymentSummary = checkoutResult.paymentSummary;
            }
            res.json(response);

        } catch (e) {
            await client.query("ROLLBACK");

            console.error(
                "❌ Update order error:",
                e
            );

            res.status(e.status || 400).json({
                error: e.message
            });

        } finally {
            client.release();
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
                    WHERE id = $1 AND business_id = $2
                    FOR UPDATE
                    `,
                    [req.params.id, Number(req.user.business_id)]
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


            if (order.status === "Cancelled") throw Object.assign(new Error("This order has already been cancelled."), { status: 409 });
            const permissions = req.user.permissions && typeof req.user.permissions === "object" ? req.user.permissions : {};
            const adminDefaults = req.user.is_owner === true && req.user.permissions_override === null;
            const closed = order.status === "Completed";
            if (closed && !adminDefaults && permissions["orders.cancel_closed"] !== true) {
                throw Object.assign(new Error("You do not have permission to cancel a closed order."), { status: 403 });
            }
            if (!closed && !adminDefaults && permissions["orders.edit_open"] !== true && permissions["orders.edit"] !== true) {
                throw Object.assign(new Error("You do not have permission to cancel this open order."), { status: 403 });
            }
            const businessId = Number(req.user.business_id);
            const settingsResult = await client.query("SELECT settings FROM app_settings WHERE business_id=$1 LIMIT 1", [businessId]);
            const settings = settingsResult.rows[0]?.settings || {};
            const allowedReasons = [...new Set((Array.isArray(settings.cancellationReasons) ? settings.cancellationReasons : ["Customer request", "Duplicate order", "Item unavailable", "Other"])
                .map(value => String(value || "").trim().slice(0, 120)).filter(Boolean))].slice(0, 30);
            const reason = String(req.body?.reason || "").trim().slice(0, 300);
            if (!reason || !allowedReasons.includes(reason)) {
                throw Object.assign(new Error(allowedReasons.length ? "Choose a cancellation reason from Settings." : "Add a cancellation reason in Settings before cancelling orders."), { status: 400 });
            }


            const result =
                await client.query(
                    `
                    UPDATE orders
                    SET status = 'Cancelled', cancellation_reason=$3, cancelled_by_user_id=$4,
                        cancelled_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
                    WHERE id = $1 AND business_id = $2
                    RETURNING *
                    `,
                    [req.params.id, businessId, reason, Number(req.user.id)]
                );


            await client.query(
                `
                UPDATE kot
                SET status = 'Completed'
                WHERE order_id = $1
                AND business_id = $2
                AND status <> 'Completed'
                `,
                [req.params.id, Number(req.user.business_id)]
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
                    WHERE table_number = $1 AND business_id = $2
                    `,
                    [order.table_number, Number(req.user.business_id)]
                );

            }

            await recordOrderActivity(client, order.id, "Order cancelled", `Reason: ${reason}. Cancelled by ${orderActivityActorLabel(req)}${closed ? ". Closed order cancellation." : "."}`, req);

            await client.query("COMMIT");


            res.json({
                success: true,
                order: result.rows[0]
            });

        } catch (e) {

            await client.query(
                "ROLLBACK"
            );

            res.status(e.status || 400).json({
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
                    WHERE id = $1 AND business_id = $2
                    `,
                    [req.params.id, Number(req.user.business_id)]
                );

            const order =
                orderResult.rows[0];


            if (!order) {
                return res.status(404).json({ error: "Order not found" });
            }
            if (order.payment_method !== "Non-chargeable" || !String(order.non_chargeable_reason || "").trim()) {
                const paidResult = await pool.query("SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE order_id=$1 AND business_id=$2 AND payment_status='Success'", [Number(req.params.id), Number(req.user.business_id)]);
                if (Number(paidResult.rows[0]?.paid || 0) + 0.01 < Number(order.total || 0)) return res.status(409).json({ error: "Record the full payment in Orders before closing this order." });
            }
            const result = await pool.query(`UPDATE orders SET status='Completed' WHERE id=$1 AND business_id=$2 RETURNING *`, [req.params.id, Number(req.user.business_id)]);

            await recordOrderActivity(pool, result.rows[0].id, "Order completed", "Order marked completed.", req);


            if (
                order.order_type ===
                "Dine-in" &&
                order.table_number
            ) {

                await pool.query(
                    `
                    UPDATE restaurant_tables
                    SET status = 'Available'
                    WHERE table_number = $1 AND business_id = $2
                    `,
                    [order.table_number, Number(req.user.business_id)]
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
                        COALESCE(NULLIF(o.sales_channel_name,''),CASE WHEN o.public_tracking_token IS NOT NULL THEN 'Slash ' || o.order_type ELSE o.order_type END) AS order_type,
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
                        COALESCE(NULLIF(o.sales_channel_name,''),CASE WHEN o.public_tracking_token IS NOT NULL THEN 'Slash ' || o.order_type ELSE o.order_type END) AS order_type,
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
                        COALESCE(NULLIF(o.sales_channel_name,''),CASE WHEN o.public_tracking_token IS NOT NULL THEN 'Slash ' || o.order_type ELSE o.order_type END) AS order_type,
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

            const sequenceNumber = await nextInvoiceSequenceNumber(client, Number(req.user.business_id));
            const invoiceSettings = (await client.query("SELECT settings FROM app_settings WHERE business_id=$1 LIMIT 1", [Number(req.user.business_id)])).rows[0]?.settings || {};
            const invoiceNumber = String(invoiceSettings.invoicePrefix || "INV-").slice(0, 24) + String(sequenceNumber).padStart(6, "0");


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
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM reservations
                    WHERE business_id=$1
                    ORDER BY
                        reservation_date ASC,
                        reservation_time ASC
                    `,
                    [Number(req.user.business_id)]
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
                        WHERE table_number = $1 AND business_id = $2
                        FOR UPDATE
                        `,
                        [table, Number(req.user.business_id)]
                    );


                const restaurantTable =
                    tableResult.rows[0];


                if (!restaurantTable) {

                    throw new Error(
                        "Selected table does not exist"
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
                        AND business_id = $4
                        LIMIT 1
                        `,
                        [
                            table,
                            date,
                            time,
                            Number(req.user.business_id)
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
                        notes,
                        business_id
                    )
                    VALUES
                    ($1,$2,$3,$4,$5,$6,$7,$8,$9)
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
                        null,
                        Number(req.user.business_id)
                    ]
                );
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
                    WHERE id = $1 AND business_id = $2
                    FOR UPDATE
                    `,
                    [req.params.id, Number(req.user.business_id)]
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
                        WHERE id = $2 AND business_id = $3
                        RETURNING *
                        `,
                        [
                            status,
                            req.params.id,
                            Number(req.user.business_id)
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
                        WHERE table_number = $1 AND business_id = $2
                        `,
                        [
                            reservation.table_number,
                            Number(req.user.business_id)
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
                        WHERE table_number = $1 AND business_id = $2
                        `,
                        [
                            reservation.table_number,
                            Number(req.user.business_id)
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
        const r=await pool.query(`SELECT kg.*,p.name AS printer_name,p.connection_type AS printer_connection_type FROM kot_groups kg LEFT JOIN printers p ON p.id=kg.printer_id AND p.business_id=kg.business_id WHERE kg.business_id=$1 ORDER BY kg.sort_order ASC, kg.name ASC`,[Number(req.user.business_id)]);
        res.json(r.rows);
    } catch(e){res.status(500).json({error:"Failed to load KOT groups"});}
});
app.get("/api/kot-groups/printers", async (req,res)=>{
    try {
        const rows=await pool.query(`SELECT id,name,connection_type,paper_width FROM printers WHERE business_id=$1 AND active=TRUE ORDER BY is_default DESC,name`,[Number(req.user.business_id)]);
        res.json(rows.rows);
    } catch(e){res.status(500).json({error:"Failed to load printers for KOT groups"});}
});
async function validateKOTGroupPrinter(value,businessId){
    const id=Number(value)||null;
    if(!id)return null;
    const found=await pool.query(`SELECT id FROM printers WHERE id=$1 AND business_id=$2 AND active=TRUE`,[id,businessId]);
    if(!found.rows.length)throw Object.assign(new Error("Select an active printer for this business."),{status:400});
    return id;
}
function cleanKOTGroupTargets(body={}){
    const categoryNames=[...new Set((Array.isArray(body.categoryNames)?body.categoryNames:[]).map(value=>String(value||"").trim().slice(0,120)).filter(Boolean))].slice(0,100);
    const itemIds=[...new Set((Array.isArray(body.itemIds)?body.itemIds:[]).map(Number).filter(id=>Number.isInteger(id)&&id>0))].slice(0,1000);
    return {categoryNames,itemIds};
}
app.post("/api/kot-groups", async (req,res)=>{
    try {
        const businessId=Number(req.user.business_id);
        const name=String(req.body.name||"").trim();
        if(!name)return res.status(400).json({error:"KOT group name is required"});
        const printerId=await validateKOTGroupPrinter(req.body.printerId,businessId);
        const targets=cleanKOTGroupTargets(req.body);
        const r=await pool.query(`INSERT INTO kot_groups(name,description,station,sort_order,active,business_id,printer_id,category_names,item_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) RETURNING *`,[name,String(req.body.description||"").trim()||null,String(req.body.station||"Kitchen"),Number(req.body.sortOrder||0),req.body.active!==false,businessId,printerId,JSON.stringify(targets.categoryNames),JSON.stringify(targets.itemIds)]);
        res.status(201).json(r.rows[0]);
    }catch(e){if(e.code==="23505")return res.status(409).json({error:"KOT group already exists"});res.status(e.status||500).json({error:e.message||"Failed to create KOT group"});}
});
app.put("/api/kot-groups/:id", async (req,res)=>{
    try {
        const id=Number(req.params.id); const businessId=Number(req.user.business_id);
        if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:"Invalid KOT group ID"});
        const printerId=await validateKOTGroupPrinter(req.body.printerId,businessId);
        const targets=cleanKOTGroupTargets(req.body);
        const r=await pool.query(`UPDATE kot_groups SET name=$1,description=$2,station=$3,sort_order=$4,active=$5,printer_id=$6,category_names=$7::jsonb,item_ids=$8::jsonb,updated_at=CURRENT_TIMESTAMP WHERE id=$9 AND business_id=$10 RETURNING *`,[String(req.body.name||"").trim(),String(req.body.description||"").trim()||null,String(req.body.station||"Kitchen"),Number(req.body.sortOrder||0),req.body.active!==false,printerId,JSON.stringify(targets.categoryNames),JSON.stringify(targets.itemIds),id,businessId]);
        if(!r.rows.length)return res.status(404).json({error:"KOT group not found"}); res.json(r.rows[0]);
    }catch(e){if(e.code==="23505")return res.status(409).json({error:"KOT group already exists"});res.status(e.status||500).json({error:e.message||"Failed to update KOT group"});}
});
app.delete("/api/kot-groups/:id", async (req,res)=>{
    try { const id=Number(req.params.id); const r=await pool.query(`DELETE FROM kot_groups WHERE id=$1 AND business_id=$2 RETURNING id`,[id,Number(req.user.business_id)]); if(!r.rows.length)return res.status(404).json({error:"KOT group not found"}); res.json({success:true}); } catch(e){res.status(500).json({error:"Failed to delete KOT group"});}
});

// =====================================================
// KOT
// =====================================================

app.get(
    "/api/kot",
    async (req,res)=>{
        try {
            const orderId=req.query.orderId===undefined?null:Number(req.query.orderId);
            if(orderId!==null&&(!Number.isInteger(orderId)||orderId<=0))return res.status(400).json({error:"Invalid order ID"});
            const range=orderId!==null?"all":(req.query.range||"today");
            const dateRange=range==="all"?{start:"TIMESTAMP '1970-01-01'",end:"CURRENT_TIMESTAMP + INTERVAL '1 day'"}:getReportDateRange(range,req.query.from,req.query.to);
            const result=await pool.query(`
                SELECT k.*,kg.name AS kot_group_name,kg.station AS kot_group_station,kg.printer_id,
                       p.name AS printer_name,p.connection_type AS printer_connection_type,p.host AS printer_host,p.port AS printer_port,
                       p.bluetooth_name AS printer_bluetooth_name,p.service_uuid AS printer_service_uuid,
                       p.characteristic_uuid AS printer_characteristic_uuid,p.paper_width AS printer_paper_width,
                       o.order_number,o.order_type,o.table_number,o.pax
                FROM kot k JOIN orders o ON k.order_id=o.id
                LEFT JOIN kot_groups kg ON kg.id=k.kot_group_id AND kg.business_id=o.business_id
                LEFT JOIN printers p ON p.id=kg.printer_id AND p.business_id=o.business_id
                WHERE o.business_id=$1 AND ($2::int IS NULL OR o.id=$2::int)
                  AND k.created_at >= ${dateRange.start}
                  AND k.created_at < ${dateRange.end}
                ORDER BY k.created_at DESC
            `,[Number(req.user.business_id),orderId]);
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
                `UPDATE kot SET status=$1 WHERE id=$2 AND business_id=$3 RETURNING *`,
                [status,id,Number(req.user.business_id)]
            );
            if(!result.rows.length) return res.status(404).json({error:"KOT not found"});

            const savedKot = result.rows[0];
            const qrOrder = await pool.query("SELECT id,order_number,public_tracking_token,status FROM orders WHERE id=$1 AND business_id=$2 LIMIT 1", [Number(savedKot.order_id), Number(req.user.business_id)]);
            const order = qrOrder.rows[0];
            if (order && (order.public_tracking_token || /^QR-/i.test(String(order.order_number || ""))) && !["completed", "cancelled"].includes(String(order.status || "").toLowerCase())) {
                const ticketStates = await pool.query("SELECT status FROM kot WHERE order_id=$1 AND business_id=$2", [Number(order.id), Number(req.user.business_id)]);
                const states = ticketStates.rows.map(row => String(row.status || "Pending"));
                const orderStatus = states.length && states.every(value => ["Ready", "Completed"].includes(value))
                    ? "Ready"
                    : states.some(value => ["Preparing", "Ready", "Completed"].includes(value)) ? "Preparing" : "Pending";
                if (String(order.status || "") !== orderStatus) await pool.query("UPDATE orders SET status=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND business_id=$3 AND status NOT IN ('Completed','Cancelled')", [orderStatus, Number(order.id), Number(req.user.business_id)]);
            }
            await recordOrderActivity(pool,savedKot.order_id,"Kitchen status changed",`Kitchen ticket marked ${status}.`,req);

            res.json({success:true,kot:savedKot});
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
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM payments
                    WHERE business_id = $1
                    ORDER BY created_at DESC
                    `,
                    [Number(req.user.business_id)]
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


app.post("/api/payments", (req, res) => res.status(410).json({
    error: "Direct payment creation is disabled. Record payments through order settlement."
}));


// =====================================================
// CUSTOMERS
// =====================================================

app.get(
    "/api/customers",
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM customers
                    WHERE business_id=$1
                    ORDER BY id DESC
                    `,
                    [Number(req.user.business_id)]
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

            const { name, phone, email, gstin, birthDate, address, city, state } = req.body;


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
                        email,
                        gstin,
                        birth_date,
                        address,
                        city,
                        state,
                        business_id
                    )
                    VALUES
                    ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                    RETURNING *
                    `,
                    [
                        name,
                        phone,
                        email || null,
                        String(gstin || "").trim() || null,
                        birthDate || null,
                        String(address || "").trim() || null,
                        String(city || "").trim() || null,
                        String(state || "").trim() || null,
                        Number(req.user.business_id)
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
            const gstin = String(req.body.gstin || "").trim() || null;
            const birthDate = req.body.birthDate || null;
            const address = String(req.body.address || "").trim() || null;
            const city = String(req.body.city || "").trim() || null;
            const state = String(req.body.state || "").trim() || null;

            if (!name || !phone) {
                return res.status(400).json({
                    error: "Customer name and phone are required"
                });
            }

            const existing = await pool.query(
                `
                SELECT *
                FROM customers
                WHERE phone = $1 AND business_id = $2
                LIMIT 1
                `,
                [phone, Number(req.user.business_id)]
            );

            if (existing.rows.length) {

                const updated = await pool.query(
                    `
                    UPDATE customers
                    SET name = $1,
                        email = $2,
                        gstin = $3,
                        birth_date = $4,
                        address = $5,
                        city = $6,
                        state = $7
                    WHERE id = $8 AND business_id = $9
                    RETURNING *
                    `,
                    [name, email, gstin, birthDate, address, city, state, existing.rows[0].id, Number(req.user.business_id)]
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
                (name, phone, email, gstin, birth_date, address, city, state, business_id)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                RETURNING *
                `,
                [name, phone, email, gstin, birthDate, address, city, state, Number(req.user.business_id)]
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

            const { name, phone, email, gstin, birthDate, address, city, state } = req.body;


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
                        email = $3,
                        gstin = COALESCE($4,gstin),
                        birth_date = COALESCE($5,birth_date),
                        address = COALESCE($6,address),
                        city = COALESCE($7,city),
                        state = COALESCE($8,state)
                    WHERE id = $9 AND business_id = $10
                    RETURNING *
                    `,
                    [
                        name,
                        phone,
                        email || null,
                        String(gstin || "").trim() || null,
                        birthDate || null,
                        String(address || "").trim() || null,
                        String(city || "").trim() || null,
                        String(state || "").trim() || null,
                        req.params.id,
                        Number(req.user.business_id)
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
    async (req, res) => {

        try {
            const businessId = Number(req.user.business_id);

            const q =
                async sql =>
                    Number(
                        (
                            await pool.query(sql, [businessId])
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
                            created_at >= ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC')
                        AND created_at < (((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC')
                        AND status =
                            'Completed'
                        AND business_id = $1
                        `
                    ),

                todayOrders:
                    await q(
                        `
                        SELECT
                            COUNT(*) value
                        FROM orders
                        WHERE
                            created_at >= ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC')
                        AND created_at < (((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC')
                        AND business_id = $1
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
                        AND business_id = $1
                        `
                    ),

                customers:
                    await q(
                        `
                        SELECT
                            COUNT(*) value
                        FROM customers
                        WHERE business_id = $1
                        `
                    ),

                totalOrders:
                    await q(
                        `
                        SELECT
                            COUNT(*) value
                        FROM orders
                        WHERE business_id = $1
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
                        AND business_id = $1
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

    // Order/payment timestamps are UTC wall-clock values. Convert IST calendar
    // boundaries explicitly so Vercel/Neon server timezone cannot shift a day.
    const istToday = "(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date";
    const utcBoundary = expression => `((${expression})::timestamp AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC')`;

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
            start: utcBoundary(`'${from}'::date`),
            end: utcBoundary(`'${to}'::date + INTERVAL '1 day'`)
        };
    }


    // ==========================================
    // PRESET DATE RANGES
    // ==========================================

    switch (range) {

        case "yesterday":

            return {
                start: utcBoundary(`${istToday} - INTERVAL '1 day'`),
                end: utcBoundary(istToday)
            };


        case "week":

            return {
                start: utcBoundary(`date_trunc('week', ${istToday})`),
                end: utcBoundary(`date_trunc('week', ${istToday}) + INTERVAL '1 week'`)
            };


        case "month":

            return {
                start: utcBoundary(`date_trunc('month', ${istToday})`),
                end: utcBoundary(`date_trunc('month', ${istToday}) + INTERVAL '1 month'`)
            };


        case "today":

        default:

            return {
                start: utcBoundary(istToday),
                end: utcBoundary(`${istToday} + INTERVAL '1 day'`)
            };

    }

}

// -----------------------------------------------------
// REPORT SUMMARY
// -----------------------------------------------------

app.get("/api/reports/sales-audit", async (req, res) => {
    try {
        const businessId = Number(req.user.business_id);
        const dateRange = getReportDateRange(req.query.range || "today", req.query.from, req.query.to);
        const result = await pool.query(`
            SELECT b.business_name,b.business_code,
                   o.id AS order_id,o.order_number,o.order_type,o.table_number,o.pax,
                   o.created_at,o.updated_at,o.subtotal,o.discount,o.service_charge,o.gst,o.total AS bill_total,
                   o.status AS order_status,o.notes,o.non_chargeable_reason,o.cancellation_reason,o.bill_printed_at,
                   o.public_tracking_token,o.marketing_deal_name,o.discount_adjustment_name,
                   o.customer_id,o.sales_channel_key,
                   COALESCE(NULLIF(o.sales_channel_name,''),CASE WHEN o.public_tracking_token IS NOT NULL THEN 'Slash ' || o.order_type ELSE o.order_type END) AS channel_label,
                   i.invoice_number,i.invoice_date,
                   c.name AS customer_name,c.phone AS customer_phone,c.email AS customer_email,c.gstin AS customer_gstin,
                   c.address AS customer_address,c.city AS customer_city,c.state AS customer_state,
                   COALESCE(pay.amount_collected,0) AS amount_collected,
                   CASE WHEN o.payment_method='Non-chargeable' THEN 0 ELSE GREATEST(o.total-COALESCE(pay.amount_collected,0),0) END AS amount_due,
                   COALESCE(pay.payment_modes,'') AS payment_modes,
                   COALESCE(pay.transaction_ids,'') AS transaction_ids,
                   pay.first_payment_time,pay.last_payment_time,
                   activity.created_by,activity.closed_by,activity.closed_at,activity.accepted_at,activity.ready_at,
                   COALESCE(activity.modified_after_print,0) AS modified_after_print,
                   COALESCE(activity.modified_after_close,0) AS modified_after_close,
                   COALESCE(activity.changes_after_print,'') AS changes_after_print,
                   COALESCE(items.item_count,0) AS item_count,COALESCE(items.total_quantity,0) AS total_quantity,
                   COALESCE(kot_summary.resource_group_names,'') AS resource_group_names,
                   COALESCE(kot_summary.number_of_tickets,0) AS number_of_tickets,
                   CASE WHEN o.subtotal>0 THEN ROUND((o.discount/o.subtotal)*100,2) ELSE 0 END AS discount_percent,
                   GREATEST(o.subtotal-o.discount,0) AS net_amount,
                   o.total-((o.subtotal-o.discount)+o.service_charge+o.gst) AS rounding_amount,
                   CASE WHEN activity.closed_at IS NOT NULL AND o.created_at IS NOT NULL
                        THEN ROUND(EXTRACT(EPOCH FROM (activity.closed_at-o.created_at))/60.0,2) ELSE NULL END AS duration_minutes,
                   CASE WHEN activity.accepted_at IS NOT NULL AND o.created_at IS NOT NULL
                        THEN ROUND(EXTRACT(EPOCH FROM (activity.accepted_at-o.created_at))/60.0,2) ELSE NULL END AS time_to_accept,
                   CASE WHEN activity.ready_at IS NOT NULL AND activity.accepted_at IS NOT NULL
                        THEN ROUND(EXTRACT(EPOCH FROM (activity.ready_at-activity.accepted_at))/60.0,2) ELSE NULL END AS time_to_prepare,
                   COALESCE(activity.closed_at,i.invoice_date,pay.last_payment_time,o.updated_at,o.created_at) AS business_date
            FROM orders o
            INNER JOIN businesses b ON b.id=o.business_id
            LEFT JOIN invoices i ON i.order_id=o.id AND i.business_id=o.business_id
            LEFT JOIN customers c ON c.id=o.customer_id AND c.business_id=o.business_id
            LEFT JOIN LATERAL (
                SELECT SUM(p.amount) AS amount_collected,
                       STRING_AGG(DISTINCT p.payment_method,', ' ORDER BY p.payment_method) AS payment_modes,
                       STRING_AGG(DISTINCT p.transaction_id,', ' ORDER BY p.transaction_id) FILTER (WHERE NULLIF(BTRIM(p.transaction_id),'') IS NOT NULL) AS transaction_ids,
                       MIN(p.created_at) AS first_payment_time,MAX(p.created_at) AS last_payment_time
                FROM payments p
                WHERE p.order_id=o.id AND p.business_id=o.business_id AND p.payment_status='Success'
            ) pay ON TRUE
            LEFT JOIN LATERAL (
                SELECT (ARRAY_AGG(a.actor ORDER BY a.created_at ASC) FILTER (WHERE a.event_type='Order created'))[1] AS created_by,
                       (ARRAY_AGG(a.actor ORDER BY a.created_at DESC) FILTER (WHERE a.event_type='Order completed'))[1] AS closed_by,
                       MAX(a.created_at) FILTER (WHERE a.event_type='Order completed') AS closed_at,
                       MAX(a.created_at) FILTER (WHERE a.event_type='QR order accepted') AS accepted_at,
                       MAX(a.created_at) FILTER (WHERE a.event_type='QR order marked ready') AS ready_at,
                       COUNT(*) FILTER (WHERE o.bill_printed_at IS NOT NULL AND a.created_at>o.bill_printed_at AND a.event_type='Closed bill edited') AS modified_after_print,
                       COUNT(*) FILTER (WHERE a.event_type='Closed bill edited') AS modified_after_close,
                       STRING_AGG(a.event_type || ': ' || NULLIF(a.description,''),' | ' ORDER BY a.created_at)
                           FILTER (WHERE o.bill_printed_at IS NOT NULL AND a.created_at>o.bill_printed_at) AS changes_after_print
                FROM order_activity a
                WHERE a.order_id=o.id AND a.business_id=o.business_id
            ) activity ON TRUE
            LEFT JOIN LATERAL (
                SELECT COUNT(*) AS item_count,COALESCE(SUM(oi.quantity),0) AS total_quantity
                FROM order_items oi WHERE oi.order_id=o.id AND oi.business_id=o.business_id
            ) items ON TRUE
            LEFT JOIN LATERAL (
                SELECT STRING_AGG(DISTINCT kg.name,', ' ORDER BY kg.name) AS resource_group_names,
                       COUNT(DISTINCT k.kot_group_id) AS number_of_tickets
                FROM kot k
                LEFT JOIN kot_groups kg ON kg.id=k.kot_group_id AND kg.business_id=k.business_id
                WHERE k.order_id=o.id AND k.business_id=o.business_id
            ) kot_summary ON TRUE
            WHERE o.business_id=$1 AND o.status='Completed'
              AND COALESCE(activity.closed_at,i.invoice_date,pay.last_payment_time,o.updated_at,o.created_at) >= ${dateRange.start}
              AND COALESCE(activity.closed_at,i.invoice_date,pay.last_payment_time,o.updated_at,o.created_at) < ${dateRange.end}
            ORDER BY COALESCE(activity.closed_at,i.invoice_date,pay.last_payment_time,o.updated_at,o.created_at) DESC,o.id DESC
        `, [businessId]);
        res.json({ transactions: result.rows });
    } catch (error) {
        console.error("Sales audit report error:", error);
        res.status(400).json({ error: error.message || "Failed to load sales audit report" });
    }
});

app.get("/api/reports/sales-summary", async (req, res) => {
    try {
        const range = req.query.range || "today";
        const dateRange = getReportDateRange(range, req.query.from, req.query.to);
        const businessId = Number(req.user.business_id);
        const orderSummary = await pool.query(`
            WITH period_orders AS (
                SELECT o.id,o.subtotal,o.discount,o.service_charge,o.gst,o.total,o.pax,
                       o.order_type,o.charge_adjustment_name
                FROM orders o
                WHERE o.business_id=$1
                  AND o.status='Completed'
                  AND EXISTS (
                      SELECT 1 FROM payments p
                      WHERE p.order_id=o.id AND p.business_id=o.business_id
                        AND p.payment_status='Success'
                        AND p.created_at >= ${dateRange.start}
                        AND p.created_at < ${dateRange.end}
                  )
            ), paid_to_date AS (
                SELECT p.order_id,SUM(p.amount) AS amount_paid
                FROM payments p
                INNER JOIN period_orders o ON o.id=p.order_id
                WHERE p.business_id=$1 AND p.payment_status='Success'
                GROUP BY p.order_id
            )
            SELECT
                COALESCE(SUM(o.subtotal),0) AS gross_sales,
                COALESCE(SUM(o.discount),0) AS discounts,
                COALESCE(SUM(GREATEST(o.subtotal-o.discount,0)),0) AS net_sales,
                COALESCE(SUM(o.service_charge),0) AS service_charges,
                COALESCE(SUM(o.gst),0) AS taxes,
                COALESCE(SUM(o.total-((o.subtotal-o.discount)+o.service_charge+o.gst)),0) AS rounding,
                COALESCE(SUM(CASE WHEN LOWER(COALESCE(o.order_type,'')) LIKE '%dine%' THEN COALESCE(o.pax,1) ELSE 0 END),0) AS pax,
                COALESCE(SUM(o.total),0) AS total_gross_revenue,
                COALESCE(SUM(GREATEST(o.total-COALESCE(p.amount_paid,0),0)),0) AS payment_balance
            FROM period_orders o
            LEFT JOIN paid_to_date p ON p.order_id=o.id
        `, [businessId]);
        const paymentRows = await pool.query(`
            SELECT p.payment_method,COALESCE(SUM(p.amount),0) AS amount
            FROM payments p
            INNER JOIN orders o ON o.id=p.order_id AND o.business_id=p.business_id AND o.status='Completed'
            WHERE p.business_id=$1 AND p.payment_status='Success'
              AND p.created_at >= ${dateRange.start} AND p.created_at < ${dateRange.end}
            GROUP BY p.payment_method ORDER BY SUM(p.amount) DESC,p.payment_method
        `, [businessId]);
        const chargeRows = await pool.query(`
            WITH period_orders AS (
                SELECT o.service_charge,o.charge_adjustment_name
                FROM orders o
                WHERE o.business_id=$1 AND o.status='Completed' AND o.service_charge>0
                  AND EXISTS (
                      SELECT 1 FROM payments p
                      WHERE p.order_id=o.id AND p.business_id=o.business_id
                        AND p.payment_status='Success'
                        AND p.created_at >= ${dateRange.start}
                        AND p.created_at < ${dateRange.end}
                  )
            )
            SELECT COALESCE(NULLIF(BTRIM(charge_adjustment_name),''),'Service charges') AS charge_name,
                   COALESCE(SUM(service_charge),0) AS amount
            FROM period_orders GROUP BY 1 ORDER BY SUM(service_charge) DESC,charge_name
        `, [businessId]);
        const row = orderSummary.rows[0] || {};
        res.json({
            range,
            summary: Object.fromEntries([
                "gross_sales", "discounts", "net_sales", "service_charges", "taxes", "rounding", "pax", "total_gross_revenue", "payment_balance"
            ].map(key => [key, Number(row[key] || 0)])),
            payments: paymentRows.rows.map(payment => ({ payment_method: payment.payment_method, amount: Number(payment.amount || 0) })),
            chargeBreakdown: chargeRows.rows.map(charge => ({ name: charge.charge_name, amount: Number(charge.amount || 0) })),
            untracked: ["sales_returns", "direct_charges", "tips", "cost_of_goods_sold", "materials", "materials_audit", "materials_voided", "margin_on_net_sales"]
        });
    } catch (error) {
        res.status(400).json({ error: error.message || "Failed to load sales summary" });
    }
});

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

                    FROM payments p
                    INNER JOIN orders o ON o.id=p.order_id AND o.business_id=p.business_id AND o.status='Completed'

                    WHERE
                        payment_status =
                        'Success'

                    AND p.business_id = ${Number(req.user.business_id)}

                    AND p.created_at >=
                        ${dateRange.start}

                    AND p.created_at <
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

                    WHERE oi.business_id = ${Number(req.user.business_id)}
                    AND EXISTS (

                        SELECT 1

                        FROM payments p
                        INNER JOIN orders o ON o.id=p.order_id AND o.business_id=p.business_id AND o.status='Completed'

                        WHERE
                            p.order_id =
                            oi.order_id

                        AND p.business_id = ${Number(req.user.business_id)}

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
                        p.payment_method,
                        COUNT(DISTINCT p.order_id) AS orders,
                        COALESCE(SUM(p.amount), 0) AS amount
                    FROM payments p
                    INNER JOIN orders completed_order
                        ON completed_order.id = p.order_id
                        AND completed_order.business_id = p.business_id
                        AND completed_order.status = 'Completed'
                    WHERE p.payment_status = 'Success'
                    AND p.business_id = $1
                    AND p.created_at >= ${dateRange.start}
                    AND p.created_at < ${dateRange.end}
                    GROUP BY p.payment_method

                    ORDER BY
                        amount DESC
                    `,
                    [Number(req.user.business_id)]
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

                    WHERE oi.business_id = ${Number(req.user.business_id)}
                    AND EXISTS (

                        SELECT 1

                        FROM payments p
                        INNER JOIN orders completed_order ON completed_order.id=p.order_id AND completed_order.business_id=p.business_id AND completed_order.status='Completed'

                        WHERE
                            p.order_id =
                            oi.order_id

                        AND p.business_id = ${Number(req.user.business_id)}

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
                       AND m.business_id = ${Number(req.user.business_id)}

                    WHERE oi.business_id = ${Number(req.user.business_id)}
                    AND EXISTS (

                        SELECT 1

                        FROM payments p
                        INNER JOIN orders completed_order
                            ON completed_order.id=p.order_id
                           AND completed_order.business_id=p.business_id
                           AND completed_order.status='Completed'

                        WHERE
                            p.order_id =
                            oi.order_id

                        AND p.business_id = ${Number(req.user.business_id)}

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

                        COALESCE(NULLIF(o.sales_channel_name,''),CASE WHEN o.public_tracking_token IS NOT NULL THEN 'Slash ' || o.order_type ELSE o.order_type END) AS order_type,

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
                       AND p.business_id = o.business_id
                       AND o.status = 'Completed'

                    WHERE
                        p.payment_status =
                        'Success'

                    AND o.business_id = ${Number(req.user.business_id)}
                    AND p.business_id = ${Number(req.user.business_id)}

                    AND p.created_at >=
                        ${dateRange.start}

                    AND p.created_at <
                        ${dateRange.end}

                    GROUP BY
                        COALESCE(NULLIF(o.sales_channel_name,''),CASE WHEN o.public_tracking_token IS NOT NULL THEN 'Slash ' || o.order_type ELSE o.order_type END)

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

                        DATE(p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') AS sale_date,

                        COUNT(
                            DISTINCT p.order_id
                        ) AS orders,

                        COALESCE(
                            SUM(p.amount),
                            0
                        ) AS sales

                    FROM payments p
                    INNER JOIN orders o ON o.id=p.order_id AND o.business_id=p.business_id AND o.status='Completed'

                    WHERE
                        p.payment_status =
                        'Success'

                    AND p.business_id = ${Number(req.user.business_id)}

                    AND p.created_at >=
                        ${dateRange.start}

                    AND p.created_at <
                        ${dateRange.end}

                    GROUP BY
                        DATE(p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')

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
                       AND p.business_id = o.business_id
                       AND o.status = 'Completed'

                    WHERE
                        p.payment_status =
                        'Success'

                    AND o.business_id = ${Number(req.user.business_id)}
                    AND p.business_id = ${Number(req.user.business_id)}

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
    try {
        res.json((await pool.query(`SELECT * FROM expense_categories WHERE active=true AND business_id=$1 ORDER BY name`,[Number(req.user.business_id)])).rows);
    } catch(e){ res.status(500).json({error:'Failed to load expense categories'}); }
});
app.post('/api/expenses/categories', async (req,res)=>{
    try {
        const businessId=Number(req.user.business_id);
        const name=String(req.body.name||'').trim();
        if(!name) return res.status(400).json({error:'Category name is required'});
        const r=await pool.query(`INSERT INTO expense_categories(name,business_id) VALUES($1,$2) RETURNING *`,[name,businessId]);
        res.status(201).json(r.rows[0]);
    } catch(e){ res.status(e.code==='23505'?409:500).json({error:e.code==='23505'?'Category already exists':'Failed to create category'}); }
});
app.get('/api/expenses', async (req,res)=>{
    try {
        const from=req.query.from||null, to=req.query.to||null;
        const r=await pool.query(`
            SELECT e.*, c.name AS category_name, u.display_name AS created_by_name
            FROM expenses e LEFT JOIN expense_categories c ON c.id=e.category_id LEFT JOIN app_users u ON u.id=e.created_by
            WHERE e.business_id=$3
              AND ($1::date IS NULL OR e.expense_date >= $1::date)
              AND ($2::date IS NULL OR e.expense_date <= $2::date)
            ORDER BY e.expense_date DESC, e.id DESC
        `,[from,to,Number(req.user.business_id)]);
        res.json(r.rows);
    } catch(e){ res.status(500).json({error:'Failed to load expenses'}); }
});
app.post('/api/expenses', async (req,res)=>{
    try {
        const businessId=Number(req.user.business_id);
        const amount=Number(req.body.amount); if(!Number.isFinite(amount)||amount<0) return res.status(400).json({error:'Invalid expense amount'});
        const r=await pool.query(`INSERT INTO expenses(category_id,amount,payment_method,expense_date,note,created_by,business_id) VALUES($1,$2,$3,COALESCE($4::date,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date),$5,$6,$7) RETURNING *`,[
            req.body.categoryId?Number(req.body.categoryId):null,amount,String(req.body.paymentMethod||'Cash'),req.body.expenseDate||null,req.body.note?String(req.body.note).slice(0,1000):null,req.user?.id||null,businessId]);
        res.status(201).json({success:true,expense:r.rows[0]});
    } catch(e){ console.error(e);res.status(500).json({error:'Failed to save expense'}); }
});
app.delete('/api/expenses/:id', async (req,res)=>{try{await pool.query(`DELETE FROM expenses WHERE id=$1 AND business_id=$2`,[Number(req.params.id),Number(req.user.business_id)]);res.json({success:true});}catch(e){res.status(500).json({error:'Failed to delete expense'});}});
app.get('/api/expenses/summary', async (req,res)=>{
    try {
        const from=req.query.from||null,to=req.query.to||null,businessId=Number(req.user.business_id);
        const total=(await pool.query(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM expenses WHERE business_id=$3 AND ($1::date IS NULL OR expense_date >= $1::date) AND ($2::date IS NULL OR expense_date <= $2::date)`,[from,to,businessId])).rows[0];
        const categories=(await pool.query(`SELECT COALESCE(c.name,'Uncategorised') category, COALESCE(SUM(e.amount),0) amount FROM expenses e LEFT JOIN expense_categories c ON c.id=e.category_id WHERE e.business_id=$3 AND ($1::date IS NULL OR e.expense_date >= $1::date) AND ($2::date IS NULL OR e.expense_date <= $2::date) GROUP BY c.name ORDER BY amount DESC`,[from,to,businessId])).rows;
        res.json({total,count:Number(total.count||0),categories});
    } catch(e){res.status(500).json({error:'Failed to load expense summary'});}
});

// =====================================================
// LOYALTY
// =====================================================
app.get('/api/loyalty/settings', async (req,res)=>{try{res.json(await getLoyaltySettings(Number(req.user.business_id)));}catch(e){res.status(500).json({error:'Failed to load loyalty settings'});}});
app.put('/api/loyalty/settings', async (req,res)=>{try{
    const businessId=Number(req.user.business_id);
    const enabled=req.body.enabled!==false, ppc=Math.max(0,Number(req.body.pointsPerCurrency||1)), cpp=Math.max(0,Number(req.body.currencyPerPoint||1)), min=Math.max(0,Math.floor(Number(req.body.minRedeemPoints||100))), welcome=Math.max(0,Math.floor(Number(req.body.welcomePoints||0)));
    const r=await pool.query(`INSERT INTO loyalty_settings(business_id,points_per_currency,currency_per_point,min_redeem_points,welcome_points,enabled,updated_at) VALUES($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP) ON CONFLICT(business_id) DO UPDATE SET points_per_currency=EXCLUDED.points_per_currency,currency_per_point=EXCLUDED.currency_per_point,min_redeem_points=EXCLUDED.min_redeem_points,welcome_points=EXCLUDED.welcome_points,enabled=EXCLUDED.enabled,updated_at=CURRENT_TIMESTAMP RETURNING *`,[businessId,ppc,cpp,min,welcome,enabled]); res.json(r.rows[0]);
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

async function getBillingAdjustmentStorageSchema() {
    const result = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='billing_adjustments'
    `);
    const columns = new Set(result.rows.map(row => row.column_name));
    const legacy = columns.has('kind') && columns.has('calculation');
    if (legacy) return { kindColumn: 'kind', calculationColumn: 'calculation', legacy: true };
    if (columns.has('type') && columns.has('value_type')) {
        return { kindColumn: 'type', calculationColumn: 'value_type', legacy: false };
    }
    throw new Error('Billing adjustments table has an unsupported schema');
}

app.get("/api/billing-adjustments", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM billing_adjustments
            WHERE business_id = $1
            ORDER BY active DESC, name ASC, id ASC
        `, [Number(req.user.business_id)]);
        res.json(result.rows);
    } catch (e) {
        console.error("Load billing adjustments error:", e);
        res.status(500).json({ error: "Failed to load billing adjustments" });
    }
});

app.post("/api/billing-adjustments", async (req, res) => {
    try {
        const businessId = Number(req.user.business_id);
        const schema = await getBillingAdjustmentStorageSchema();
        const name = String(req.body.name || "").trim();
        const typeInput = String(req.body.type || req.body.kind || "discount").toLowerCase();
        const type = ["discount", "charge"].includes(typeInput) ? typeInput : "discount";
        const calculationInput = String(req.body.valueType || req.body.calculation || "amount").toLowerCase();
        const isPercent = calculationInput === "percent";
        const storedCalculation = isPercent ? "percent" : (schema.legacy ? "fixed" : "amount");
        const value = Number(req.body.value);
        const appliesInput = String(req.body.appliesTo || "all").toLowerCase();
        const settingsResult = await pool.query("SELECT settings FROM app_settings WHERE business_id=$1 LIMIT 1", [businessId]);
        const appliesTo = appliesInput.replace(/[\s-]+/g, "_");
        if (appliesTo !== "all" && !salesChannelsForSettings(settingsResult.rows[0]?.settings || {}).some(channel => channel.key === appliesTo)) {
            return res.status(400).json({ error: "Choose an active sale channel for this discount or charge." });
        }
        const description = String(req.body.description || "").trim() || null;

        if (!name) return res.status(400).json({ error: "Adjustment name is required" });
        if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: "Adjustment value must be a valid non-negative number" });
        if (isPercent && value > 100) return res.status(400).json({ error: "Percentage cannot exceed 100" });

        const result = await pool.query(`
            INSERT INTO billing_adjustments
            (name,${schema.kindColumn},${schema.calculationColumn},value,applies_to,description,active,business_id)
            VALUES($1,$2,$3,$4,$5,$6,TRUE,$7)
            RETURNING *
        `, [name,type,storedCalculation,value,appliesTo,description,businessId]);

        res.status(201).json(result.rows[0]);
    } catch (e) {
        console.error("Create billing adjustment error:", e);
        if (e.code === "23505") return res.status(409).json({ error: "Billing adjustment already exists" });
        res.status(500).json({ error: "Failed to create billing adjustment" });
    }
});

app.put("/api/billing-adjustments/:id", async (req, res) => {
    try {
        const businessId = Number(req.user.business_id);
        const schema = await getBillingAdjustmentStorageSchema();
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid adjustment ID" });

        const name = String(req.body.name || "").trim();
        const typeInput = String(req.body.type || req.body.kind || "discount").toLowerCase();
        const type = ["discount", "charge"].includes(typeInput) ? typeInput : "discount";
        const calculationInput = String(req.body.valueType || req.body.calculation || "amount").toLowerCase();
        const isPercent = calculationInput === "percent";
        const storedCalculation = isPercent ? "percent" : (schema.legacy ? "fixed" : "amount");
        const value = Number(req.body.value);
        const appliesInput = String(req.body.appliesTo || "all").toLowerCase();
        const settingsResult = await pool.query("SELECT settings FROM app_settings WHERE business_id=$1 LIMIT 1", [businessId]);
        const appliesTo = appliesInput.replace(/[\s-]+/g, "_");
        if (appliesTo !== "all" && !salesChannelsForSettings(settingsResult.rows[0]?.settings || {}).some(channel => channel.key === appliesTo)) {
            return res.status(400).json({ error: "Choose an active sale channel for this discount or charge." });
        }
        const description = String(req.body.description || "").trim() || null;

        if (!name) return res.status(400).json({ error: "Adjustment name is required" });
        if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: "Adjustment value must be a valid non-negative number" });
        if (isPercent && value > 100) return res.status(400).json({ error: "Percentage cannot exceed 100" });

        const result = await pool.query(`
            UPDATE billing_adjustments
            SET name=$1,${schema.kindColumn}=$2,${schema.calculationColumn}=$3,value=$4,applies_to=$5,description=$6,updated_at=CURRENT_TIMESTAMP
            WHERE id=$7 AND business_id=$8
            RETURNING *
        `, [name,type,storedCalculation,value,appliesTo,description,id,businessId]);
        if (!result.rows.length) return res.status(404).json({ error: "Billing adjustment not found" });
        res.json(result.rows[0]);
    } catch (e) {
        console.error("Update billing adjustment error:", e);
        if (e.code === "23505") return res.status(409).json({ error: "Billing adjustment already exists" });
        res.status(500).json({ error: "Failed to update billing adjustment" });
    }
});

app.put("/api/billing-adjustments/:id/toggle", async (req, res) => {
    try {
        const id = Number(req.params.id);
        const result = await pool.query(`
            UPDATE billing_adjustments
            SET active=NOT active,updated_at=CURRENT_TIMESTAMP
            WHERE id=$1 AND business_id=$2
            RETURNING *
        `, [id, Number(req.user.business_id)]);
        if (!result.rows.length) return res.status(404).json({ error: "Billing adjustment not found" });
        res.json(result.rows[0]);
    } catch (e) {
        console.error("Toggle billing adjustment error:", e);
        res.status(500).json({ error: "Failed to update billing adjustment" });
    }
});

app.delete("/api/billing-adjustments/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        const result = await pool.query(`
            DELETE FROM billing_adjustments
            WHERE id=$1 AND business_id=$2
            RETURNING id
        `, [id, Number(req.user.business_id)]);
        if (!result.rows.length) return res.status(404).json({ error: "Billing adjustment not found" });
        res.json({ success: true });
    } catch (e) {
        console.error("Delete billing adjustment error:", e);
        res.status(500).json({ error: "Failed to delete billing adjustment" });
    }
});

// ADVANCED REPORTS
// =====================================================
app.get('/api/reports/order-categories', async (req, res) => {
    try {
        const range = req.query.range || "today";
        const dr = getReportDateRange(range, req.query.from, req.query.to);
        const businessId = Number(req.user.business_id);
        const [discountResult, nonChargeableResult] = await Promise.all([
            pool.query(`
                SELECT o.id AS order_id,o.order_number,o.created_at,o.order_type,o.table_number,
                       o.discount,COALESCE(NULLIF(o.marketing_deal_name,''),NULLIF(o.discount_adjustment_name,''),'Discount') AS discount_name,
                       o.payment_method,o.total
                FROM orders o
                WHERE o.business_id=$1 AND o.status='Completed' AND COALESCE(o.discount,0)>0
                  AND o.created_at >= ${dr.start} AND o.created_at < ${dr.end}
                ORDER BY o.created_at DESC,o.id DESC
                LIMIT 5000
            `, [businessId]),
            pool.query(`
                SELECT o.id AS order_id,o.order_number,o.created_at,o.order_type,o.table_number,
                       o.non_chargeable_reason AS reason,o.total,o.payment_method
                FROM orders o
                WHERE o.business_id=$1 AND o.status='Completed' AND LOWER(COALESCE(o.payment_method,''))='non-chargeable'
                  AND o.created_at >= ${dr.start} AND o.created_at < ${dr.end}
                ORDER BY o.created_at DESC,o.id DESC
                LIMIT 5000
            `, [businessId])
        ]);
        res.json({ discountOrders: discountResult.rows, nonChargeableOrders: nonChargeableResult.rows });
    } catch (e) {
        res.status(400).json({ error: e.message || "Could not load order reports" });
    }
});

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
        let dayparts = [];
        let customers = [];
        let cancelled = [];
        let discountOrders = [];
        let nonChargeableOrders = [];
        let expenseTotal = 0;

        // -----------------------------------------
        // HOURLY SALES
        // -----------------------------------------
        try {
            const result = await pool.query(`
                SELECT
                    EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::int AS hour,
                    COUNT(DISTINCT p.order_id)::int AS orders,
                    COALESCE(SUM(p.amount), 0) AS sales
                FROM payments p
                INNER JOIN orders o ON o.id=p.order_id AND o.business_id=p.business_id AND o.status='Completed'
                WHERE p.payment_status = 'Success'
                  AND p.business_id = ${Number(req.user.business_id)}
                  AND p.created_at >= ${dr.start}
                  AND p.created_at < ${dr.end}
                GROUP BY EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')
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
                    TO_CHAR(p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata', 'Dy') AS day,
                    EXTRACT(ISODOW FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::int AS day_no,
                    COUNT(DISTINCT p.order_id)::int AS orders,
                    COALESCE(SUM(p.amount), 0) AS sales
                FROM payments p
                INNER JOIN orders o ON o.id=p.order_id AND o.business_id=p.business_id AND o.status='Completed'
                WHERE p.payment_status = 'Success'
                  AND p.business_id = ${Number(req.user.business_id)}
                  AND p.created_at >= ${dr.start}
                  AND p.created_at < ${dr.end}
                GROUP BY
                    TO_CHAR(p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata', 'Dy'),
                    EXTRACT(ISODOW FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')
                ORDER BY day_no
            `);

            weekday = result.rows;
        } catch (e) {
            console.error("Advanced report weekday error:", e);
            warnings.push("Weekday sales unavailable");
        }

        // -----------------------------------------
        // SALES BY CAFE DAYPART
        // -----------------------------------------
        try {
            const result = await pool.query(`
                SELECT
                    CASE
                        WHEN EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') >= 5 AND EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') < 11 THEN 'Breakfast'
                        WHEN EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') >= 11 AND EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') < 15 THEN 'Lunch'
                        WHEN EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') >= 15 AND EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') < 18 THEN 'Afternoon'
                        WHEN EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') >= 18 AND EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') < 22 THEN 'Evening'
                        ELSE 'Late night'
                    END AS daypart,
                    MIN(CASE WHEN EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') < 5 THEN EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') + 24 ELSE EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') END)::int AS sort_hour,
                    COUNT(DISTINCT p.order_id)::int AS orders,
                    COALESCE(SUM(p.amount), 0) AS sales
                FROM payments p
                INNER JOIN orders o ON o.id=p.order_id AND o.business_id=p.business_id AND o.status='Completed'
                WHERE p.payment_status = 'Success'
                  AND p.business_id = ${Number(req.user.business_id)}
                  AND p.created_at >= ${dr.start}
                  AND p.created_at < ${dr.end}
                GROUP BY 1
                ORDER BY sort_hour
            `);

            dayparts = result.rows;
        } catch (e) {
            console.error("Advanced report daypart error:", e);
            warnings.push("Daypart sales unavailable");
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
                   AND c.business_id = o.business_id
                INNER JOIN payments p
                    ON p.order_id = o.id
                   AND p.business_id = o.business_id
                   AND p.payment_status = 'Success'
                WHERE o.business_id = ${Number(req.user.business_id)}
                  AND o.status = 'Completed'
                  AND p.business_id = ${Number(req.user.business_id)}
                  AND p.created_at >= ${dr.start}
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
                    o.id AS order_id,
                    o.order_number,
                    o.order_type,
                    o.table_number,
                    COALESCE(o.cancelled_at,o.updated_at,o.created_at) AS cancelled_at,
                    o.cancellation_reason AS reason,
                    o.cancelled_by_user_id,
                    COALESCE(NULLIF(BTRIM(u.display_name),''),NULLIF(BTRIM(u.username),''),'Unknown user') AS cancelled_by_user_name,
                    o.total AS value
                FROM orders o
                LEFT JOIN app_users u ON u.id=o.cancelled_by_user_id AND u.business_id=o.business_id
                WHERE o.status = 'Cancelled'
                  AND o.business_id = $1
                  AND COALESCE(o.cancelled_at,o.updated_at,o.created_at) >= ${dr.start}
                  AND COALESCE(o.cancelled_at,o.updated_at,o.created_at) < ${dr.end}
                ORDER BY COALESCE(o.cancelled_at,o.updated_at,o.created_at) DESC,o.id DESC
                LIMIT 5000
            `, [Number(req.user.business_id)]);

            cancelled = result.rows;
        } catch (e) {
            console.error("Advanced report cancelled error:", e);
            warnings.push("Cancelled orders unavailable");
        }

        // -----------------------------------------
        // DISCOUNTED ORDERS
        // -----------------------------------------
        try {
            const result = await pool.query(`
                SELECT o.id AS order_id,o.order_number,o.created_at,o.order_type,o.table_number,
                       o.discount,COALESCE(NULLIF(o.marketing_deal_name,''),NULLIF(o.discount_adjustment_name,''),'Discount') AS discount_name,
                       o.payment_method,o.total
                FROM orders o
                WHERE o.business_id=$1 AND o.status='Completed' AND COALESCE(o.discount,0)>0
                  AND o.created_at >= ${dr.start} AND o.created_at < ${dr.end}
                ORDER BY o.created_at DESC,o.id DESC
                LIMIT 5000
            `, [Number(req.user.business_id)]);
            discountOrders = result.rows;
        } catch (e) {
            console.error("Advanced report discount orders error:", e);
            warnings.push("Discounted orders unavailable");
        }

        // -----------------------------------------
        // NON-CHARGEABLE ORDERS
        // -----------------------------------------
        try {
            const result = await pool.query(`
                SELECT o.id AS order_id,o.order_number,o.created_at,o.order_type,o.table_number,
                       o.non_chargeable_reason AS reason,o.total,o.payment_method
                FROM orders o
                WHERE o.business_id=$1 AND o.status='Completed' AND LOWER(COALESCE(o.payment_method,''))='non-chargeable'
                  AND o.created_at >= ${dr.start} AND o.created_at < ${dr.end}
                ORDER BY o.created_at DESC,o.id DESC
                LIMIT 5000
            `, [Number(req.user.business_id)]);
            nonChargeableOrders = result.rows;
        } catch (e) {
            console.error("Advanced report non-chargeable orders error:", e);
            warnings.push("Non-chargeable orders unavailable");
        }

        // -----------------------------------------
        // EXPENSE TOTAL
        // -----------------------------------------
        try {
            const result = await pool.query(`
                SELECT
                    COALESCE(SUM(amount), 0) AS amount
                FROM expenses
                WHERE business_id = ${Number(req.user.business_id)}
                  AND expense_date >= ((${dr.start})::timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
                  AND expense_date < ((${dr.end})::timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
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
            dayparts,
            customers,
            cancelled,
            discountOrders,
            nonChargeableOrders,
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
    try { await pool.query('SELECT 1'); res.json({ok:true,serverTime:new Date().toISOString(),node:process.version,environment:process.env.NODE_ENV||'development'}); }
    catch(e){res.status(503).json({ok:false,error:'Database health check failed'});}
});
app.get('/api/system/deployment-check', async (_,res)=>{
    const checks=[];
    checks.push({key:'database',label:'PostgreSQL configuration',ok:Boolean(process.env.DATABASE_URL || (process.env.DB_USER&&process.env.DB_NAME&&process.env.DB_HOST))});
    try{await pool.query('SELECT 1');checks.push({key:'dbConnection',label:'Database connection',ok:true});}catch(e){checks.push({key:'dbConnection',label:'Database connection',ok:false,detail:'Database connection failed'});}
    const [nodeMajor,nodeMinor]=process.versions.node.split('.').map(Number);
    checks.push({key:'node',label:'Node.js runtime',ok:nodeMajor>22||(nodeMajor===22&&nodeMinor>=12),detail:`${process.version} · requires Node 22.12+`});

    res.json({checks,env:{NODE_ENV:process.env.NODE_ENV||'development',PORT:PORT}});
});
// ACCESS / USERS / ROLES / PERMISSIONS
// =====================================================

const ACCESS_MODULES_SERVER = [
    "dashboard", "orders", "new_order", "reservations", "tables",
    "kitchen", "kot_groups", "menu", "customers", "payments", "reports", "settings", "access", "devices", "expenses", "loyalty", "marketing", "advanced_reports", "printer"
];
const ACCESS_ACTIONS_SERVER = ["view", "create", "edit", "delete", "export", "print"];
const ACCESS_ORDER_PERMISSIONS_SERVER = ["orders.edit_open", "orders.print_open", "orders.edit_after_print", "orders.edit_closed", "orders.cancel_closed"];

function defaultPermissionsServer() {
    const p = {};
    for (const moduleKey of ACCESS_MODULES_SERVER) {
        for (const action of ACCESS_ACTIONS_SERVER) {
            p[`${moduleKey}.${action}`] = false;
        }
    }
    for (const key of ACCESS_ORDER_PERMISSIONS_SERVER) p[key] = !["orders.edit_closed", "orders.cancel_closed"].includes(key);
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
        "payments.view", "payments.create", "payments.print", "marketing.view", "marketing.create", "marketing.edit", "marketing.delete", "reports.view", "reports.export", "printer.view", "printer.create", "printer.edit", "printer.delete", "printer.print"
    ];
    allow.push("orders.edit_open", "orders.print_open", "orders.edit_after_print");
    allow.forEach(k => p[k] = true);
    return p;
}

async function ensureAccessTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS access_profiles (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
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
            username VARCHAR(100) NOT NULL,
            profile_id INTEGER REFERENCES access_profiles(id) ON DELETE SET NULL,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            password_hash TEXT,
            business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
            permissions_override JSONB,
            is_owner BOOLEAN NOT NULL DEFAULT FALSE
        )
    `);

    await pool.query(`ALTER TABLE access_profiles ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`);
    await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_hash TEXT`);
    await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS permissions_override JSONB`);
    await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`
        UPDATE access_profiles
        SET permissions=COALESCE(permissions,'{}'::jsonb)
            || CASE WHEN NOT (COALESCE(permissions,'{}'::jsonb) ? 'orders.edit_open') THEN '{"orders.edit_open":true}'::jsonb ELSE '{}'::jsonb END
            || CASE WHEN NOT (COALESCE(permissions,'{}'::jsonb) ? 'orders.print_open') THEN '{"orders.print_open":true}'::jsonb ELSE '{}'::jsonb END
            || CASE WHEN NOT (COALESCE(permissions,'{}'::jsonb) ? 'orders.edit_after_print') THEN '{"orders.edit_after_print":true}'::jsonb ELSE '{}'::jsonb END
            || CASE WHEN name='Admin' AND NOT (COALESCE(permissions,'{}'::jsonb) ? 'orders.edit_closed') THEN '{"orders.edit_closed":true}'::jsonb ELSE '{}'::jsonb END
            || CASE WHEN NOT (COALESCE(permissions,'{}'::jsonb) ? 'orders.cancel_closed') THEN CASE WHEN name='Admin' THEN '{"orders.cancel_closed":true}'::jsonb ELSE '{"orders.cancel_closed":false}'::jsonb END ELSE '{}'::jsonb END
    `);
    await pool.query(`
        UPDATE access_profiles
        SET permissions=COALESCE(permissions,'{}'::jsonb)||CASE
            WHEN name='Manager' THEN '{"printer.view":true,"printer.create":true,"printer.edit":true,"printer.delete":true,"printer.print":true}'::jsonb
            WHEN name='Cashier' THEN '{"printer.view":true,"printer.print":true}'::jsonb
            ELSE '{}'::jsonb
        END
        WHERE name IN ('Manager','Cashier')
    `);
    console.log("✅ Access table structure ready");
}

function builtInProfileDefinitions() {
    return [
        { name: "Admin", description: "Full system access", permissions: allPermissionsServer() },
        { name: "Manager", description: "Operational access without full administration", permissions: managerPermissionsServer() },
        { name: "Cashier", description: "Counter and cashier access", permissions: (() => {
            const p = defaultPermissionsServer();
            ["dashboard.view","new_order.view","new_order.create","customers.view","customers.create","payments.view","payments.create","orders.view","kitchen.view","kitchen.print","printer.view","printer.print"].forEach(k => p[k] = true);
            return p;
        })() }
    ];
}

async function seedBusinessAccessProfiles(businessId, db = pool)  {
    const id = Number(businessId);
    if (!id) throw new Error("Business id is required for access profile seed");
    for (const profile of builtInProfileDefinitions()) {
        await db.query(`
            INSERT INTO access_profiles (name,business_id,description,permissions)
            VALUES ($1,$2,$3,$4::jsonb)
            ON CONFLICT (business_id,name) DO NOTHING
        `, [profile.name, id, profile.description, JSON.stringify(profile.permissions)]);
    }
}

async function ensureBusinessOwnerFlags() {
    await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`
        WITH ranked_users AS (
            SELECT id, business_id,
                   ROW_NUMBER() OVER (
                       PARTITION BY business_id
                       ORDER BY CASE WHEN is_owner THEN 0 ELSE 1 END,
                                created_at ASC NULLS LAST,
                                id ASC
                   ) AS owner_rank
            FROM app_users
            WHERE business_id IS NOT NULL
        )
        UPDATE app_users u
        SET is_owner = (ranked_users.owner_rank = 1)
        FROM ranked_users
        WHERE u.id = ranked_users.id
          AND u.is_owner IS DISTINCT FROM (ranked_users.owner_rank = 1)
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_one_owner_per_business ON app_users(business_id) WHERE is_owner=TRUE`);
}

app.get("/api/access", async (req, res) => {
    try {
        const businessId = Number(req.user.business_id);
        const [users, profiles] = await Promise.all([
            pool.query(`
                SELECT u.id, u.display_name, u.username, u.profile_id, u.active, u.created_at,
                       p.name AS profile_name
                FROM app_users u
                LEFT JOIN access_profiles p ON p.id=u.profile_id AND p.business_id=u.business_id
                WHERE u.business_id=$1
                ORDER BY u.id
            `, [businessId]),
            pool.query(`SELECT id, name, description, permissions, created_at, updated_at FROM access_profiles WHERE business_id=$1 ORDER BY name`, [businessId])
        ]);
        res.json({ users: users.rows, profiles: profiles.rows });
    } catch (e) {
        console.error("Access load error:", e);
        res.status(500).json({ error: "Failed to load access data" });
    }
});

app.get("/api/access/profiles", async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, name, description, permissions, created_at, updated_at FROM access_profiles WHERE business_id=$1 ORDER BY name`, [Number(req.user.business_id)]);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: "Failed to load access profiles" });
    }
});

app.post("/api/access/profiles", async (req, res) => {
    try {
        const businessId = Number(req.user.business_id);
        const name = String(req.body.name || "").trim();
        const description = String(req.body.description || "").trim();
        const permissions = req.body.permissions && typeof req.body.permissions === "object" ? req.body.permissions : defaultPermissionsServer();
        if (!name) return res.status(400).json({ error: "Profile name is required" });
        if (name === "Admin") return res.status(400).json({ error: "Admin is a reserved built-in profile name" });
        const result = await pool.query(
            `INSERT INTO access_profiles (name, business_id, description, permissions) VALUES ($1,$2,$3,$4::jsonb) RETURNING *`,
            [name, businessId, description || null, JSON.stringify(permissions)]
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
        const businessId = Number(req.user.business_id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid profile ID" });
        const current = await pool.query(`SELECT * FROM access_profiles WHERE id=$1 AND business_id=$2`, [id, businessId]);
        if (!current.rows.length) return res.status(404).json({ error: "Access profile not found" });
        const old = current.rows[0];
        const name = String(req.body.name ?? old.name).trim();
        const description = String(req.body.description ?? old.description ?? "").trim();
        const permissions = req.body.permissions && typeof req.body.permissions === "object" ? req.body.permissions : old.permissions;
        if (!name) return res.status(400).json({ error: "Profile name is required" });
        if (old.name === "Admin" && name !== "Admin") return res.status(400).json({ error: "The built-in Admin profile cannot be renamed" });
        if (old.name !== "Admin" && name === "Admin") return res.status(400).json({ error: "Admin is a reserved built-in profile name" });
        const ownProfile = await pool.query(`SELECT 1 FROM app_users WHERE id=$1 AND business_id=$2 AND profile_id=$3 LIMIT 1`, [Number(req.user.id), businessId, id]);
        if (ownProfile.rows.length) return res.status(403).json({ error: "You cannot edit the access profile assigned to your own account" });
        const result = await pool.query(
            `UPDATE access_profiles SET name=$1, description=$2, permissions=$3::jsonb, updated_at=CURRENT_TIMESTAMP WHERE id=$4 AND business_id=$5 RETURNING *`,
            [name, description || null, JSON.stringify(permissions), id, businessId]
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
        const businessId = Number(req.user.business_id);
        const profile = await pool.query(`SELECT name FROM access_profiles WHERE id=$1 AND business_id=$2`, [id, businessId]);
        if (!profile.rows.length) return res.status(404).json({ error: "Access profile not found" });
        if (profile.rows[0].name === "Admin") return res.status(400).json({ error: "The Admin profile cannot be deleted" });
        await pool.query(`DELETE FROM access_profiles WHERE id=$1 AND business_id=$2`, [id, businessId]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to delete access profile" });
    }
});

app.get("/api/access/users", async (req, res) => {
    try {
        const businessId = Number(req.user.business_id);
        const result = await pool.query(`
            SELECT u.id, u.display_name, u.username, u.profile_id, u.active, u.created_at,
                   p.name AS profile_name
            FROM app_users u
            LEFT JOIN access_profiles p ON p.id=u.profile_id AND p.business_id=u.business_id
            WHERE u.business_id=$1
            ORDER BY u.id
        `, [businessId]);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: "Failed to load users" });
    }
});

app.post("/api/access/users", async (req, res) => {
    try {
        const businessId = Number(req.user.business_id);
        const displayName = String(req.body.displayName || "").trim();
        const username = String(req.body.username || "").trim().toLowerCase();
        const profileId = req.body.profileId === null || req.body.profileId === undefined || req.body.profileId === "" ? null : Number(req.body.profileId);
        const active = req.body.active !== false;
        const password = String(req.body.password || "");
        if (!displayName || !username) return res.status(400).json({ error: "Display name and username are required" });
        if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
        if (profileId !== null) {
            const profile = await pool.query(`SELECT id FROM access_profiles WHERE id=$1 AND business_id=$2`, [profileId, businessId]);
            if (!profile.rows.length) return res.status(400).json({ error: "Invalid access profile" });
        }
        const result = await pool.query(
            `INSERT INTO app_users (display_name, username, password_hash, profile_id, business_id, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,display_name,username,profile_id,business_id,active,created_at,updated_at`,
            [displayName, username, await hashPassword(password), profileId, businessId, active]
        );
        res.status(201).json({ success: true, user: result.rows[0] });
    } catch (e) {
        if (e.code === "23505") return res.status(409).json({ error: "A user with this username already exists in this business" });
        res.status(500).json({ error: "Failed to create user" });
    }
});

app.put("/api/access/users/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        const businessId = Number(req.user.business_id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid user ID" });
        if (id === Number(req.user.id)) return res.status(403).json({ error: "You cannot edit your own account from Access management" });
        const current = await pool.query(`SELECT * FROM app_users WHERE id=$1 AND business_id=$2`, [id, businessId]);
        if (!current.rows.length) return res.status(404).json({ error: "User not found" });
        const old = current.rows[0];
        if (old.is_owner) return res.status(403).json({ error: "The business owner account can only be managed by the owner or support staff" });
        const displayName = req.body.displayName === undefined ? old.display_name : String(req.body.displayName).trim();
        const username = req.body.username === undefined ? old.username : String(req.body.username).trim().toLowerCase();
        const profileId = req.body.profileId === undefined ? old.profile_id : (req.body.profileId === null || req.body.profileId === "" ? null : Number(req.body.profileId));
        const active = req.body.active === undefined ? old.active : Boolean(req.body.active);
        const password = String(req.body.password || "");
        if (!displayName || !username) return res.status(400).json({ error: "Display name and username are required" });
        if (password && password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
        if (profileId !== null) {
            const profile = await pool.query(`SELECT id FROM access_profiles WHERE id=$1 AND business_id=$2`, [profileId, businessId]);
            if (!profile.rows.length) return res.status(400).json({ error: "Invalid access profile" });
        }
        const result = await pool.query(
            password
                ? `UPDATE app_users SET display_name=$1, username=$2, password_hash=$3, profile_id=$4, active=$5, permissions_override=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=$6 AND business_id=$7 RETURNING id,display_name,username,profile_id,business_id,active,created_at,updated_at`
                : `UPDATE app_users SET display_name=$1, username=$2, profile_id=$3, active=$4, permissions_override=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=$5 AND business_id=$6 RETURNING id,display_name,username,profile_id,business_id,active,created_at,updated_at`,
            password ? [displayName,username,await hashPassword(password),profileId,active,id,businessId] : [displayName,username,profileId,active,id,businessId]
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (e) {
        if (e.code === "23505") return res.status(409).json({ error: "A user with this username already exists in this business" });
        res.status(500).json({ error: "Failed to update user" });
    }
});

app.delete("/api/access/users/:id", async (req, res) => {
    try {
        const businessId = Number(req.user.business_id);
        const id = Number(req.params.id);
        if (id === Number(req.user.id)) return res.status(403).json({ error: "You cannot delete your own account" });
        const user = await pool.query(`SELECT id, username, profile_id, is_owner FROM app_users WHERE id=$1 AND business_id=$2`, [id, businessId]);
        if (!user.rows.length) return res.status(404).json({ error: "User not found" });
        if (user.rows[0].is_owner) return res.status(400).json({ error: "The business owner account cannot be deleted" });
        await pool.query(`DELETE FROM app_users WHERE id=$1 AND business_id=$2`, [id, businessId]);
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
            business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
            settings JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`);

    await pool.query(`
        INSERT INTO app_settings (id, business_id, settings)
        VALUES ($1, $1, '{}'::jsonb)
        ON CONFLICT (id) DO NOTHING
    `, [Number(systemBusinessId||1)]);

    await pool.query("CREATE TABLE IF NOT EXISTS support_business_branding (business_id INTEGER PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE, show_powered_by_cafe_pilot BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    await pool.query("ALTER TABLE support_business_branding ENABLE ROW LEVEL SECURITY");
    await pool.query("ALTER TABLE support_business_branding FORCE ROW LEVEL SECURITY");
    await pool.query("DROP POLICY IF EXISTS support_business_branding_system_only ON support_business_branding");
    await pool.query("CREATE POLICY support_business_branding_system_only ON support_business_branding USING (current_setting('app.system_mode', true)='on') WITH CHECK (current_setting('app.system_mode', true)='on')");

    console.log("✅ Application settings ready");
}

app.get("/api/menu-option-sets", async (req, res) => {
    try {
        const result = await pool.query("SELECT settings->'menuOptionSets' AS sets FROM app_settings WHERE business_id=$1", [Number(req.user.business_id)]);
        res.json({ optionSets: Array.isArray(result.rows[0]?.sets) ? result.rows[0].sets : [] });
    } catch (error) {
        res.status(500).json({ error: "Failed to load menu option sets" });
    }
});

app.put("/api/menu-option-sets", async (req, res) => {
    const input = req.body?.optionSets;
    if (!Array.isArray(input) || input.length > 200) return res.status(400).json({ error: "Option sets must be a list of up to 200 sets." });
    const ids = new Set();
    const names = new Set();
    const optionSets = [];
    for (const source of input) {
        const id = String(source?.id || "").trim().slice(0, 80);
        const name = String(source?.name || "").trim().slice(0, 100);
        const options = (Array.isArray(source?.options) ? source.options : []).slice(0, 50).map(option => ({
            id: String(option?.id || "").trim().slice(0, 80),
            menuItemId: Number.isSafeInteger(Number(option?.menuItemId)) && Number(option?.menuItemId) > 0 ? Number(option.menuItemId) : null,
            name: String(option?.name || "").trim().slice(0, 100),
            price: Number(option?.price)
        }));
        const minSelections = Number(source?.minSelections ?? 0);
        const maxSelections = Number(source?.maxSelections ?? 1);
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !name || !options.length || options.some(option => !option.id || !option.name || !Number.isFinite(option.price) || option.price < 0)) {
            return res.status(400).json({ error: "Each option set needs a name and at least one option with a valid non-negative price." });
        }
        if (ids.has(id) || names.has(name.toLocaleLowerCase())) return res.status(400).json({ error: "Option set IDs and names must be unique." });
        if (!Number.isInteger(minSelections) || !Number.isInteger(maxSelections) || minSelections < 0 || maxSelections < 1 || minSelections > maxSelections || maxSelections > options.length) {
            return res.status(400).json({ error: `Selection limits for “${name}” are invalid.` });
        }
        ids.add(id);
        names.add(name.toLocaleLowerCase());
        optionSets.push({ id, name, minSelections, maxSelections, options });
    }
    try {
        const businessId = Number(req.user.business_id);
        const menuItemIds = [...new Set(optionSets.flatMap(set => set.options.map(option => option.menuItemId).filter(Boolean)))];
        const menuItemRows = menuItemIds.length
            ? await pool.query("SELECT id,name FROM menu WHERE business_id=$1 AND id=ANY($2::int[]) AND available=TRUE", [businessId, menuItemIds])
            : { rows: [] };
        const menuItemsById = new Map(menuItemRows.rows.map(item => [Number(item.id), item]));
        for (const set of optionSets) {
            const usedMenuItems = new Set();
            for (const option of set.options) {
                if (!option.menuItemId) continue; // Keep existing unlinked sets readable until edited in the menu-item picker.
                const menuItem = menuItemsById.get(option.menuItemId);
                if (!menuItem) return res.status(400).json({ error: "Option set choices must reference available menu items for this business." });
                if (usedMenuItems.has(option.menuItemId)) return res.status(400).json({ error: "A menu item can appear only once in an option set." });
                usedMenuItems.add(option.menuItemId);
                option.name = String(menuItem.name || "").slice(0, 100);
            }
        }
        const result = await pool.query(`
            INSERT INTO app_settings(id,business_id,settings,updated_at)
            VALUES($1,$1,$2::jsonb,CURRENT_TIMESTAMP)
            ON CONFLICT (business_id) DO UPDATE SET settings=app_settings.settings || EXCLUDED.settings,updated_at=CURRENT_TIMESTAMP
            RETURNING settings->'menuOptionSets' AS sets
        `, [businessId, JSON.stringify({ menuOptionSets: optionSets })]);
        res.json({ success: true, optionSets: result.rows[0]?.sets || [] });
    } catch (error) {
        res.status(500).json({ error: "Failed to save menu option sets" });
    }
});

app.get("/api/marketing/deals", async (req,res)=>{
    try {
        const result=await pool.query("SELECT settings->'marketingDeals' AS deals FROM app_settings WHERE business_id=$1",[Number(req.user.business_id)]);
        res.json({deals:Array.isArray(result.rows[0]?.deals)?result.rows[0].deals:[]});
    } catch(e) {
        console.error("Marketing deals load error:",e);
        res.status(500).json({error:"Failed to load marketing deals"});
    }
});
app.put("/api/marketing/deals", async (req,res)=>{
    try {
        if(!Array.isArray(req.body?.deals)) return res.status(400).json({error:"Deals must be a list"});
        const businessId=Number(req.user.business_id);
        const settings={marketingDeals:req.body.deals};
        const result=await pool.query(`
            INSERT INTO app_settings (id,business_id,settings,updated_at)
            VALUES ($1,$1,$2::jsonb,CURRENT_TIMESTAMP)
            ON CONFLICT (business_id) DO UPDATE
            SET settings=app_settings.settings || EXCLUDED.settings, updated_at=CURRENT_TIMESTAMP
            RETURNING settings->'marketingDeals' AS deals
        `,[businessId,JSON.stringify(settings)]);
        res.json({success:true,deals:result.rows[0].deals||[]});
    } catch(e) {
        console.error("Marketing deals save error:",e);
        res.status(500).json({error:"Failed to save marketing deals"});
    }
});
app.get("/api/marketing/push-settings", async (req, res) => {
    try {
        const businessId = Number(req.user.business_id);
        const [subscriptionResult, menuResult] = await Promise.all([
            pool.query("SELECT COUNT(*)::INTEGER AS count FROM public_menu_push_subscriptions WHERE business_id=$1", [businessId]),
            pool.query("SELECT token, enabled FROM public_menu_settings WHERE business_id=$1 LIMIT 1", [businessId])
        ]);
        const menu = menuResult.rows[0] || {};
        res.json({
            subscriberCount: Number(subscriptionResult.rows[0]?.count || 0),
            configured: Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT),
            menuEnabled: Boolean(menu.enabled),
            menuUrl: menu.token ? `/restaurant/${menu.token}` : null
        });
    } catch (error) {
        console.error("Marketing push settings error:", error);
        res.status(500).json({ error: "Could not load push notification settings" });
    }
});

app.get("/api/marketing/push-campaigns", async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, title, message, target_url, status, subscriber_count, sent_count, failed_count, created_at, sent_at
            FROM marketing_push_campaigns WHERE business_id=$1 ORDER BY created_at DESC LIMIT 50`, [Number(req.user.business_id)]);
        res.json({ campaigns: result.rows });
    } catch (error) {
        console.error("Marketing push campaigns load error:", error);
        res.status(500).json({ error: "Could not load notification campaigns" });
    }
});

app.delete("/api/marketing/push-campaigns/:id", async (req, res) => {
    try {
        const id = Number(req.params.id), businessId = Number(req.user.business_id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid message ID" });
        const result = await pool.query("DELETE FROM marketing_push_campaigns WHERE id=$1 AND business_id=$2 RETURNING id", [id, businessId]);
        if (!result.rows.length) return res.status(404).json({ error: "Notification message not found" });
        res.json({ success: true });
    } catch (error) { console.error("Marketing notification delete error:", error); res.status(500).json({ error: "Could not delete notification message" }); }
});

app.post("/api/marketing/push-campaigns", async (req, res) => {
    const title = String(req.body?.title || "").trim().slice(0, 120);
    const message = String(req.body?.message || "").trim().slice(0, 500);
    if (!title || !message) return res.status(400).json({ error: "Add a title and message" });
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
        return res.status(503).json({ error: "Push notifications need VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT in the server environment" });
    }
    let webPush;
    try { webPush = require("web-push"); }
    catch (_) { return res.status(503).json({ error: "The web-push package is not installed on this server" }); }
    try {
        const businessId = Number(req.user.business_id);
        const menuResult = await pool.query("SELECT token, enabled FROM public_menu_settings WHERE business_id=$1 LIMIT 1", [businessId]);
        const menu = menuResult.rows[0];
        if (!menu?.enabled || !menu.token) return res.status(400).json({ error: "Publish the Table QR Menu before sending a promotion" });
        const targetUrl = `/restaurant/${menu.token}`;
        const subscriptionResult = await pool.query("SELECT id, endpoint, subscription FROM public_menu_push_subscriptions WHERE business_id=$1 ORDER BY id", [businessId]);
        const subscriptions = subscriptionResult.rows;
        const campaignResult = await pool.query(`INSERT INTO marketing_push_campaigns(business_id, title, message, target_url, subscriber_count, created_by)
            VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [businessId, title, message, targetUrl, subscriptions.length, Number(req.user.id) || null]);
        const campaignId = Number(campaignResult.rows[0].id);
        webPush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
        let sentCount = 0, failedCount = 0;
        const expiredIds = [];
        const payload = JSON.stringify({ title, body: message, url: targetUrl, tag: `campaign-${campaignId}` });
        for (let offset = 0; offset < subscriptions.length; offset += 50) {
            const batch = subscriptions.slice(offset, offset + 50);
            const results = await Promise.allSettled(batch.map(row => webPush.sendNotification(row.subscription, payload, { TTL: 60 * 60 * 24 })));
            results.forEach((result, index) => {
                if (result.status === "fulfilled") sentCount++;
                else {
                    failedCount++;
                    const statusCode = Number(result.reason?.statusCode || 0);
                    if (statusCode === 404 || statusCode === 410) expiredIds.push(Number(batch[index].id));
                }
            });
        }
        if (expiredIds.length) await pool.query("DELETE FROM public_menu_push_subscriptions WHERE business_id=$1 AND id=ANY($2::int[])", [businessId, expiredIds]);
        const status = failedCount === 0 ? "sent" : sentCount === 0 ? "failed" : "partial";
        const saved = await pool.query(`UPDATE marketing_push_campaigns SET status=$3, sent_count=$4, failed_count=$5, sent_at=CURRENT_TIMESTAMP
            WHERE business_id=$1 AND id=$2 RETURNING id, title, message, target_url, status, subscriber_count, sent_count, failed_count, created_at, sent_at`,
            [businessId, campaignId, status, sentCount, failedCount]);
        res.status(201).json({ success: true, campaign: saved.rows[0], message: `Sent to ${sentCount} of ${subscriptions.length} subscribed device(s).` });
    } catch (error) {
        console.error("Marketing push send error:", error);
        res.status(500).json({ error: "Could not send this promotion" });
    }
});
app.put("/api/business/profile/logo", async (req, res) => {
    const businessId = Number(req.user?.business_id || 0);
    const rawLogo = req.body?.logoUrl;
    if (!Number.isInteger(businessId) || businessId <= 0) return res.status(401).json({ error: "Business session is required." });
    if (rawLogo !== null && rawLogo !== undefined && typeof rawLogo !== "string") {
        return res.status(400).json({ error: "Choose a PNG, JPEG or WebP logo image." });
    }
    const logoUrl = String(rawLogo || "").trim();
    if (logoUrl.length > 780000) return res.status(413).json({ error: "Logo is too large. Choose a smaller image." });
    if (logoUrl && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(logoUrl)) {
        return res.status(400).json({ error: "Logo must be a PNG, JPEG or WebP image." });
    }
    try {
        const result = await runSystemContext(() => pool.query(
            "UPDATE businesses SET logo_url=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING id,logo_url",
            [logoUrl || null, businessId]
        ));
        if (!result.rows.length) return res.status(404).json({ error: "Business profile not found." });
        res.json({ success: true, logoUrl: result.rows[0].logo_url || "" });
    } catch (error) {
        console.error("Business logo update error:", error);
        res.status(500).json({ error: "Could not update the business logo." });
    }
});

app.get(
    "/api/settings",
    async (req, res) => {
        try {
            const businessId = Number(req.user.business_id);
            const [result, brandingResult] = await Promise.all([pool.query(
                "SELECT settings FROM app_settings WHERE business_id = $1",
                [businessId]
            ), runSystemContext(() => pool.query(
                "SELECT show_powered_by_cafe_pilot FROM support_business_branding WHERE business_id=$1",
                [businessId]
            ))]);
            const settings = result.rows[0]?.settings || {};
            settings.posSalesChannels = salesChannelsForSettings(settings);
            settings.showPoweredByCafePilot = brandingResult.rows[0]?.show_powered_by_cafe_pilot !== false;
            res.json(settings);
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
                ? { ...req.body }
                : {};
            delete settings.showPoweredByCafePilot;
            delete settings.marketingDeals;
            delete settings.menuOptionSets;
            const businessId = Number(req.user.business_id);

            const result = await pool.query(
                `
                INSERT INTO app_settings (id, business_id, settings, updated_at)
                VALUES ($1, $1, $2::jsonb, CURRENT_TIMESTAMP)
                ON CONFLICT (business_id) DO UPDATE
                SET settings = COALESCE(app_settings.settings, '{}'::jsonb) || (EXCLUDED.settings - 'marketingDeals' - 'menuOptionSets'),
                    updated_at = CURRENT_TIMESTAMP
                RETURNING settings, updated_at
                `,
                [businessId, JSON.stringify(settings)]
            );

            const brandingResult = await runSystemContext(() => pool.query(
                "SELECT show_powered_by_cafe_pilot FROM support_business_branding WHERE business_id=$1",
                [businessId]
            ));
            const savedSettings = result.rows[0].settings || {};
            savedSettings.showPoweredByCafePilot = brandingResult.rows[0]?.show_powered_by_cafe_pilot !== false;
            res.json({
                success: true,
                settings: savedSettings,
                updated_at: result.rows[0].updated_at
            });
        } catch (e) {
            console.error("❌ Settings save error:", e);
            res.status(500).json({ error: "Failed to save settings" });
        }
    }
);

app.put("/api/settings/sales-channels", async (req, res) => {
    const businessId = Number(req.user?.business_id);
    const input = req.body?.channels;
    if (!Number.isInteger(businessId) || businessId <= 0 || !Array.isArray(input) || input.length < 2 || input.length > 40) {
        return res.status(400).json({ error: "Provide 2 to 40 sale channels." });
    }
    const channels = normalizeSalesChannels(input);
    const labels = channels.map(channel => channel.label.toLocaleLowerCase());
    if (channels.length !== input.length || new Set(labels).size !== labels.length ||
        !channels.some(channel => channel.orderType === "Dine-in") ||
        !channels.some(channel => channel.orderType === "Takeaway") ||
        !channels.some(channel => channel.qrMenu)) {
        return res.status(400).json({ error: "Channel keys and names must be unique. Keep at least one Dine-in channel, one Takeaway channel, and one QR Menu channel." });
    }
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await applyTenantDbContext(client);
        const savedResult = await client.query("SELECT settings FROM app_settings WHERE business_id=$1 FOR UPDATE", [businessId]);
        const settings = savedResult.rows[0]?.settings || {};
        const previous = salesChannelsForSettings(settings);
        const nextKeys = new Set(channels.map(channel => channel.key));
        const removedKeys = previous.map(channel => channel.key).filter(key => !nextKeys.has(key));

        const deals = Array.isArray(settings.marketingDeals) ? settings.marketingDeals.map(deal => {
            if (!Array.isArray(deal?.channels) || !deal.channels.length) return deal;
            const retained = deal.channels.map(value => String(value).toLowerCase()).filter(key => nextKeys.has(key));
            return { ...deal, channels: retained, active: retained.length ? deal.active !== false : false };
        }) : settings.marketingDeals;
        const preferences = {};
        for (const [name, orderType] of [["newOrder", "Takeaway"], ["tableView", "Dine-in"]]) {
            const available = channels.filter(channel => channel.orderType === orderType).map(channel => channel.key);
            const current = settings.posChannelPreferences?.[name] || {};
            const selected = Array.isArray(current.channels) ? current.channels.filter(key => available.includes(key)) : [];
            const selectedChannels = selected.length ? [...new Set(selected)] : available;
            preferences[name] = {
                channels: selectedChannels,
                defaultChannel: selectedChannels.includes(current.defaultChannel) ? current.defaultChannel : selectedChannels[0]
            };
        }
        const nextSettings = { ...settings, posSalesChannels: channels, posChannelPreferences: preferences };
        if (Array.isArray(deals)) nextSettings.marketingDeals = deals;
        await client.query(`
            INSERT INTO app_settings(id,business_id,settings,updated_at) VALUES($1,$1,$2::jsonb,CURRENT_TIMESTAMP)
            ON CONFLICT(business_id) DO UPDATE SET settings=EXCLUDED.settings,updated_at=CURRENT_TIMESTAMP
        `, [businessId, JSON.stringify(nextSettings)]);

        if (removedKeys.length) {
            const menuRows = await client.query("SELECT id,sales_channels,channel_prices FROM menu WHERE business_id=$1", [businessId]);
            for (const item of menuRows.rows) {
                const available = Array.isArray(item.sales_channels) ? item.sales_channels.map(String).filter(key => nextKeys.has(key)) : channels.map(channel => channel.key);
                const prices = item.channel_prices && typeof item.channel_prices === "object" ? { ...item.channel_prices } : {};
                removedKeys.forEach(key => delete prices[key]);
                await client.query("UPDATE menu SET sales_channels=$1::jsonb,channel_prices=$2::jsonb WHERE id=$3 AND business_id=$4", [JSON.stringify(available), JSON.stringify(prices), item.id, businessId]);
            }
            const variants = await client.query("SELECT id,channel_prices FROM menu_variants WHERE business_id=$1", [businessId]);
            for (const variant of variants.rows) {
                const prices = variant.channel_prices && typeof variant.channel_prices === "object" ? { ...variant.channel_prices } : {};
                removedKeys.forEach(key => delete prices[key]);
                await client.query("UPDATE menu_variants SET channel_prices=$1::jsonb WHERE id=$2 AND business_id=$3", [JSON.stringify(prices), variant.id, businessId]);
            }
            await client.query("UPDATE billing_adjustments SET active=FALSE,updated_at=CURRENT_TIMESTAMP WHERE business_id=$1 AND replace(replace(lower(applies_to),'-','_'),' ','_')=ANY($2::text[])", [businessId, removedKeys]);
        }
        const qrFallback = channels.find(channel => channel.qrMenu)?.key;
        await client.query("UPDATE public_menu_settings SET price_channel=$1,updated_at=CURRENT_TIMESTAMP WHERE business_id=$2 AND NOT (price_channel=ANY($3::text[]))", [qrFallback, businessId, channels.filter(channel => channel.qrMenu).map(channel => channel.key)]);
        await client.query("COMMIT");
        res.json({ success: true, channels, settings: nextSettings, marketingDeals: Array.isArray(nextSettings.marketingDeals) ? nextSettings.marketingDeals : [] });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Save sales channels error:", error);
        res.status(error.status || 500).json({ error: error.message || "Could not save sale channels." });
    } finally {
        client.release();
    }
});

function isPrivatePrinterIPv4(value) {
    const ip=String(value||'').trim();
    if(net.isIP(ip)!==4)return false;
    const [a,b]=ip.split('.').map(Number);
    return a===10||(a===192&&b===168)||(a===172&&b>=16&&b<=31)||a===127;
}

function normalizePrinterPayload(body={}, current={}) {
    const value=(key,fallback='')=>body[key]===undefined?current[key]??fallback:body[key];
    const name=String(value('name','')).trim().slice(0,120);
    const connectionType=String(value('connectionType',current.connection_type||'local'));
    const host=String(value('host',current.host||'')).trim();
    const port=Number(value('port',current.port||9100));
    const paperWidth=String(value('paperWidth',current.paper_width||'80'));
    const bluetoothName=String(value('bluetoothName',current.bluetooth_name||'')).trim().slice(0,120);
    const serviceUuid=String(value('serviceUuid',current.service_uuid||'000018f0-0000-1000-8000-00805f9b34fb')).trim().slice(0,120);
    const characteristicUuid=String(value('characteristicUuid',current.characteristic_uuid||'00002af1-0000-1000-8000-00805f9b34fb')).trim().slice(0,120);
    const isDefault=body.isDefault===undefined?Boolean(current.is_default):body.isDefault===true;
    if(!name)throw Object.assign(new Error('Printer name is required'),{status:400});
    if(!['local','bluetooth','network'].includes(connectionType))throw Object.assign(new Error('Select a supported printer connection type'),{status:400});
    if(!['58','80'].includes(paperWidth))throw Object.assign(new Error('Paper width must be 58mm or 80mm'),{status:400});
    if(connectionType==='network'){
        if(!isPrivatePrinterIPv4(host))throw Object.assign(new Error('Enter a private LAN IPv4 address for the network printer'),{status:400});
        if(!Number.isInteger(port)||port<1||port>65535)throw Object.assign(new Error('Printer port must be between 1 and 65535'),{status:400});
    }
    if(connectionType==='bluetooth'&&(!serviceUuid||!characteristicUuid))throw Object.assign(new Error('Bluetooth service and write characteristic UUIDs are required'),{status:400});
    return {name,connectionType,host:connectionType==='network'?host:null,port:connectionType==='network'?port:9100,bluetoothName:connectionType==='bluetooth'?(bluetoothName||name):null,serviceUuid,characteristicUuid,paperWidth,isDefault};
}

function receiptTextForPrinter(receipt={}, settings={}, paperWidth='80') {
    const width=paperWidth==='58'?32:48;
    const clean=value=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();
    const currency=clean(settings.currency||'₹');
    const line='-'.repeat(width);
    const moneyValue=value=>currency+Number(value||0).toFixed(2);
    const rows=[
        clean(settings.restaurantName||'SLASH POS'),
        clean(settings.address||''),
        settings.phone?'Phone: '+clean(settings.phone):'',
        settings.gstin?'GSTIN: '+clean(settings.gstin):'',
        line,
        receipt.isOpenOrder?'OPEN ORDER / PROFORMA':'Invoice: '+clean(receipt.invoiceNumber||'-'),
        'Order: '+clean(receipt.orderNumber||'-'),
        'Type: '+clean(receipt.orderType||'-'),
        receipt.tableNumber?'Table: '+clean(receipt.tableNumber):'',
        'Date: '+clean(receipt.date||new Date().toLocaleString()),
        receipt.customerName?'Customer: '+clean(receipt.customerName):'',
        line,
        'ITEM                         QTY      AMOUNT',
        ...(Array.isArray(receipt.items)?receipt.items.flatMap(item=>{
            const name=clean(settings.uppercaseItems?String(item.name||'-').toUpperCase():(item.name||'-')).slice(0,width-17);
            const qty=Number(item.quantity||0),amount=qty*Number(item.price||0);
            const row=[name.padEnd(width-16)+String(qty).padStart(4)+' '+moneyValue(amount).padStart(12)];
            const options=Array.isArray(item.options)?item.options.flatMap(set=>Array.isArray(set.options)?set.options.map(option=>clean(option.name)):[]).filter(Boolean):[];
            if(options.length)row.push('  + '+options.join(', ').slice(0,width-4));
            return row;
        }):[]),
        line,
        'Subtotal: '+moneyValue(receipt.subtotal||0),
        'GST:      '+moneyValue(receipt.gst||0),
        'TOTAL:    '+moneyValue(receipt.total||0),
        'Payment:  '+clean(receipt.paymentMethod||'-'),
        line,
        ...clean(settings.footer||'Thank you!').split(/\r?\n/).map(clean),
        '',
        ''
    ];
    return Buffer.concat([Buffer.from([0x1b,0x40,0x1b,0x61,0x01]),Buffer.from(rows.filter(Boolean).join('\n')+'\n','utf8'),Buffer.from([0x1b,0x64,0x04,0x1d,0x56,0x00])]);
}

function sendRawPrinterBytes(host,port,bytes) {
    return new Promise((resolve,reject)=>{
        const socket=net.createConnection({host,port});
        const timer=setTimeout(()=>{socket.destroy();reject(new Error('Printer connection timed out'))},5000);
        socket.once('connect',()=>socket.end(bytes));
        socket.once('error',error=>{clearTimeout(timer);reject(new Error(error.code==='ECONNREFUSED'?'Printer refused the connection':error.message))});
        socket.once('close',hadError=>{clearTimeout(timer);if(!hadError)resolve()});
    });
}

async function getTenantPrinter(req,res,printerId) {
    const id=Number(printerId),businessId=Number(req.user.business_id);
    if(!Number.isInteger(id)||id<=0){res.status(400).json({error:'Invalid printer ID'});return null;}
    const printer=(await pool.query('SELECT * FROM printers WHERE id=$1 AND business_id=$2 AND active=TRUE',[id,businessId])).rows[0];
    if(!printer){res.status(404).json({error:'Printer not found'});return null;}
    return printer;
}

app.get('/api/printers',async(req,res)=>{
    try{res.json((await pool.query('SELECT id,name,connection_type,host,port,bluetooth_name,service_uuid,characteristic_uuid,paper_width,is_default,active,created_at,updated_at FROM printers WHERE business_id=$1 ORDER BY is_default DESC,name',[Number(req.user.business_id)])).rows);}
    catch(e){console.error('Printer list error:',e);res.status(500).json({error:'Failed to load printers'});}
});

app.post('/api/printers',async(req,res)=>{
    try{
        const businessId=Number(req.user.business_id),printer=normalizePrinterPayload(req.body);
        const existing=await pool.query('SELECT COUNT(*)::int AS count FROM printers WHERE business_id=$1 AND active=TRUE',[businessId]);
        printer.isDefault=printer.isDefault||Number(existing.rows[0]?.count||0)===0;
        if(printer.isDefault)await pool.query('UPDATE printers SET is_default=FALSE WHERE business_id=$1',[businessId]);
        const created=await pool.query(`
            INSERT INTO printers(business_id,name,connection_type,host,port,bluetooth_name,service_uuid,characteristic_uuid,paper_width,is_default)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            RETURNING id,name,connection_type,host,port,bluetooth_name,service_uuid,characteristic_uuid,paper_width,is_default,active
        `,[businessId,printer.name,printer.connectionType,printer.host,printer.port,printer.bluetoothName,printer.serviceUuid,printer.characteristicUuid,printer.paperWidth,printer.isDefault]);
        res.status(201).json({success:true,printer:created.rows[0]});
    }catch(e){res.status(e.status||500).json({error:e.message||'Failed to save printer'});}
});

app.put('/api/printers/:id',async(req,res)=>{
    try{
        const businessId=Number(req.user.business_id),id=Number(req.params.id);
        const current=(await pool.query('SELECT * FROM printers WHERE id=$1 AND business_id=$2',[id,businessId])).rows[0];
        if(!current)return res.status(404).json({error:'Printer not found'});
        const printer=normalizePrinterPayload(req.body,current);
        if(printer.isDefault)await pool.query('UPDATE printers SET is_default=FALSE WHERE business_id=$1 AND id<>$2',[businessId,id]);
        const updated=(await pool.query(`
            UPDATE printers SET name=$1,connection_type=$2,host=$3,port=$4,bluetooth_name=$5,
                service_uuid=$6,characteristic_uuid=$7,paper_width=$8,is_default=$9,updated_at=CURRENT_TIMESTAMP
            WHERE id=$10 AND business_id=$11
            RETURNING id,name,connection_type,host,port,bluetooth_name,service_uuid,characteristic_uuid,paper_width,is_default,active
        `,[printer.name,printer.connectionType,printer.host,printer.port,printer.bluetoothName,printer.serviceUuid,printer.characteristicUuid,printer.paperWidth,printer.isDefault,id,businessId])).rows[0];
        res.json({success:true,printer:updated});
    }catch(e){res.status(e.status||500).json({error:e.message||'Failed to update printer'});}
});

app.delete('/api/printers/:id',async(req,res)=>{
    try{
        const businessId=Number(req.user.business_id),id=Number(req.params.id);
        const deleted=(await pool.query('DELETE FROM printers WHERE id=$1 AND business_id=$2 RETURNING id,is_default',[id,businessId])).rows[0];
        if(!deleted)return res.status(404).json({error:'Printer not found'});
        if(deleted.is_default){
            await pool.query('UPDATE printers SET is_default=TRUE WHERE id=(SELECT id FROM printers WHERE business_id=$1 ORDER BY id LIMIT 1)',[businessId]);
        }
        res.json({success:true});
    }catch(e){res.status(500).json({error:'Failed to delete printer'});}
});

app.post('/api/printers/:id/test',async(req,res)=>{
    try{
        const printer=await getTenantPrinter(req,res,req.params.id);
        if(!printer)return;
        if(printer.connection_type==='network'){
            const body=receiptTextForPrinter({invoiceNumber:'PRINTER TEST',orderNumber:'TEST',items:[],subtotal:0,gst:0,total:0,paymentMethod:'—'},{restaurantName:'Slash POS Printer Test',footer:'Printer connection successful'},printer.paper_width);
            await sendRawPrinterBytes(printer.host,printer.port,body);
            return res.json({success:true,mode:'network'});
        }
        res.json({success:true,mode:printer.connection_type});
    }catch(e){res.status(502).json({error:e.message||'Printer test failed'});}
});

app.post('/api/printers/:id/print',async(req,res)=>{
    try{
        const printer=await getTenantPrinter(req,res,req.params.id);
        if(!printer)return;
        if(printer.connection_type!=='network')return res.status(400).json({error:'Use the local print dialog or Bluetooth connection for this printer'});
        if(!req.body.receipt||!['object','string'].includes(typeof req.body.receipt))return res.status(400).json({error:'Receipt data is required'});
        const savedSettings=(await pool.query('SELECT settings FROM app_settings WHERE business_id=$1',[Number(req.user.business_id)])).rows[0]?.settings||{};
        const settings={
            restaurantName:req.user.business_name||'SLASH POS',
            address:req.user.business_address||'',
            phone:req.user.business_phone||'',
            gstin:req.user.gstin||'',
            currency:req.user.currency||'₹',
            ...savedSettings
        };
        const bytes=typeof req.body.receipt==='string'
            ? Buffer.concat([Buffer.from([0x1b,0x40,0x1b,0x61,0x01]),Buffer.from(req.body.receipt,'utf8'),Buffer.from([0x1b,0x64,0x04,0x1d,0x56,0x00])])
            : receiptTextForPrinter(req.body.receipt,settings,printer.paper_width);
        const copies = Math.min(20, Math.max(0, Math.floor(Number(req.body.copies) || 0)));
        for (let copy = 0; copy < copies; copy++) await sendRawPrinterBytes(printer.host,printer.port,bytes);
        res.json({success:true,copies});
    }catch(e){res.status(502).json({error:e.message||'Could not print to the network printer'});}
});

// =====================================================
// MULTI-BUSINESS DATA ISOLATION (PHASE 2A)
// =====================================================
const TENANT_TABLES_PHASE_2A = [
    'menu_categories','menu','menu_variants','restaurant_tables','orders','order_items',
    'reservations','kot_groups','kot','payments','customers','invoices','order_activity',
    'loyalty_settings','loyalty_transactions','billing_adjustments','expense_categories','expenses','printers','app_settings','public_menu_settings','public_menu_push_subscriptions','marketing_push_campaigns','invoice_number_counters'
];

// NOTE: Orders, order_items, reservations, KOT, payments, customers, and invoices
// are also tenant-isolated at the database layer by the Phase 2A RLS policy above.
// The authenticated tenant context is now established for every /api route, so
// those existing SQL routes inherit the current business automatically without
// requiring repetitive WHERE business_id clauses everywhere.


async function tableExists(tableName) {
    const r = await pool.query(`
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema='public' AND table_name=$1
        ) AS exists
    `, [tableName]);
    return r.rows[0]?.exists === true;
}

async function makeNameUniquePerBusiness(tableName, columnName) {
    if (!(await tableExists(tableName))) return;
    const safeTable=String(tableName).replace(/"/g,'""');
    const safeColumn=String(columnName).replace(/"/g,'""');
    const indexName=`uq_${tableName}_business_${columnName}`.replace(/[^a-zA-Z0-9_]/g,'_');

    // Remove a legacy global UNIQUE(name) constraint even when existing
    // same-business duplicates prevent creation of the replacement index.
    const constraints = await pool.query(`
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        WHERE tc.table_schema='public'
          AND tc.table_name=$1
          AND tc.constraint_type='UNIQUE'
          AND (SELECT COUNT(*) FROM information_schema.constraint_column_usage c2
               WHERE c2.constraint_schema=tc.constraint_schema
                 AND c2.constraint_name=tc.constraint_name)=1
          AND EXISTS (SELECT 1 FROM information_schema.constraint_column_usage c1
                      WHERE c1.constraint_schema=tc.constraint_schema
                        AND c1.constraint_name=tc.constraint_name
                        AND c1.column_name=$2)
    `, [tableName, columnName]);
    for (const row of constraints.rows) {
        const safeConstraint=String(row.constraint_name).replace(/"/g,'""');
        await pool.query(`ALTER TABLE "${safeTable}" DROP CONSTRAINT IF EXISTS "${safeConstraint}"`);
    }

    const duplicateGroups = await pool.query(`
        SELECT COUNT(*)::INTEGER AS count
        FROM (
            SELECT business_id, "${safeColumn}"
            FROM "${safeTable}"
            WHERE "${safeColumn}" IS NOT NULL
            GROUP BY business_id, "${safeColumn}"
            HAVING COUNT(*) > 1
        ) duplicates
    `);
    const duplicateCount=Number(duplicateGroups.rows[0]?.count||0);
    if (duplicateCount) {
        console.warn(`⚠️ Skipping unique index ${indexName}: ${duplicateCount} duplicate ${columnName} value group(s) already exist in ${tableName}; existing rows were left unchanged.`);
        return;
    }

    try {
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS "${indexName}" ON "${safeTable}"(business_id,"${safeColumn}")`);
    } catch (error) {
        if (error.code !== '23505') throw error;
        console.warn(`⚠️ Skipping unique index ${indexName}: duplicate ${columnName} values appeared while the index was being created.`);
    }
}

async function ensureTenantIsolationPhase2A() {
    console.log('🔧 Phase 2A: starting tenant isolation migration');
    if (!systemBusinessId) {
        const r=await runSystemContext(() => pool.query(`SELECT id FROM businesses ORDER BY id LIMIT 1`));
        systemBusinessId=Number(r.rows[0]?.id||0)||null;
    }
    if (!systemBusinessId) throw new Error('No default business exists for tenant migration');

    for (const tableName of TENANT_TABLES_PHASE_2A) {
        console.log(`🔧 Phase 2A: migrating table ${tableName}`);
        if (!(await tableExists(tableName))) continue;
        const safeTable=String(tableName).replace(/"/g,'""');
        await pool.query(`ALTER TABLE "${safeTable}" ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`);
        await pool.query(`UPDATE "${safeTable}" SET business_id=$1 WHERE business_id IS NULL`,[systemBusinessId]);
        await pool.query(`ALTER TABLE "${safeTable}" ALTER COLUMN business_id SET DEFAULT NULLIF(current_setting('app.business_id', true), '')::INTEGER`);
        await pool.query(`ALTER TABLE "${safeTable}" ALTER COLUMN business_id SET NOT NULL`);
        const indexName=`idx_${tableName}_business_id`.replace(/[^a-zA-Z0-9_]/g,'_');
        if (tableName === 'app_settings') {
            await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_app_settings_business_id_unique ON app_settings(business_id)`);
        } else {
            await pool.query(`CREATE INDEX IF NOT EXISTS "${indexName}" ON "${safeTable}"(business_id)`);
        }
        await pool.query(`ALTER TABLE "${safeTable}" ENABLE ROW LEVEL SECURITY`);
        await pool.query(`ALTER TABLE "${safeTable}" FORCE ROW LEVEL SECURITY`);
        await pool.query(`DROP POLICY IF EXISTS tenant_isolation ON "${safeTable}"`);
        await pool.query(`CREATE POLICY tenant_isolation ON "${safeTable}"
            USING (current_setting('app.system_mode', true)='on' OR business_id=NULLIF(current_setting('app.business_id', true),'')::INTEGER)
            WITH CHECK (current_setting('app.system_mode', true)='on' OR business_id=NULLIF(current_setting('app.business_id', true),'')::INTEGER)`);
    }

    await pool.query(`ALTER TABLE businesses ENABLE ROW LEVEL SECURITY`);
    await pool.query(`ALTER TABLE businesses FORCE ROW LEVEL SECURITY`);
    await pool.query(`DROP POLICY IF EXISTS tenant_isolation ON businesses`);
    await pool.query(`CREATE POLICY tenant_isolation ON businesses
        USING (current_setting('app.system_mode', true)='on' OR id=NULLIF(current_setting('app.business_id', true),'')::INTEGER)
        WITH CHECK (current_setting('app.system_mode', true)='on' OR id=NULLIF(current_setting('app.business_id', true),'')::INTEGER)`);

    await dropSingleColumnUniqueConstraints('invoices','invoice_number');
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_business_invoice_number ON invoices(business_id,invoice_number)`);
    await pool.query(`
        INSERT INTO invoice_number_counters(business_id,next_number)
        SELECT b.id,COALESCE(MAX(NULLIF((regexp_match(i.invoice_number,'([0-9]+)$'))[1],'')::BIGINT),0)+1
        FROM businesses b
        LEFT JOIN invoices i ON i.business_id=b.id
        GROUP BY b.id
        ON CONFLICT(business_id) DO NOTHING
    `);

    await pool.query(`
        INSERT INTO order_activity(order_id,business_id,event_type,description,actor,created_at)
        SELECT o.id,o.business_id,'Order activity started','Order created before activity tracking was enabled.','System',COALESCE(o.created_at,CURRENT_TIMESTAMP)
        FROM orders o
        WHERE NOT EXISTS (SELECT 1 FROM order_activity a WHERE a.order_id=o.id)
    `);

    // Reservations are time-slot records; they must not leave the physical
    // table marked unavailable between visits. Arrived tables stay occupied.
    await pool.query(`
        UPDATE restaurant_tables t
        SET status='Available'
        WHERE t.status='Reserved'
          AND NOT EXISTS (
              SELECT 1 FROM orders o
              WHERE o.business_id=t.business_id
                AND o.table_number::text=t.table_number::text
                AND o.status NOT IN ('Completed','Cancelled')
          )
    `);

    await makeNameUniquePerBusiness('kot_groups','name');
    await makeNameUniquePerBusiness('menu','name');
    await makeNameUniquePerBusiness('menu_categories','name');
    await makeNameUniquePerBusiness('restaurant_tables','table_number');
    await makeNameUniquePerBusiness('customers','phone');
    await makeNameUniquePerBusiness('expense_categories','name');
    await makeNameUniquePerBusiness('billing_adjustments','name');
    console.log('✅ Phase 2A tenant isolation ready');
}

async function ensurePrinterTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS printers (
            id SERIAL PRIMARY KEY,
            business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
            name VARCHAR(120) NOT NULL,
            connection_type VARCHAR(20) NOT NULL DEFAULT 'local',
            host VARCHAR(64),
            port INTEGER NOT NULL DEFAULT 9100,
            bluetooth_name VARCHAR(120),
            service_uuid VARCHAR(120) NOT NULL DEFAULT '000018f0-0000-1000-8000-00805f9b34fb',
            characteristic_uuid VARCHAR(120) NOT NULL DEFAULT '00002af1-0000-1000-8000-00805f9b34fb',
            paper_width VARCHAR(4) NOT NULL DEFAULT '80',
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_printers_business_default ON printers(business_id) WHERE is_default=TRUE`);
}

async function seedTenantDefaults(businessId) {
    const id=Number(businessId);
    if (!id) return;
    return tenantContext.run({businessId:id}, async()=>{
        if (await tableExists('kot_groups')) {
            await pool.query(`INSERT INTO kot_groups(name,description,station,sort_order,active)
                VALUES('Main Kitchen','Default KOT group','Kitchen',0,TRUE)
                ON CONFLICT (business_id,name) DO NOTHING`);
        }
        if (await tableExists('expense_categories')) {
            const defaults=['Purchase / Supplies','Staff / Salary','Rent','Utilities','Marketing','Maintenance','Delivery / Logistics','Other'];
            for (const name of defaults) {
                await pool.query(`INSERT INTO expense_categories(name,business_id) VALUES($1,$2) ON CONFLICT (business_id,name) DO NOTHING`,[name,id]);
            }
        }
    });
}


// =====================================================
// PHASE 2B — AUTH / DEVICE / LICENSE ISOLATION
// =====================================================
async function dropSingleColumnUniqueConstraints(tableName, columnName) {
    const constraints = await pool.query(`
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        WHERE tc.table_schema='public'
          AND tc.table_name=$1
          AND tc.constraint_type='UNIQUE'
          AND (SELECT COUNT(*) FROM information_schema.constraint_column_usage c2
               WHERE c2.constraint_schema=tc.constraint_schema
                 AND c2.constraint_name=tc.constraint_name)=1
          AND EXISTS (SELECT 1 FROM information_schema.constraint_column_usage c1
                      WHERE c1.constraint_schema=tc.constraint_schema
                        AND c1.constraint_name=tc.constraint_name
                        AND c1.column_name=$2)
    `, [tableName, columnName]);
    const safeTable = String(tableName).replace(/"/g, '""');
    for (const row of constraints.rows) {
        const safeConstraint = String(row.constraint_name).replace(/"/g, '""');
        await pool.query(`ALTER TABLE "${safeTable}" DROP CONSTRAINT IF EXISTS "${safeConstraint}"`);
    }
}

async function enableTenantRls(tableName) {
    const safeTable = String(tableName).replace(/"/g, '""');
    await pool.query(`ALTER TABLE "${safeTable}" ENABLE ROW LEVEL SECURITY`);
    await pool.query(`ALTER TABLE "${safeTable}" FORCE ROW LEVEL SECURITY`);
    await pool.query(`DROP POLICY IF EXISTS tenant_isolation ON "${safeTable}"`);
    await pool.query(`CREATE POLICY tenant_isolation ON "${safeTable}"
        USING (current_setting('app.system_mode', true)='on' OR business_id=NULLIF(current_setting('app.business_id', true),'')::INTEGER)
        WITH CHECK (current_setting('app.system_mode', true)='on' OR business_id=NULLIF(current_setting('app.business_id', true),'')::INTEGER)`);
}

async function ensureLicenseTables() {
    console.log('🔐 Phase 2B: ensuring license/device tables');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS business_licenses (
            id SERIAL PRIMARY KEY,
            business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
            plan VARCHAR(60) NOT NULL DEFAULT 'Trial',
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            starts_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMPTZ NOT NULL,
            max_devices INTEGER NOT NULL DEFAULT 1,
            notes TEXT,
            created_by_support_user_id INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            revoked_at TIMESTAMPTZ
        )
    `);

    await pool.query(`ALTER TABLE business_licenses ADD COLUMN IF NOT EXISTS license_type VARCHAR(20)`);
    await pool.query(`ALTER TABLE business_licenses ADD COLUMN IF NOT EXISTS duration_months INTEGER`);
    await pool.query(`ALTER TABLE business_licenses ADD COLUMN IF NOT EXISTS add_on VARCHAR(60)`);
    await pool.query(`
        DO $$ BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname='business_licenses_valid_term'
                  AND conrelid='business_licenses'::regclass
                  AND LOWER(pg_get_constraintdef(oid)) LIKE '%marketing%'
            ) THEN
                ALTER TABLE business_licenses DROP CONSTRAINT business_licenses_valid_term;
            END IF;
        END $$
    `);
    await pool.query(`
        UPDATE business_licenses
        SET add_on=COALESCE(NULLIF(BTRIM(add_on),''),'Marketing'),
            license_type='Sales',
            plan='Sales'
        WHERE LOWER(BTRIM(COALESCE(license_type,'')))='marketing'
           OR LOWER(BTRIM(COALESCE(plan,'')))='marketing'
    `);
    await pool.query(`
        UPDATE business_licenses
        SET license_type = CASE
                WHEN LOWER(BTRIM(COALESCE(plan, ''))) = 'trial' THEN 'Trial'
                ELSE 'Sales'
            END,
            duration_months = CASE
                WHEN LOWER(BTRIM(COALESCE(plan, ''))) = 'trial' THEN 1
                ELSE 12
            END
        WHERE license_type IS NULL OR duration_months IS NULL
    `);
    await pool.query(`ALTER TABLE business_licenses ALTER COLUMN license_type SET DEFAULT 'Trial'`);
    await pool.query(`ALTER TABLE business_licenses ALTER COLUMN duration_months SET DEFAULT 1`);
    await pool.query(`ALTER TABLE business_licenses ALTER COLUMN license_type SET NOT NULL`);
    await pool.query(`ALTER TABLE business_licenses ALTER COLUMN duration_months SET NOT NULL`);
    await pool.query(`
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='business_licenses_valid_term' AND conrelid='business_licenses'::regclass) THEN
                ALTER TABLE business_licenses ADD CONSTRAINT business_licenses_valid_term
                CHECK ((license_type = 'Trial' AND duration_months = 1)
                    OR (license_type = 'Sales' AND duration_months IN (3,6,12)));
            END IF;
        END $$
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS registered_devices (
            id SERIAL PRIMARY KEY,
            business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
            license_id INTEGER REFERENCES business_licenses(id) ON DELETE SET NULL,
            device_id VARCHAR(128) NOT NULL UNIQUE,
            device_name VARCHAR(160) NOT NULL DEFAULT 'POS Device',
            device_type VARCHAR(60) NOT NULL DEFAULT 'Web',
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            registration_key_id INTEGER,
            registered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_ip VARCHAR(120),
            user_agent TEXT,
            revoked_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS device_registration_keys (
            id SERIAL PRIMARY KEY,
            business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
            license_id INTEGER REFERENCES business_licenses(id) ON DELETE SET NULL,
            key_hash VARCHAR(128) NOT NULL UNIQUE,
            key_hint VARCHAR(20) NOT NULL,
            device_name VARCHAR(160),
            status VARCHAR(20) NOT NULL DEFAULT 'unused',
            created_by_type VARCHAR(20) NOT NULL DEFAULT 'admin',
            created_by_user_id INTEGER,
            expires_at TIMESTAMPTZ,
            used_at TIMESTAMPTZ,
            used_device_id INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`ALTER TABLE registered_devices ADD COLUMN IF NOT EXISTS registration_key_id INTEGER`);
    await pool.query(`ALTER TABLE registered_devices ADD COLUMN IF NOT EXISTS license_id INTEGER REFERENCES business_licenses(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE device_registration_keys ADD COLUMN IF NOT EXISTS license_id INTEGER REFERENCES business_licenses(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE device_registration_keys ADD COLUMN IF NOT EXISTS used_device_id INTEGER`);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_business_licenses_business_id
        ON business_licenses(business_id, id DESC)
    `);
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_registered_devices_business_id
        ON registered_devices(business_id, status)
    `);
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_device_registration_keys_business_id
        ON device_registration_keys(business_id, status)
    `);

    await enableTenantRls('business_licenses');
    await enableTenantRls('registered_devices');
    await enableTenantRls('device_registration_keys');

    // Support infrastructure is deliberately NOT tenant RLS-scoped.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS support_users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(100) NOT NULL UNIQUE,
            display_name VARCHAR(150) NOT NULL DEFAULT 'Support',
            password_hash TEXT NOT NULL,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS support_sessions (
            token VARCHAR(128) PRIMARY KEY,
            token_hash VARCHAR(64),
            support_user_id INTEGER NOT NULL REFERENCES support_users(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`ALTER TABLE support_sessions ADD COLUMN IF NOT EXISTS token_hash VARCHAR(64)`);
    const legacySupportSessions = await pool.query(`SELECT token FROM support_sessions WHERE token_hash IS NULL`);
    for (const row of legacySupportSessions.rows) {
        const tokenHash = hashSessionToken(row.token);
        await pool.query(`UPDATE support_sessions SET token=$1,token_hash=$1 WHERE token=$2`, [tokenHash, row.token]);
    }
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_support_sessions_token_hash ON support_sessions(token_hash)`);
    await pool.query(`ALTER TABLE support_sessions ALTER COLUMN token_hash SET NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_support_sessions_expires_at ON support_sessions(expires_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_support_sessions_user_id ON support_sessions(support_user_id)`);

    const supportUsername = String(process.env.SUPPORT_USERNAME || '').trim().toLowerCase();
    const supportPassword = String(process.env.SUPPORT_PASSWORD || '');
    if (supportUsername && supportPassword) {
        const existing = await pool.query(`SELECT id FROM support_users WHERE username=$1 LIMIT 1`, [supportUsername]);
        if (!existing.rows.length) {
            await pool.query(`INSERT INTO support_users(username,display_name,password_hash,active) VALUES($1,$2,$3,TRUE)`, [supportUsername, 'Slash POS Support', await hashPassword(supportPassword)]);
            console.log(`✅ Support account created for ${supportUsername}`);
        }
    } else {
        console.warn('⚠️ SUPPORT_USERNAME / SUPPORT_PASSWORD not configured; support login will be unavailable until they are set.');
    }

    await ensureTrialLicensesForBusinesses();
    console.log('✅ Phase 2B license/device tables ready');
}

async function ensureTrialLicensesForBusinesses() {
    const businesses = await runSystemContext(() => pool.query(`SELECT id FROM businesses WHERE active=TRUE ORDER BY id`));
    const maxDevices = Math.max(1, Number(process.env.AUTO_TRIAL_MAX_DEVICES || 1));
    for (const row of businesses.rows) {
        const existing = await runSystemContext(() => pool.query(`SELECT id FROM business_licenses WHERE business_id=$1 ORDER BY id DESC LIMIT 1`, [row.id]));
        if (!existing.rows.length) {
            await runSystemContext(() => pool.query(`
                INSERT INTO business_licenses(business_id,plan,license_type,duration_months,status,starts_at,expires_at,max_devices,notes)
                VALUES($1,'Trial','Trial',1,'active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + INTERVAL '1 month',$2,'Automatically created trial license')
            `, [Number(row.id), maxDevices]));
        }
    }
}

async function seedAllBusinessAccessProfiles() {
    const businesses = await runSystemContext(() => pool.query(`SELECT id FROM businesses ORDER BY id`));
    for (const row of businesses.rows) await seedBusinessAccessProfiles(Number(row.id));
}

async function ensurePhase2BAuthIsolation() {
    console.log('🔐 Phase 2B: tenant-scoping users and access profiles');

    // -----------------------------------------------------
    // USERS: make username unique PER BUSINESS.
    // Existing installs can contain legacy duplicates such as
    // `Manager` + `manager`. Normalize first, then preserve the
    // most useful record and rename duplicate legacy records so no
    // user/account data is silently deleted.
    // -----------------------------------------------------
    await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL`);
    await pool.query(`UPDATE app_users SET business_id=$1 WHERE business_id IS NULL`, [systemBusinessId]);
    await pool.query(`ALTER TABLE app_users ALTER COLUMN business_id SET NOT NULL`);
    await dropSingleColumnUniqueConstraints('app_users', 'username');
    await pool.query(`DROP INDEX IF EXISTS app_users_username_key`);

    await pool.query(`
        UPDATE app_users
        SET username = LOWER(BTRIM(username))
        WHERE username IS NOT NULL
          AND username <> LOWER(BTRIM(username))
    `);

    const duplicateUsers = await pool.query(`
        SELECT id, business_id, username
        FROM (
            SELECT
                id,
                business_id,
                username,
                ROW_NUMBER() OVER (
                    PARTITION BY business_id, LOWER(BTRIM(username))
                    ORDER BY
                        CASE WHEN password_hash IS NOT NULL AND BTRIM(password_hash) <> '' THEN 0 ELSE 1 END,
                        CASE WHEN active THEN 0 ELSE 1 END,
                        updated_at DESC NULLS LAST,
                        id ASC
                ) AS rn
            FROM app_users
            WHERE business_id IS NOT NULL
        ) ranked
        WHERE rn > 1
        ORDER BY business_id, LOWER(BTRIM(username)), id
    `);

    for (const row of duplicateUsers.rows) {
        const base = String(row.username || 'user').trim() || 'user';
        const legacyUsername = `${base}__legacy_${row.id}`;
        await pool.query(
            `UPDATE app_users SET username=$1, active=FALSE, updated_at=CURRENT_TIMESTAMP WHERE id=$2`,
            [legacyUsername, Number(row.id)]
        );
        console.log(`⚠️ Phase 2B: preserved duplicate user #${row.id} as ${legacyUsername}`);
    }

    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_business_username ON app_users(business_id, LOWER(username))`);

    // -----------------------------------------------------
    // ACCESS PROFILES: make profile names unique PER BUSINESS.
    // Legacy duplicate profiles are merged into the first profile
    // and every existing user/business reference is moved first.
    // -----------------------------------------------------
    await pool.query(`ALTER TABLE access_profiles ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE`);
    await dropSingleColumnUniqueConstraints('access_profiles', 'name');
    await pool.query(`DROP INDEX IF EXISTS access_profiles_name_key`);
    await pool.query(`UPDATE access_profiles SET business_id=$1 WHERE business_id IS NULL`, [systemBusinessId]);

    const duplicateProfiles = await pool.query(`
        SELECT id, business_id, name
        FROM (
            SELECT
                id,
                business_id,
                name,
                ROW_NUMBER() OVER (
                    PARTITION BY business_id, name
                    ORDER BY id ASC
                ) AS rn
            FROM access_profiles
            WHERE business_id IS NOT NULL
        ) ranked
        WHERE rn > 1
        ORDER BY business_id, name, id
    `);

    for (const row of duplicateProfiles.rows) {
        const canonical = await pool.query(`
            SELECT id
            FROM access_profiles
            WHERE business_id=$1 AND name=$2
            ORDER BY id ASC
            LIMIT 1
        `, [Number(row.business_id), row.name]);
        const canonicalId = Number(canonical.rows[0]?.id || 0);
        if (!canonicalId || canonicalId === Number(row.id)) continue;

        await pool.query(
            `UPDATE app_users SET profile_id=$1 WHERE profile_id=$2 AND business_id=$3`,
            [canonicalId, Number(row.id), Number(row.business_id)]
        );
        await pool.query(
            `UPDATE businesses SET profile_id=$1 WHERE profile_id=$2 AND id=$3`,
            [canonicalId, Number(row.id), Number(row.business_id)]
        );
        await pool.query(`DELETE FROM access_profiles WHERE id=$1`, [Number(row.id)]);
        console.log(`⚠️ Phase 2B: merged duplicate access profile #${row.id} into #${canonicalId}`);
    }

    await pool.query(`ALTER TABLE access_profiles ALTER COLUMN business_id SET NOT NULL`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_access_profiles_business_name ON access_profiles(business_id,name)`);

    // Clone the canonical built-in profiles to every business now that the
    // composite uniqueness exists. This also makes ON CONFLICT deterministic.
    const businesses = (await runSystemContext(() => pool.query(`SELECT id FROM businesses ORDER BY id`))).rows.map(r => Number(r.id));
    const sourceProfiles = (await runSystemContext(() => pool.query(`SELECT id,name,description,permissions FROM access_profiles WHERE business_id=$1 ORDER BY id`, [systemBusinessId]))).rows;

    for (const businessId of businesses) {
        if (businessId === Number(systemBusinessId)) continue;
        for (const profile of sourceProfiles) {
            await runSystemContext(() => pool.query(`
                INSERT INTO access_profiles(name,business_id,description,permissions)
                VALUES($1,$2,$3,$4::jsonb)
                ON CONFLICT (business_id,name) DO NOTHING
            `, [profile.name,businessId,profile.description,JSON.stringify(profile.permissions || {})]));
        }
        for (const profile of sourceProfiles) {
            const target = await runSystemContext(() => pool.query(`SELECT id FROM access_profiles WHERE business_id=$1 AND name=$2 LIMIT 1`, [businessId, profile.name]));
            if (target.rows[0]) {
                await runSystemContext(() => pool.query(`UPDATE app_users SET profile_id=$1 WHERE business_id=$2 AND profile_id=$3`, [target.rows[0].id,businessId,profile.id]));
            }
        }
    }

    await seedAllBusinessAccessProfiles();

    await enableTenantRls('app_users');
    await enableTenantRls('access_profiles');
    console.log('✅ Phase 2B user/profile tenant isolation ready');
}

function normaliseRegistrationKey(raw) {
    return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashRegistrationKey(raw) {
    return crypto.createHash('sha256').update(normaliseRegistrationKey(raw)).digest('hex');
}

function generateRegistrationKey() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(16);
    let raw = '';
    for (const byte of bytes) raw += alphabet[byte % alphabet.length];
    return `${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}`;
}

async function ensureTrialLicense(businessId) {
    const id = Number(businessId);
    const existing = await runSystemContext(() => pool.query(`SELECT * FROM business_licenses WHERE business_id=$1 ORDER BY id DESC LIMIT 1`, [id]));
    if (existing.rows[0]) return existing.rows[0];

    const maxDevices = Math.max(1, Number(process.env.AUTO_TRIAL_MAX_DEVICES || 1));
    const r = await runSystemContext(() => pool.query(`
        INSERT INTO business_licenses(business_id,plan,license_type,duration_months,status,starts_at,expires_at,max_devices,notes)
        VALUES($1,'Trial','Trial',1,'active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + INTERVAL '1 month',$2,'Automatically created trial license')
        RETURNING *
    `, [id, maxDevices]));
    return r.rows[0];
}

async function createDeviceRegistrationKey(businessId, options = {}) {
    const id = Number(businessId);
    const license = options.license || await ensureTrialLicense(id);
    if (!license || license.status !== 'active' || new Date(license.expires_at).getTime() < Date.now()) {
        throw new Error('An active license is required to generate a device registration key');
    }

    const activeDeviceCount = await runSystemContext(() => pool.query(`SELECT COUNT(*)::int AS count FROM registered_devices WHERE business_id=$1 AND status='active'`, [id]));
    if (Number(activeDeviceCount.rows[0].count) >= Number(license.max_devices)) {
        throw new Error(`Device limit reached (${license.max_devices})`);
    }

    let rawKey, keyHash;
    for (let i = 0; i < 5; i++) {
        rawKey = generateRegistrationKey();
        keyHash = hashRegistrationKey(rawKey);
        const exists = await runSystemContext(() => pool.query(`SELECT 1 FROM device_registration_keys WHERE key_hash=$1 LIMIT 1`, [keyHash]));
        if (!exists.rows.length) break;
    }

    const expiresAt = options.expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000);
    const r = await runSystemContext(() => pool.query(`
        INSERT INTO device_registration_keys(
            business_id,license_id,key_hash,key_hint,device_name,status,created_by_type,created_by_user_id,expires_at
        ) VALUES($1,$2,$3,$4,$5,'unused',$6,$7,$8)
        RETURNING id,business_id,license_id,key_hint,device_name,status,expires_at,created_at
    `, [
        id, license.id, keyHash,
        `${rawKey.slice(0,4)}…${rawKey.slice(-4)}`,
        String(options.deviceName || 'POS Device').trim() || 'POS Device',
        String(options.createdByType || 'admin'),
        options.createdByUserId ? Number(options.createdByUserId) : null,
        expiresAt
    ]));
    return { ...r.rows[0], rawKey };
}

async function registerDeviceFromKey(req, res) {
    try {
        const rawKey = String(req.body.registrationKey || '').trim();
        const deviceName = String(req.body.deviceName || 'POS Device').trim() || 'POS Device';
        const deviceType = String(req.body.deviceType || 'Web').trim() || 'Web';
        if (!rawKey) return res.status(400).json({ error: 'Registration key is required' });

        let deviceId = getCookie(req, 'cafe_device_id');
        if (!deviceId) deviceId = crypto.randomBytes(32).toString('hex');

        return await runSystemContext(async () => {
            const keyHash = hashRegistrationKey(rawKey);
            const result = await pool.query(`
                SELECT k.*, l.status AS license_status, l.starts_at, l.expires_at, l.max_devices, b.business_name, b.business_code, b.active AS business_active
                FROM device_registration_keys k
                JOIN business_licenses l ON l.id=k.license_id
                JOIN businesses b ON b.id=k.business_id
                WHERE k.key_hash=$1
                LIMIT 1
            `, [keyHash]);
            const key = result.rows[0];
            if (!key) return res.status(404).json({ error: 'Invalid registration key' });
            if (key.status !== 'unused') return res.status(409).json({ error: 'This registration key has already been used or revoked' });
            if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
                await pool.query(`UPDATE device_registration_keys SET status='expired' WHERE id=$1`, [key.id]);
                return res.status(410).json({ error: 'This registration key has expired' });
            }
            if (!key.business_active) return res.status(403).json({ error: 'Business account is inactive' });
            if (key.license_status !== 'active' || new Date(key.expires_at).getTime() < Date.now()) {
                return res.status(403).json({ error: 'Business license is not active' });
            }

            const existing = await pool.query(`SELECT * FROM registered_devices WHERE device_id=$1 LIMIT 1`, [deviceId]);
            const count = await pool.query(`SELECT COUNT(*)::int AS count FROM registered_devices WHERE business_id=$1 AND status='active'`, [key.business_id]);
            const activeCount = Number(count.rows[0].count);

            if (existing.rows[0] && existing.rows[0].status === 'active') {
                return res.status(409).json({ error: 'This device is already registered to a business.' });
            }
            if (activeCount >= Number(key.max_devices)) {
                return res.status(409).json({ error: `Device limit reached (${key.max_devices})` });
            }

            let inserted;
            if (existing.rows[0]) {
                inserted = await pool.query(`
                    UPDATE registered_devices
                    SET business_id=$1,license_id=$2,device_name=$3,device_type=$4,status='active',registration_key_id=$5,
                        registered_at=CURRENT_TIMESTAMP,last_seen_at=CURRENT_TIMESTAMP,last_ip=$6,user_agent=$7,revoked_at=NULL,updated_at=CURRENT_TIMESTAMP
                    WHERE id=$8
                    RETURNING id,business_id,license_id,device_id,device_name,device_type,status,registered_at,last_seen_at
                `, [
                    key.business_id, key.license_id, deviceName, deviceType, key.id,
                    String(req.ip || ''), String(req.headers['user-agent'] || ''), existing.rows[0].id
                ]);
            } else {
                inserted = await pool.query(`
                    INSERT INTO registered_devices(
                        business_id,license_id,device_id,device_name,device_type,status,registration_key_id,last_ip,user_agent
                    ) VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8)
                    RETURNING id,business_id,license_id,device_id,device_name,device_type,status,registered_at,last_seen_at
                `, [
                    key.business_id, key.license_id, deviceId, deviceName, deviceType, key.id,
                    String(req.ip || ''), String(req.headers['user-agent'] || '')
                ]);
            }

            await pool.query(`UPDATE device_registration_keys SET status='used',used_at=CURRENT_TIMESTAMP,used_device_id=$1 WHERE id=$2`, [inserted.rows[0].id, key.id]);

            setCookie(res, 'cafe_device_id', deviceId, { maxAge: 60 * 60 * 24 * 365, httpOnly: true, sameSite: 'None', secure: true });
            return res.json({
                success: true,
                business: { id:key.business_id, business_code:key.business_code, business_name:key.business_name },
                device: inserted.rows[0]
            });
        });
    } catch (e) {
        console.error('Device registration error:', e);
        return res.status(500).json({ error: 'Device registration failed' });
    }
}

// Public device registration — no user login required.
app.post('/api/public/device/register', registerDeviceFromKey);

// Support authentication and dashboard APIs live before the normal /api auth gate.
const SUPPORT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

async function createSupportSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + SUPPORT_SESSION_TTL_MS);
    await pool.query(`INSERT INTO support_sessions(token,token_hash,support_user_id,expires_at) VALUES($1,$1,$2,$3)`, [tokenHash,userId,expiresAt]);
    return { token, expiresAt: expiresAt.getTime() };
}

async function getSupportSession(req) {
    let token = String(req.headers.authorization || '').startsWith('Bearer ')
        ? String(req.headers.authorization || '').slice(7).trim()
        : '';
    if (!token) token = getCookie(req, 'cafe_support_session') || '';
    if (!token) return null;
    const tokenHash = hashSessionToken(token);
    const r = await pool.query(`SELECT s.token_hash AS token,s.support_user_id,s.expires_at,u.username,u.display_name FROM support_sessions s JOIN support_users u ON u.id=s.support_user_id WHERE s.token_hash=$1 LIMIT 1`, [tokenHash]);
    const row = r.rows[0];
    if (!row) return null;
    const expiresAt = new Date(row.expires_at).getTime();
    if (expiresAt < Date.now()) {
        await pool.query(`DELETE FROM support_sessions WHERE token_hash=$1`, [tokenHash]);
        return null;
    }
    return row;
}

async function supportAuth(req, res, next) {
    try {
        const session = await getSupportSession(req);
        if (!session) return res.status(401).json({ error: 'Support authentication required' });
        req.supportUser = session;
        next();
    } catch (e) {
        res.status(500).json({ error: 'Support authentication error' });
    }
}

app.post('/api/support/login', async (req,res)=>{
    try {
        const username=String(req.body.username||'').trim().toLowerCase();
        const password=String(req.body.password||'');
        if(!username||!password) return res.status(400).json({error:'Support username and password are required'});
        if(password.length>1024) return res.status(400).json({error:'Password must be 1024 characters or fewer'});
        const identityKey=loginIdentityKey('support',0,username);
        const existingLockout=await getLoginLockout(identityKey);
        if(existingLockout){res.setHeader('Retry-After',String(Math.max(1,Math.ceil((existingLockout-Date.now())/1000))));return res.status(429).json({error:'Too many failed sign-in attempts. Try again later.'});}
        const r=await pool.query(`SELECT id,username,display_name,password_hash,active FROM support_users WHERE LOWER(username)=$1 LIMIT 1`,[username]);
        const user=r.rows[0];
        const passwordValid=user?.active?await verifyPassword(password,user.password_hash):false;
        if(!passwordValid){const lockedUntil=await recordFailedLogin(identityKey);if(lockedUntil){res.setHeader('Retry-After',String(Math.max(1,Math.ceil((lockedUntil-Date.now())/1000))));return res.status(429).json({error:'Too many failed sign-in attempts. Try again later.'});}return res.status(401).json({error:'Invalid support credentials'});}
        await clearLoginFailures(identityKey);
        const session=await createSupportSession(user.id);
        setCookie(res,'cafe_support_session',session.token,{maxAge:Math.floor(SUPPORT_SESSION_TTL_MS/1000),httpOnly:true,sameSite:'Lax',secure:true});
        res.json({success:true,user:{id:user.id,username:user.username,displayName:user.display_name},expiresAt:session.expiresAt});
    }catch(e){console.error('Support login error:',e);res.status(500).json({error:'Support login failed'});}
});

app.post('/api/support/logout', supportAuth, async(req,res)=>{
    try { await pool.query(`DELETE FROM support_sessions WHERE token_hash=$1`,[req.supportUser.token]); clearCookie(res,'cafe_support_session'); res.json({success:true}); }
    catch(e){res.status(500).json({error:'Support logout failed'});}
});

app.get('/api/support/me', supportAuth, async(req,res)=>res.json({user:{id:req.supportUser.support_user_id,username:req.supportUser.username,displayName:req.supportUser.display_name},expiresAt:new Date(req.supportUser.expires_at).getTime()}));

app.get('/api/support/businesses', supportAuth, async(req,res)=>{
    try {
        const r = await runSystemContext(() => pool.query(`
            SELECT b.id,b.id::text AS account_number,b.business_code,b.business_name,b.business_name AS business_brand_name,
                   b.id::text AS branch_id,b.business_code AS branch_code,b.business_name AS branch_name,
                   CONCAT_WS(', ',NULLIF(b.address,''),NULLIF(b.city,''),NULLIF(b.state,'')) AS address_line,
                   CASE WHEN b.active THEN 'Active' ELSE 'Inactive' END AS business_status,
                   CASE WHEN b.active THEN 'Active' ELSE 'Inactive' END AS branch_status,
                   b.business_type,b.owner_name,b.phone,b.email,b.address,b.city,b.state,b.active,b.created_at,
                   l.id AS license_id,l.plan,l.license_type,l.add_on,l.duration_months,l.status AS license_status,l.starts_at,l.expires_at,l.max_devices,
                   (SELECT COUNT(*)::int FROM registered_devices d WHERE d.business_id=b.id AND d.status='active') AS active_devices,
                   (SELECT COUNT(*)::int FROM app_users u WHERE u.business_id=b.id AND u.active=TRUE) AS active_users,
                   COALESCE(brand.show_powered_by_cafe_pilot,TRUE) AS show_powered_by_cafe_pilot
            FROM businesses b
            LEFT JOIN LATERAL (
                SELECT * FROM business_licenses bl WHERE bl.business_id=b.id ORDER BY bl.id DESC LIMIT 1
            ) l ON TRUE
            LEFT JOIN support_business_branding brand ON brand.business_id=b.id
            ORDER BY b.id DESC
        `));
        res.json(r.rows);
    } catch(e){console.error(e);res.status(500).json({error:'Failed to load businesses'});}
});

app.patch('/api/support/businesses/:id', supportAuth, async(req,res)=>{
    try {
        const businessId=Number(req.params.id);
        const businessName=String(req.body.businessName||'').trim();
        if(!Number.isInteger(businessId)||businessId<=0)return res.status(400).json({error:'Invalid business ID'});
        if(!businessName)return res.status(400).json({error:'Business name is required'});
        if(businessName.length>200)return res.status(400).json({error:'Business name must be 200 characters or fewer'});
        const result=await runSystemContext(()=>pool.query(
            `UPDATE businesses SET business_name=$1 WHERE id=$2 RETURNING id,business_name`,
            [businessName,businessId]
        ));
        if(!result.rows.length)return res.status(404).json({error:'Business not found'});
        res.json({success:true,business:result.rows[0]});
    } catch(e){console.error(e);res.status(500).json({error:'Failed to update business name'});}
});

app.patch('/api/support/businesses/:id/branding', supportAuth, async(req,res)=>{
    try {
        const businessId=Number(req.params.id);
        const show=req.body?.showPoweredByCafePilot;
        if(!Number.isInteger(businessId)||businessId<=0)return res.status(400).json({error:'Invalid business ID'});
        if(typeof show!=='boolean')return res.status(400).json({error:'Choose whether Slash branding should be shown.'});
        const result=await runSystemContext(()=>pool.query(
            "INSERT INTO support_business_branding(business_id,show_powered_by_cafe_pilot,updated_at) SELECT id,$2,CURRENT_TIMESTAMP FROM businesses WHERE id=$1 ON CONFLICT (business_id) DO UPDATE SET show_powered_by_cafe_pilot=EXCLUDED.show_powered_by_cafe_pilot,updated_at=CURRENT_TIMESTAMP RETURNING show_powered_by_cafe_pilot",
            [businessId,show]
        ));
        if(!result.rows.length)return res.status(404).json({error:'Business not found'});
        res.json({success:true,showPoweredByCafePilot:result.rows[0].show_powered_by_cafe_pilot});
    } catch(e){console.error(e);res.status(500).json({error:'Failed to update invoice footer branding'});}
});

app.get('/api/support/businesses/:id/users', supportAuth, async(req,res)=>{
    try {
        const businessId=Number(req.params.id);
        if(!Number.isInteger(businessId)||businessId<=0)return res.status(400).json({error:'Invalid business ID'});
        const result=await runSystemContext(async()=>{
            const users=await pool.query(`
                SELECT u.id,u.display_name,u.username,u.profile_id,u.active,u.created_at,
                       p.name AS profile_name,
                       u.permissions_override,
                       COALESCE(u.permissions_override,p.permissions,'{}'::jsonb) AS permissions
                FROM app_users u
                LEFT JOIN access_profiles p ON p.id=u.profile_id AND p.business_id=u.business_id
                WHERE u.business_id=$1
                ORDER BY u.id
            `,[businessId]);
            const profiles=await pool.query(`
                SELECT id,name,description,permissions
                FROM access_profiles
                WHERE business_id=$1
                ORDER BY name
            `,[businessId]);
            return {users:users.rows,profiles:profiles.rows};
        });
        res.json(result);
    }catch(e){console.error('Support user list error:',e);res.status(500).json({error:'Failed to load business users'});}
});

app.post('/api/support/businesses/:id/users', supportAuth, async(req,res)=>{
    try {
        const businessId=Number(req.params.id);
        const displayName=String(req.body.displayName||'').trim();
        const username=String(req.body.username||'').trim().toLowerCase();
        const password=String(req.body.password||'');
        const profileId=req.body.profileId===null||req.body.profileId===undefined||req.body.profileId===''?null:Number(req.body.profileId);
        const active=req.body.active!==false;
        if(!Number.isInteger(businessId)||businessId<=0)return res.status(400).json({error:'Invalid business ID'});
        if(!displayName||!username)return res.status(400).json({error:'Display name and username are required'});
        if(!/^[a-z0-9._-]{3,100}$/.test(username))return res.status(400).json({error:'Username may contain only letters, numbers, dot, underscore and hyphen'});
        if(password.length<6)return res.status(400).json({error:'Password must be at least 6 characters'});
        const user=await runSystemContext(async()=>{
            let assignedProfileName=null;
            if(profileId!==null){
                const profile=(await pool.query('SELECT id,name FROM access_profiles WHERE id=$1 AND business_id=$2',[profileId,businessId])).rows[0];
                if(!profile)return null;
                assignedProfileName=profile.name;
            }
            let permissionsOverride=null;
            if(req.body.permissionsOverride!==undefined&&req.body.permissionsOverride!==null){
                if(typeof req.body.permissionsOverride!=='object'||Array.isArray(req.body.permissionsOverride))throw Object.assign(new Error('Custom permissions must be an object'),{status:400});
                const allowed=new Set(ACCESS_MODULES_SERVER.flatMap(moduleKey=>ACCESS_ACTIONS_SERVER.map(action=>moduleKey+'.'+action)).concat(ACCESS_ORDER_PERMISSIONS_SERVER));
                permissionsOverride={};
                for(const key of allowed)permissionsOverride[key]=req.body.permissionsOverride[key]===true;
            }
            if(assignedProfileName==='Admin'&&permissionsOverride&&(!permissionsOverride['dashboard.view']||!permissionsOverride['access.view']||!permissionsOverride['access.edit']))throw Object.assign(new Error('Admin custom permissions must keep Dashboard and Access management available'),{status:400});
            const result=await pool.query(`
                INSERT INTO app_users(display_name,username,password_hash,profile_id,business_id,active,permissions_override)
                VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
                RETURNING id,display_name,username,profile_id,business_id,active,created_at,updated_at
            `,[displayName,username,await hashPassword(password),profileId,businessId,active,permissionsOverride===null?null:JSON.stringify(permissionsOverride)]);
            return result.rows[0];
        });
        if(!user)return res.status(400).json({error:'Permission profile must belong to the selected business'});
        res.status(201).json({success:true,user});
    }catch(e){
        if(e.code==='23505')return res.status(409).json({error:'A user with this username already exists in this business'});
        res.status(e.status||500).json({error:e.message||'Failed to add business user'});
    }
});

app.patch('/api/support/businesses/:businessId/users/:userId', supportAuth, async(req,res)=>{
    try {
        const businessId=Number(req.params.businessId),userId=Number(req.params.userId);
        if(!Number.isInteger(businessId)||businessId<=0||!Number.isInteger(userId)||userId<=0)return res.status(400).json({error:'Invalid business or user ID'});
        const result=await runSystemContext(async()=>{
            const current=(await pool.query(`
                SELECT u.*,p.name AS profile_name
                FROM app_users u
                LEFT JOIN access_profiles p ON p.id=u.profile_id AND p.business_id=u.business_id
                WHERE u.id=$1 AND u.business_id=$2
            `,[userId,businessId])).rows[0];
            if(!current)return null;

            const displayName=req.body.displayName===undefined?current.display_name:String(req.body.displayName).trim();
            const username=req.body.username===undefined?current.username:String(req.body.username).trim().toLowerCase();
            const profileId=req.body.profileId===undefined?current.profile_id:(req.body.profileId===null||req.body.profileId===''?null:Number(req.body.profileId));
            let assignedProfileName=current.profile_name;
            const active=req.body.active===undefined?current.active:Boolean(req.body.active);
            const password=String(req.body.password||'');
            if(!displayName||!username)throw Object.assign(new Error('Display name and username are required'),{status:400});
            if(!/^[a-z0-9._-]{3,100}$/.test(username))throw Object.assign(new Error('Username may contain only letters, numbers, dot, underscore and hyphen'),{status:400});
            if(password&&password.length<6)throw Object.assign(new Error('Password must be at least 6 characters'),{status:400});
            if(profileId!==null){
                if(!Number.isInteger(profileId))throw Object.assign(new Error('Invalid permission profile'),{status:400});
                const profile=(await pool.query('SELECT id,name FROM access_profiles WHERE id=$1 AND business_id=$2',[profileId,businessId])).rows[0];
                if(!profile)throw Object.assign(new Error('Permission profile must belong to the selected business'),{status:400});
                assignedProfileName=profile.name;
            }

            let permissionsOverride=current.permissions_override;
            if(req.body.permissionsOverride!==undefined){
                if(req.body.permissionsOverride===null)permissionsOverride=null;
                else if(!req.body.permissionsOverride||typeof req.body.permissionsOverride!=='object'||Array.isArray(req.body.permissionsOverride)){
                    throw Object.assign(new Error('Custom permissions must be an object'),{status:400});
                }else{
                    const allowed=new Set(ACCESS_MODULES_SERVER.flatMap(moduleKey=>ACCESS_ACTIONS_SERVER.map(action=>moduleKey+'.'+action)).concat(ACCESS_ORDER_PERMISSIONS_SERVER));
                    permissionsOverride={};
                    for(const key of allowed)permissionsOverride[key]=req.body.permissionsOverride[key]===true;
                }
            }
            if(assignedProfileName==='Admin'&&permissionsOverride&&(!permissionsOverride['dashboard.view']||!permissionsOverride['access.view']||!permissionsOverride['access.edit']))throw Object.assign(new Error('Admin custom permissions must keep Dashboard and Access management available'),{status:400});

            if(current.is_owner&&(!active||profileId!==current.profile_id))throw Object.assign(new Error('The business owner account must remain active and assigned to its current access profile'),{status:400});

            const updated=(await pool.query(`
                UPDATE app_users
                SET display_name=$1,username=$2,profile_id=$3,active=$4,
                    password_hash=CASE WHEN $5::text IS NULL THEN password_hash ELSE $5 END,
                    permissions_override=$6::jsonb,updated_at=CURRENT_TIMESTAMP
                WHERE id=$7 AND business_id=$8
                RETURNING id,display_name,username,profile_id,business_id,active,created_at,updated_at
            `,[displayName,username,profileId,active,password?await hashPassword(password):null,permissionsOverride===null?null:JSON.stringify(permissionsOverride),userId,businessId])).rows[0];
            if(password||!active)await pool.query('DELETE FROM app_sessions WHERE user_id=$1 AND business_id=$2',[userId,businessId]);
            return updated;
        });
        if(!result)return res.status(404).json({error:'User not found in this business'});
        res.json({success:true,user:result});
    }catch(e){
        if(e.code==='23505')return res.status(409).json({error:'A user with this username already exists in this business'});
        res.status(e.status||500).json({error:e.message||'Failed to update business user'});
    }
});

app.post('/api/support/businesses/:id/licenses', supportAuth, async(req,res)=>{
    try {
        const businessId=Number(req.params.id);
        if(!Number.isInteger(businessId)||businessId<=0)return res.status(400).json({error:'Invalid business ID'});
        const rawType=req.body.licenseType===undefined?req.body.plan:req.body.licenseType;
        const {licenseType,addOn}=normalizeSupportLicenseSelection(rawType,req.body.addOn);
        const {durationMonths}=normalizeSupportLicenseTerm(licenseType,req.body.durationMonths,'Sales');
        const status=String(req.body.status||'active');
        if(!['active','suspended','revoked','expired'].includes(status))return res.status(400).json({error:'Invalid license status'});
        const startsAt=req.body.startsAt?new Date(req.body.startsAt):new Date();
        const legacyExpiry=req.body.licenseType===undefined&&req.body.durationMonths===undefined&&req.body.expiresAt!==undefined;
        const expiresAt=legacyExpiry?new Date(req.body.expiresAt):addUtcMonthsClamped(startsAt,durationMonths);
        const maxDevices=Number(req.body.maxDevices||1);
        if(!Number.isInteger(maxDevices)||maxDevices<1)return res.status(400).json({error:'Max devices must be a positive whole number'});
        if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || expiresAt<=startsAt) return res.status(400).json({error:'Invalid license dates'});
        const result=await runSystemContext(async()=>{
            await pool.query(`UPDATE business_licenses SET status='revoked',revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE business_id=$1 AND status='active'`,[businessId]);
            return pool.query(`INSERT INTO business_licenses(business_id,plan,license_type,add_on,duration_months,status,starts_at,expires_at,max_devices,notes,created_by_support_user_id) VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[businessId,licenseType,addOn,durationMonths,status,startsAt,expiresAt,maxDevices,String(req.body.notes||'').trim()||null,Number(req.supportUser.support_user_id)]);
        });
        res.status(201).json({success:true,license:result.rows[0]});
    }catch(e){res.status(e.status||500).json({error:e.message||'Failed to issue license'});}
});

app.patch('/api/support/licenses/:id', supportAuth, async(req,res)=>{
    try {
        const id=Number(req.params.id);
        const current=(await runSystemContext(()=>pool.query(`SELECT * FROM business_licenses WHERE id=$1`,[id]))).rows[0];
        if(!current)return res.status(404).json({error:'License not found'});
        const status=req.body.status===undefined?current.status:String(req.body.status);
        const rawType=req.body.licenseType===undefined
            ? (req.body.plan===undefined?(current.license_type||current.plan):req.body.plan)
            : req.body.licenseType;
        const {licenseType,addOn}=normalizeSupportLicenseSelection(rawType,req.body.addOn,current.license_type||current.plan||'Sales',current.add_on);
        const {durationMonths}=normalizeSupportLicenseTerm(licenseType,req.body.durationMonths,licenseType,current.duration_months);
        const maxDevices=req.body.maxDevices===undefined?current.max_devices:Number(req.body.maxDevices);
        const startsAt=req.body.startsAt===undefined?current.starts_at:new Date(req.body.startsAt);
        const legacyExpiry=req.body.licenseType===undefined&&req.body.durationMonths===undefined&&req.body.expiresAt!==undefined;
        const termChanged=req.body.licenseType!==undefined||req.body.durationMonths!==undefined||req.body.plan!==undefined||req.body.startsAt!==undefined;
        const expiresAt=legacyExpiry?new Date(req.body.expiresAt):(termChanged?addUtcMonthsClamped(new Date(startsAt),durationMonths):current.expires_at);
        if(!['active','suspended','revoked','expired'].includes(status))return res.status(400).json({error:'Invalid license status'});
        if(!Number.isInteger(maxDevices)||maxDevices<1)return res.status(400).json({error:'Max devices must be a positive whole number'});
        if(!Number.isFinite(new Date(startsAt).getTime())||!Number.isFinite(new Date(expiresAt).getTime())||new Date(expiresAt)<=new Date(startsAt))return res.status(400).json({error:'Expiry must be after start date'});
        const r=await runSystemContext(()=>pool.query(`UPDATE business_licenses SET plan=$1,license_type=$1,add_on=$2,duration_months=$3,status=$4,starts_at=$5,expires_at=$6,max_devices=$7,notes=$8,updated_at=CURRENT_TIMESTAMP,revoked_at=CASE WHEN $4='revoked' THEN COALESCE(revoked_at,CURRENT_TIMESTAMP) ELSE NULL END WHERE id=$9 RETURNING *`,[licenseType,addOn,durationMonths,status,startsAt,expiresAt,maxDevices,req.body.notes===undefined?current.notes:(String(req.body.notes||'').trim()||null),id]));
        res.json({success:true,license:r.rows[0]});
    }catch(e){res.status(e.status||500).json({error:e.message||'Failed to update license'});}
});

app.get('/api/support/businesses/:id/devices', supportAuth, async(req,res)=>{
    try {
        const r=await runSystemContext(()=>pool.query(`SELECT d.id,d.business_id,d.device_id,d.device_name,d.device_type,d.status,d.registered_at,d.last_seen_at,d.last_ip,d.user_agent,l.plan,l.status AS license_status,l.expires_at FROM registered_devices d LEFT JOIN business_licenses l ON l.id=d.license_id WHERE d.business_id=$1 ORDER BY d.id DESC`,[Number(req.params.id)]));
        res.json(r.rows);
    }catch(e){res.status(500).json({error:'Failed to load devices'});}
});

app.post('/api/support/businesses/:id/registration-keys', supportAuth, async(req,res)=>{
    try {
        const businessId=Number(req.params.id);
        const key=await createDeviceRegistrationKey(businessId,{deviceName:String(req.body.deviceName||'POS Device').trim()||'POS Device',createdByType:'support',createdByUserId:req.supportUser.support_user_id,expiresAt:req.body.expiresAt?new Date(req.body.expiresAt):new Date(Date.now()+24*60*60*1000)});
        res.status(201).json({success:true,registrationKey:key});
    }catch(e){res.status(400).json({error:e.message||'Failed to generate registration key'});}
});

app.post('/api/support/devices/:id/revoke', supportAuth, async(req,res)=>{
    try {
        const id=Number(req.params.id);
        const r=await runSystemContext(()=>pool.query(`UPDATE registered_devices SET status='revoked',revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING id,business_id,device_name,status,revoked_at`,[id]));
        if(!r.rows.length)return res.status(404).json({error:'Device not found'});
        res.json({success:true,device:r.rows[0]});
    }catch(e){res.status(500).json({error:'Failed to revoke device'});}
});

app.post('/api/support/registration-keys/:id/revoke', supportAuth, async(req,res)=>{
    try {
        const id=Number(req.params.id);
        const r=await runSystemContext(()=>pool.query(`UPDATE device_registration_keys SET status='revoked' WHERE id=$1 AND status='unused' RETURNING id,business_id,key_hint,status`,[id]));
        if(!r.rows.length)return res.status(404).json({error:'Unused registration key not found'});
        res.json({success:true,key:r.rows[0]});
    }catch(e){res.status(500).json({error:'Failed to revoke registration key'});}
});

// =====================================================
// BUSINESS ADMIN DEVICE APIs
// =====================================================
app.get('/api/devices', async(req,res)=>{
    try {
        const businessId=Number(req.user.business_id);
        const [devices,license]=await Promise.all([
            pool.query(`SELECT id,device_name,device_type,status,registered_at,last_seen_at,last_ip FROM registered_devices WHERE business_id=$1 ORDER BY id DESC`,[businessId]),
            getEffectiveLicense(businessId)
        ]);
        res.json({businessId,devices:devices.rows,license});
    }catch(e){res.status(500).json({error:'Failed to load device information'});}
});

app.post('/api/devices/registration-keys', async(req,res)=>{
    try {
        const key=await createDeviceRegistrationKey(Number(req.user.business_id),{deviceName:String(req.body.deviceName||'POS Device').trim()||'POS Device',createdByType:'admin',createdByUserId:req.user.id,expiresAt:req.body.expiresAt?new Date(req.body.expiresAt):new Date(Date.now()+24*60*60*1000)});
        res.status(201).json({success:true,registrationKey:key});
    }catch(e){res.status(400).json({error:e.message||'Failed to generate registration key'});}
});

app.post('/api/devices/:id/revoke', async(req,res)=>{
    try {
        const id=Number(req.params.id);
        const businessId=Number(req.user.business_id);
        const r=await pool.query(`UPDATE registered_devices SET status='revoked',revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND business_id=$2 RETURNING id,device_name,status,revoked_at`,[id,businessId]);
        if(!r.rows.length)return res.status(404).json({error:'Device not found'});
        res.json({success:true,device:r.rows[0]});
    }catch(e){res.status(500).json({error:'Failed to revoke device'});}
});

app.get('/api/license/status', async(req,res)=>{
    try { const license=await getEffectiveLicense(Number(req.user.business_id)); const count=await pool.query(`SELECT COUNT(*)::int AS count FROM registered_devices WHERE business_id=$1 AND status='active'`,[Number(req.user.business_id)]); res.json({license,activeDevices:Number(count.rows[0].count)}); }
    catch(e){res.status(500).json({error:'Failed to read license status'});}
});

// =====================================================
// PERFORMANCE INDEXES
// =====================================================
async function ensurePerformanceIndexes() {
    const statements = [
        `CREATE INDEX IF NOT EXISTS idx_orders_business_created_at ON orders(business_id, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_orders_cancelled_report ON orders(business_id,cancelled_at DESC) WHERE status='Cancelled'`,
        `CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)`,
        "CREATE INDEX IF NOT EXISTS idx_payments_order_business_status ON payments(order_id,business_id,payment_status)",
        `CREATE INDEX IF NOT EXISTS idx_customers_business_created_at ON customers(business_id, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_reservations_business_created_at ON reservations(business_id, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_kot_business_created_at ON kot(business_id, created_at DESC)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_kot_order_item_unique ON kot(business_id,order_item_id) WHERE order_item_id IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_payments_business_created_at ON payments(business_id, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_menu_business_available ON menu(business_id, available)`,
        `CREATE INDEX IF NOT EXISTS idx_menu_categories_business_active ON menu_categories(business_id, active)`,
        `CREATE INDEX IF NOT EXISTS idx_app_sessions_user_business ON app_sessions(user_id, business_id)`,
        `CREATE INDEX IF NOT EXISTS idx_registered_devices_business_status ON registered_devices(business_id, status)`,
        `CREATE INDEX IF NOT EXISTS idx_business_licenses_business_status ON business_licenses(business_id, status)`
    ];
    for (const sql of statements) {
        try { await runSystemContext(() => pool.query(sql)); }
        catch (error) { console.warn('⚠️ Performance index skipped:', error.message); }
    }
}

// =====================================================
// START SERVER / DATABASE MIGRATIONS
// =====================================================
async function assertSafeRlsDatabaseRole() {
    const result = await rawPoolQuery("SELECT current_user AS role_name, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user LIMIT 1");
    const role = result.rows[0];
    if (!role || role.rolsuper || role.rolbypassrls) {
        throw new Error('The application database role must not have SUPERUSER or BYPASSRLS privileges; use a restricted runtime role.');
    }
}

async function verifyTenantRlsPolicies() {
    const ownerColumn = await rawPoolQuery(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='app_users' AND column_name='is_owner'
        LIMIT 1
    `);
    if (!ownerColumn.rows.length) throw new Error('The is_owner security migration is missing; run the database migration before serving requests.');
    const requiredTables = [...TENANT_TABLES_PHASE_2A, 'businesses', 'app_users', 'access_profiles', 'business_licenses', 'registered_devices', 'device_registration_keys'];
    const result = await rawPoolQuery(
        `WITH required(relname) AS (SELECT unnest($1::text[]))
         SELECT r.relname
         FROM required r
         LEFT JOIN pg_class c ON c.relname=r.relname AND c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
         LEFT JOIN pg_policies p ON p.schemaname='public' AND p.tablename=r.relname AND p.policyname='tenant_isolation'
         WHERE c.oid IS NULL OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity
            OR p.policyname IS NULL OR p.qual IS NULL OR p.with_check IS NULL
            OR POSITION('app.business_id' IN p.qual)=0 OR POSITION('app.system_mode' IN p.qual)=0
            OR POSITION('app.business_id' IN p.with_check)=0 OR POSITION('app.system_mode' IN p.with_check)=0
         ORDER BY r.relname`,
        [requiredTables]
    );
    if (result.rows.length) {
        throw new Error('Tenant RLS is missing or not forced for: ' + result.rows.map(row => row.relname).join(', '));
    }
}
async function startServer() {

    try {

        // System context is allowed only while the one-off schema migration runs.
        tenantSystemMode = true;

        console.log('🚀 Phase 2A startup: initializing database');
        await assertSafeRlsDatabaseRole();
        console.log('✅ Application database role is not SUPERUSER/BYPASSRLS');
        await rawPoolQuery(`CREATE TABLE IF NOT EXISTS api_rate_limits (
            bucket_key VARCHAR(64) PRIMARY KEY,
            scope VARCHAR(80) NOT NULL,
            window_started_at TIMESTAMPTZ NOT NULL,
            hit_count INTEGER NOT NULL DEFAULT 0
        )`);
        await ensureLoginAttemptTable();
        console.log('1/7 ensureBusinessTable');
        await ensureBusinessTable();
        console.log('✅ ensureBusinessTable complete');
        const systemBusiness = await runSystemContext(() => pool.query(`SELECT id FROM businesses ORDER BY id LIMIT 1`));
        systemBusinessId = Number(systemBusiness.rows[0]?.id || 0) || null;
        if (!systemBusinessId) throw new Error("No business exists after business initialization");

        console.log('2/7 ensureInvoiceTables');
        await ensureInvoiceTables();
        console.log('✅ ensureInvoiceTables complete');
        console.log('3/7 ensureSettingsTable');
        await ensureSettingsTable();
        console.log('✅ ensureSettingsTable complete');
        console.log('4/7 ensureAccessTables');
        await ensureAccessTables();
        console.log('✅ ensureAccessTables complete');
        console.log('5/7 ensureBusinessTables');
        await ensureBusinessTables();
        console.log('✅ ensureBusinessTables complete');
        await ensurePrinterTable();
        console.log('6/10 ensureTenantIsolationPhase2A');
        await ensureTenantIsolationPhase2A();
        console.log('✅ ensureTenantIsolationPhase2A complete');
        console.log('7/10 ensurePhase2BAuthIsolation');
        await ensurePhase2BAuthIsolation();
        console.log('✅ ensurePhase2BAuthIsolation complete');
        await ensureBusinessOwnerFlags();
        console.log('✅ Business owner flags initialized');
        console.log('7b/10 ensurePerformanceIndexes');
        await ensurePerformanceIndexes();
        console.log('✅ ensurePerformanceIndexes complete');
        console.log('8/10 ensureLicenseTables');
        await ensureLicenseTables();
        console.log('✅ ensureLicenseTables complete');
        console.log('9/10 ensureSessionTable');
        await ensureSessionTable();
        console.log('✅ ensureSessionTable complete');
        await verifyTenantRlsPolicies();
        console.log('✅ Required tenant tables have forced RLS policies');

        tenantSystemMode = false;

       if (!process.env.VERCEL && process.env.MIGRATE_ONLY !== 'true') {
        app.listen(
            PORT,
            () =>
                console.log(
                    `🚀 Slash POS server running on http://localhost:${PORT}`
                )
        );
       } else if (process.env.MIGRATE_ONLY === 'true') {
        console.log('✅ Database migration-only run complete');
       }

    } catch (error) {

        console.error(
            "❌ Failed to initialize database:",
            error
        );

        process.exit(1);

    }

}

// Vercel production fast path: migrations are NOT part of request startup.
// Keep RUN_DB_MIGRATIONS=false/unset in normal production deployments.
// For a deliberate one-off migration, use MIGRATE_ONLY=true locally against
// the intended database instead of making every Vercel request wait.
const shouldRunStartupMigrations =
    !process.env.VERCEL || String(process.env.RUN_DB_MIGRATIONS || '').toLowerCase() === 'true';

const startupPromise = shouldRunStartupMigrations ? startServer() : Promise.resolve();
const runtimeRlsVerification = process.env.VERCEL && !shouldRunStartupMigrations
    ? assertSafeRlsDatabaseRole()
        .then(() => verifyTenantRlsPolicies())
        .then(async () => {
            try { await ensureLoginAttemptTable(); }
            catch (error) { persistentPublicRateLimitAvailable = false; persistentLoginLockoutAvailable = false; console.warn('Persistent rate limits or login lockout table unavailable; using process-local fallbacks:', error.message); }
            tenantSystemMode = false;
        })
    : Promise.resolve();

if (process.env.VERCEL) {
    if (shouldRunStartupMigrations) {
        console.warn('⚠️ RUN_DB_MIGRATIONS=true: Vercel requests will wait for migrations. Disable it after a one-off migration.');
    } else {
        console.log('⚡ Vercel production fast boot: database migrations skipped in request startup.');
    }

    module.exports = async function handler(req, res) {
        try {
            await startupPromise;
            await runtimeRlsVerification;
        } catch (error) {
            console.error('Runtime tenant security verification failed:', error.message);
            return res.status(503).json({ error: 'Database security configuration is incomplete. Apply the tenant migrations and use a role without BYPASSRLS.' });
        }
        return app(req, res);
    };
}
