import crypto from "node:crypto";
import { promisify } from "node:util";
import type { NextRequest } from "next/server";
import { db, withSystem, withTenant } from "@/src/server/db";

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

type Session = { token: string; userId: number; businessId: number; deviceId: string | null; expiresAt: number };

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function verifyPassword(password: string, stored: string | null) {
  if (!stored?.includes(":")) return false;
  const [salt, expected] = stored.split(":");
  try {
    const actual = Buffer.from((await scrypt(password, salt, 64)) as Buffer);
    const expectedBuffer = Buffer.from(expected, "hex");
    return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
  } catch {
    return false;
  }
}

function cookie(request: NextRequest, name: string) {
  return request.cookies.get(name)?.value || null;
}

export function clearSessionCookie(response: Response) {
  response.headers.append("Set-Cookie", "cafe_session=; Path=/; Max-Age=0; HttpOnly; SameSite=None; Secure");
}

function setSessionCookie(response: Response, token: string) {
  response.headers.append(
    "Set-Cookie",
    `cafe_session=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=None; Secure`,
  );
}

async function readSession(request: NextRequest): Promise<Session | null> {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : cookie(request, "cafe_session");
  if (!token) return null;
  const result = await db.query(
    "SELECT token, user_id, business_id, device_id, expires_at FROM app_sessions WHERE token_hash=$1 LIMIT 1",
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) return null;
  const expiresAt = new Date(row.expires_at).getTime();
  if (expiresAt <= Date.now()) {
    await db.query("DELETE FROM app_sessions WHERE token_hash=$1", [hashToken(token)]);
    return null;
  }
  return { token, userId: Number(row.user_id), businessId: Number(row.business_id), deviceId: row.device_id, expiresAt };
}

async function userForSession(session: Session) {
  return withTenant(session.businessId, async (client) => {
    const result = await client.query(`
      SELECT u.id,u.display_name,u.username,u.profile_id,u.business_id,u.active,u.permissions_override,u.is_owner,u.is_blocked,
             b.business_name,b.business_type,b.owner_name,b.phone AS business_phone,b.email AS business_email,
             b.address AS business_address,b.city,b.state,b.gstin,b.logo_url,b.currency,b.active AS business_active,
             p.name AS profile_name,COALESCE(u.permissions_override,p.permissions,'{}'::jsonb) AS permissions
      FROM app_users u
      LEFT JOIN businesses b ON b.id=u.business_id
      LEFT JOIN access_profiles p ON p.id=u.profile_id AND p.business_id=u.business_id
      WHERE u.id=$1 AND u.business_id=$2
    `, [session.userId, session.businessId]);
    const user = result.rows[0];
    return user && user.active && !user.is_blocked && user.business_active !== false ? user : null;
  });
}

async function deviceAndLicense(deviceId: string | null, businessId: number) {
  if (!deviceId) throw Object.assign(new Error("This device is not registered. Enter a registration key first."), { code: "DEVICE_NOT_REGISTERED" });
  return withSystem(async (client) => {
    const result = await client.query(`
      SELECT d.*, row_to_json(l) AS license_data
      FROM registered_devices d LEFT JOIN business_licenses l ON l.id=d.license_id
      WHERE d.device_id=$1 LIMIT 1
    `, [deviceId]);
    const device = result.rows[0];
    if (!device) throw Object.assign(new Error("This device is not registered. Enter a registration key first."), { code: "DEVICE_NOT_REGISTERED" });
    if (device.status !== "active") throw Object.assign(new Error("This device registration has been revoked."), { code: "DEVICE_REVOKED" });
    if (Number(device.business_id) !== businessId) throw Object.assign(new Error("This device belongs to a different business."), { code: "DEVICE_BUSINESS_MISMATCH" });
    const license = device.license_data;
    if (!license) throw Object.assign(new Error("No license is assigned to this business."), { code: "LICENSE_MISSING" });
    if (license.status !== "active") throw Object.assign(new Error(`Business license is ${license.status}.`), { code: "LICENSE_INACTIVE" });
    if (new Date(license.starts_at).getTime() > Date.now()) throw Object.assign(new Error("Business license has not started yet."), { code: "LICENSE_NOT_STARTED" });
    if (new Date(license.expires_at).getTime() < Date.now()) throw Object.assign(new Error("Business license has expired."), { code: "LICENSE_EXPIRED" });
    delete device.license_data;
    return { device, license };
  });
}

export async function login(request: NextRequest, response: Response) {
  const body = await request.json().catch(() => ({}));
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!username || !password) return Response.json({ error: "Username and password are required" }, { status: 400 });
  if (password.length > 1024) return Response.json({ error: "Password must be 1024 characters or fewer" }, { status: 400 });

  const deviceId = cookie(request, "cafe_device_id");
  const deviceBusiness = await withSystem(async (client) => {
    const result = await client.query("SELECT business_id FROM registered_devices WHERE device_id=$1 AND status='active' LIMIT 1", [deviceId]);
    return result.rows[0]?.business_id ? Number(result.rows[0].business_id) : 0;
  });
  if (!deviceBusiness) return Response.json({ error: "This device is not registered. Enter a registration key first.", code: "DEVICE_NOT_REGISTERED" }, { status: 403 });

  const result = await withTenant(deviceBusiness, (client) => client.query(`
    SELECT u.*,b.business_code,b.business_name,b.business_type,b.owner_name,b.phone AS business_phone,b.email AS business_email,
           b.address AS business_address,b.city,b.state,b.gstin,b.logo_url,b.currency,b.active AS business_active,
           p.name AS profile_name,COALESCE(u.permissions_override,p.permissions,'{}'::jsonb) AS permissions
    FROM app_users u LEFT JOIN businesses b ON b.id=u.business_id
    LEFT JOIN access_profiles p ON p.id=u.profile_id AND p.business_id=u.business_id
    WHERE LOWER(u.username)=$1 AND u.business_id=$2 LIMIT 1
  `, [username, deviceBusiness]));
  const user = result.rows[0];
  if (user?.is_blocked) return Response.json({ error: "This account is blocked. Ask an Admin or Manager to unblock it." }, { status: 423 });
  if (!user?.active || !(await verifyPassword(password, user.password_hash))) return Response.json({ error: "Invalid username or password" }, { status: 401 });
  const access = await deviceAndLicense(deviceId, deviceBusiness);
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await withTenant(deviceBusiness, (client) => client.query(`
    INSERT INTO app_sessions(token,token_hash,user_id,business_id,device_id,expires_at)
    VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(user_id) DO UPDATE SET token=EXCLUDED.token,token_hash=EXCLUDED.token_hash,business_id=EXCLUDED.business_id,device_id=EXCLUDED.device_id,expires_at=EXCLUDED.expires_at,created_at=CURRENT_TIMESTAMP
  `, [hashToken(token), hashToken(token), user.id, deviceBusiness, deviceId, expiresAt]));
  delete user.password_hash;
  setSessionCookie(response, token);
  return Response.json({ success: true, user, device: access.device, license: access.license, expiresAt: expiresAt.getTime() }, { headers: response.headers });
}

export async function sessionResponse(request: NextRequest) {
  const session = await readSession(request);
  if (!session) return { session: null, response: Response.json({ error: "Not logged in" }, { status: 401 }) };
  const user = await userForSession(session);
  if (!user) return { session: null, response: Response.json({ error: "Session is invalid" }, { status: 401 }) };
  const access = await deviceAndLicense(session.deviceId, session.businessId);
  return { session, user, access };
}

export async function authorizedSession(request: NextRequest, permission: string) {
  const result = await sessionResponse(request);
  if (!result.user || !result.session) return { response: result.response };
  const permissions = result.user.permissions && typeof result.user.permissions === "object" ? result.user.permissions : {};
  if (result.user.is_owner !== true && permissions[permission] !== true) return { response: Response.json({ error: "You do not have permission to perform this action" }, { status: 403 }) };
  return { session: result.session, user: result.user, access: result.access };
}

export async function logout(request: NextRequest, response: Response) {
  const session = await readSession(request);
  if (session) await db.query("DELETE FROM app_sessions WHERE token_hash=$1", [hashToken(session.token)]);
  clearSessionCookie(response);
  return Response.json({ success: true }, { headers: response.headers });
}
