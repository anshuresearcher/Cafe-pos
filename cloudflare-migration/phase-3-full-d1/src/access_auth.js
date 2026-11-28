const AUTH_SERVICE_SCOPES = new Set([
  "auth.device.read", "auth.users.read", "auth.login.read", "auth.login.write",
  "auth.session.read", "auth.session.write", "auth.device.register",
  "auth.support.view", "auth.support.business.write", "auth.support.user.write",
  "auth.support.license.write", "auth.support.device.write", "auth.support.key.write",
  "auth.support.login",
  "auth.public.registration", "auth.public.device.read", "auth.public.device.register",
  "auth.public.session.read", "auth.public.session.write", "auth.public.business.read",
]);

const BUILT_IN_ACCESS_PROFILES = new Set(["slash ops", "admin", "manager", "cashier"]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function parseObject(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(String(value || "")) || fallback; } catch { return fallback; }
}

function profileLevel(name) {
  const normalized = String(name || "").trim().toLowerCase();
  return new Map([["slash ops", 0], ["admin", 1], ["manager", 2], ["cashier", 3]]).get(normalized) ?? Number.POSITIVE_INFINITY;
}

function canManageRole(actorName, targetName) {
  const actor = profileLevel(actorName);
  const target = profileLevel(targetName);
  return actor === 0 ? target > actor : Number.isFinite(actor) && Number.isFinite(target) && target > actor;
}

function publicProfile(row) {
  if (!row) return null;
  return { ...row, permissions: parseObject(row.permissions, {}) };
}

function authPathScope(path, method) {
  if (path === "/v1/auth/public/register-business" && method === "POST") return "auth.public.registration";
  if (path === "/v1/auth/public/device" && method === "GET") return "auth.public.device.read";
  if (path === "/v1/auth/public/register-device" && method === "POST") return "auth.public.device.register";
  if (path === "/v1/auth/public/session" && method === "GET") return "auth.public.session.read";
  if (path === "/v1/auth/public/session" && method === "DELETE") return "auth.public.session.write";
  if (path === "/v1/auth/public/business-enabled" && method === "GET") return "auth.public.business.read";
  if (path === "/v1/auth/device" && method === "GET") return "auth.device.read";
  if (path === "/v1/auth/users" && method === "GET") return "auth.users.read";
  if (path === "/v1/auth/login-user" && method === "POST") return "auth.login.read";
  if (path === "/v1/auth/login-failure" && method === "POST") return "auth.login.write";
  if (path === "/v1/auth/login-failures" && method === "DELETE") return "auth.login.write";
  if (path === "/v1/auth/session" && method === "GET") return "auth.session.read";
  if (path === "/v1/auth/session" && ["POST", "DELETE"].includes(method)) return "auth.session.write";
  if (path === "/v1/auth/register-device" && method === "POST") return "auth.device.register";
  if (path === "/v1/auth/system-support/login-user" && method === "POST") return "auth.support.login";
  if (path === "/v1/auth/system-support/login-lockout" && method === "GET") return "auth.support.login";
  if (path === "/v1/auth/system-support/login-failure" && method === "POST") return "auth.support.login";
  if (path === "/v1/auth/system-support/login-failures" && method === "DELETE") return "auth.support.login";
  if (path === "/v1/auth/system-support/session" && ["GET", "POST", "DELETE"].includes(method)) return "auth.support.login";
  if (path === "/v1/auth/support/business-summary" && method === "GET") return "auth.support.view";
  if (path === "/v1/auth/support/business" && method === "PATCH") return "auth.support.business.write";
  if (path === "/v1/auth/support/branding" && method === "PATCH") return "auth.support.business.write";
  if (path === "/v1/auth/support/users" && method === "GET") return "auth.support.view";
  if (path === "/v1/auth/support/users" && method === "POST") return "auth.support.user.write";
  if (path.startsWith("/v1/auth/support/users/") && method === "PATCH") return "auth.support.user.write";
  if (path === "/v1/auth/support/slash-ops/reset-password" && method === "POST") return "auth.support.user.write";
  if (path === "/v1/auth/support/devices" && method === "GET") return "auth.support.view";
  if (/^\/v1\/auth\/support\/licenses\/\d+$/.test(path) && method === "GET") return "auth.support.view";
  if (path === "/v1/auth/support/licenses" && method === "POST") return "auth.support.license.write";
  if (/^\/v1\/auth\/support\/licenses\/\d+$/.test(path) && method === "PATCH") return "auth.support.license.write";
  if (path === "/v1/auth/support/registration-keys" && method === "POST") return "auth.support.key.write";
  if (/^\/v1\/auth\/support\/registration-keys\/\d+\/revoke$/.test(path) && method === "POST") return "auth.support.key.write";
  if (/^\/v1\/auth\/support\/devices\/\d+\/revoke$/.test(path) && method === "POST") return "auth.support.device.write";
  if (/^\/v1\/auth\/support\/devices\/\d+$/.test(path) && method === "DELETE") return "auth.support.device.write";
  return "";
}

async function readBody(request) {
  try {
    const raw = await request.text();
    if (raw.length > 16384) return { error: "Request is too large", status: 413 };
    const body = JSON.parse(raw || "{}");
    return body && typeof body === "object" && !Array.isArray(body)
      ? { body }
      : { error: "Request body must be an object", status: 400 };
  } catch {
    return { error: "Invalid request body", status: 400 };
  }
}

async function loadDeviceContext(env, businessId, deviceId) {
  const row = await env.DB.prepare(`
    SELECT d.id AS device_row_id, d.business_id AS device_business_id, d.license_id,
      d.device_id, d.device_name, d.device_type, d.status AS device_status,
      d.registration_key_id, d.registered_at, d.last_seen_at, d.last_ip, d.user_agent,
      d.revoked_at, b.business_name, b.business_type, b.owner_name,
      b.phone AS business_phone, b.email AS business_email, b.address AS business_address,
      b.city, b.state, b.gstin, b.logo_url, b.currency, b.active AS business_active,
      l.id AS license_row_id, l.plan AS license_plan, l.status AS license_status,
      l.starts_at AS license_starts_at, l.expires_at AS license_expires_at,
      l.max_devices AS license_max_devices, l.license_type, l.duration_months, l.add_on
    FROM registered_devices d
    JOIN businesses b ON b.id = d.business_id
    LEFT JOIN business_licenses l ON l.id = d.license_id AND l.business_id = d.business_id
    WHERE d.business_id = ? AND d.device_id = ? LIMIT 1
  `).bind(businessId, deviceId).first();
  if (!row) return null;
  const device = {
    id: row.device_row_id, business_id: row.device_business_id, license_id: row.license_id,
    device_id: row.device_id, device_name: row.device_name, device_type: row.device_type,
    status: row.device_status, registration_key_id: row.registration_key_id,
    registered_at: row.registered_at, last_seen_at: row.last_seen_at,
    last_ip: row.last_ip, user_agent: row.user_agent, revoked_at: row.revoked_at,
  };
  const business = {
    id: row.device_business_id, business_name: row.business_name, business_type: row.business_type,
    owner_name: row.owner_name, phone: row.business_phone, email: row.business_email,
    address: row.business_address, city: row.city, state: row.state, gstin: row.gstin,
    logo_url: row.logo_url, currency: row.currency, active: row.business_active,
  };
  const license = row.license_row_id ? {
    id: row.license_row_id, business_id: row.device_business_id, plan: row.license_plan,
    status: row.license_status, starts_at: row.license_starts_at, expires_at: row.license_expires_at,
    max_devices: row.license_max_devices, license_type: row.license_type,
    duration_months: row.duration_months, add_on: row.add_on,
  } : null;
  return { device, business, license };
}

function accessPathScope(path, method) {
  if (["/v1/pos/access", "/v1/pos/access/users", "/v1/pos/access/profiles"].includes(path) && method === "GET") return "access.view";
  if (["/v1/pos/access/users", "/v1/pos/access/profiles"].includes(path) && method === "POST") return "access.create";
  if (/^\/v1\/pos\/access\/users\/\d+$/.test(path) && method === "PUT") return "access.edit";
  if (/^\/v1\/pos\/access\/users\/\d+\/block$/.test(path) && method === "PATCH") return "access.edit";
  if (/^\/v1\/pos\/access\/profiles\/\d+$/.test(path) && method === "PUT") return "access.edit";
  if (/^\/v1\/pos\/access\/(?:users|profiles)\/\d+$/.test(path) && method === "DELETE") return "access.delete";
  return "";
}

function accessId(path, kind) {
  const match = path.match(new RegExp(`^/v1/pos/access/${kind}/(\\d+)(?:/block)?$`));
  const id = Number(match?.[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function loginIdentityKey(businessId, username) {
  const value = `business:${Number(businessId) || 0}:${String(username || "").trim().toLowerCase()}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deviceAdminPathScope(path, method) {
  if (path === "/v1/pos/devices" && method === "GET") return "devices.view";
  if (path === "/v1/pos/license/status" && method === "GET") return "settings.view";
  if (path === "/v1/pos/devices/registration-keys" && method === "POST") return "devices.edit";
  if (/^\/v1\/pos\/devices\/\d+\/revoke$/.test(path) && method === "POST") return "devices.edit";
  return "";
}

async function handleD1DeviceAdmin(request, env, businessId, claims, path) {
  const method = request.method.toUpperCase();
  const requiredScope = deviceAdminPathScope(path, method);
  if (!requiredScope || claims.scope !== requiredScope || Number(claims.business_id) !== businessId) {
    return json({ error: "Device administration request is not authorized" }, 403);
  }
  try {
    const actor = await env.DB.prepare("SELECT id, active, is_blocked FROM app_users WHERE id = ? AND business_id = ? LIMIT 1").bind(Number(claims.sub), businessId).first();
    if (!actor || !Boolean(actor.active) || Boolean(actor.is_blocked)) return json({ error: "Device administration is unavailable for this account" }, 403);

    const license = await env.DB.prepare("SELECT * FROM business_licenses WHERE business_id = ? ORDER BY id DESC LIMIT 1").bind(businessId).first();
    const currentLicense = license && license.status === "active" && Date.parse(license.expires_at) < Date.now()
      ? { ...license, status: "expired" }
      : license;
    const activeDeviceCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM registered_devices WHERE business_id = ? AND status = 'active'").bind(businessId).first();

    if (path === "/v1/pos/devices/registration-keys" && method === "POST") {
      const parsed = await readBody(request);
      if (parsed.error) return json({ error: parsed.error }, parsed.status);
      const created = await createRegistrationKeyInD1(env, businessId, parsed.body, "admin", Number(claims.sub));
      return created.registrationKey ? json({ success: true, registrationKey: created.registrationKey }, created.status)
        : json({ error: created.error }, created.status);
    }

    if ((path === "/v1/pos/devices" || path === "/v1/pos/license/status") && method === "GET") {
      if (path === "/v1/pos/license/status") return json({ license: currentLicense || null, activeDevices: Number(activeDeviceCount?.count || 0) });
      const devices = await env.DB.prepare(`SELECT id, device_name, device_type, status, registered_at, last_seen_at, last_ip
        FROM registered_devices WHERE business_id = ? ORDER BY id DESC`).bind(businessId).all();
      return json({ businessId, devices: devices.results || [], license: currentLicense || null });
    }

    const revokeMatch = path.match(/^\/v1\/pos\/devices\/(\d+)\/revoke$/);
    if (revokeMatch && method === "POST") {
      const id = Number(revokeMatch[1]);
      if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "Invalid device ID" }, 400);
      const device = await env.DB.prepare(`UPDATE registered_devices SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?
        RETURNING id, device_name, status, revoked_at, device_id`).bind(id, businessId).first();
      if (!device) return json({ error: "Device not found" }, 404);
      await env.DB.prepare("DELETE FROM app_sessions WHERE business_id = ? AND device_id = ?").bind(businessId, device.device_id).run();
      return json({ success: true, device: { id: device.id, device_name: device.device_name, status: device.status, revoked_at: device.revoked_at } });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    const message = String(error?.message || "");
    if (/UNIQUE constraint failed/i.test(message)) return json({ error: "Registration key collision; retry" }, 409);
    console.error("D1 device administration failed", { businessId, path, name: error?.name || "Error", message: message.slice(0, 300) });
    return json({ error: "D1 device administration request failed" }, 500);
  }
}

async function createRegistrationKeyInD1(env, businessId, body, createdByType, createdByUserId = null) {
  const keyHash = String(body.keyHash || "").trim().toLowerCase();
  const keyHint = String(body.keyHint || "").trim().slice(0, 20);
  const deviceName = String(body.deviceName || "POS Device").trim().slice(0, 160) || "POS Device";
  const expiresAt = String(body.expiresAt || "").trim();
  const expiresMs = Date.parse(expiresAt);
  if (!/^[a-f0-9]{64}$/.test(keyHash) || !keyHint || !Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
    return { error: "Invalid registration key details", status: 400 };
  }

  const business = await env.DB.prepare("SELECT active FROM businesses WHERE id = ? LIMIT 1").bind(businessId).first();
  if (!business || Number(business.active) !== 1) return { error: "Business account is inactive or unavailable", status: 404 };
  const license = await env.DB.prepare("SELECT * FROM business_licenses WHERE business_id = ? ORDER BY id DESC LIMIT 1").bind(businessId).first();
  if (!license) return { error: "An active license is required to generate a device registration key", status: 403 };
  const startsAt = Date.parse(license.starts_at);
  const licenseExpiresAt = Date.parse(license.expires_at);
  if (license.status !== "active" || !Number.isFinite(startsAt) || startsAt > Date.now() ||
      !Number.isFinite(licenseExpiresAt) || licenseExpiresAt < Date.now()) {
    return { error: "An active license is required to generate a device registration key", status: 403 };
  }
  const activeCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM registered_devices WHERE business_id = ? AND status = 'active'").bind(businessId).first();
  if (Number(activeCount?.count || 0) >= Number(license.max_devices || 0)) {
    return { error: "Device limit reached (" + Number(license.max_devices || 0) + ")", status: 409 };
  }

  try {
    const registrationKey = await env.DB.prepare(`INSERT INTO device_registration_keys (
        business_id, license_id, key_hash, key_hint, device_name, status, created_by_type, created_by_user_id, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'unused', ?, ?, ?)
      RETURNING id, business_id, license_id, key_hint, device_name, status, expires_at, created_at`)
      .bind(businessId, license.id, keyHash, keyHint, deviceName, createdByType, createdByUserId, expiresAt).first();
    if (!registrationKey) return { error: "Could not create registration key", status: 500 };
    return { registrationKey, status: 201 };
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message || ""))) return { error: "Registration key collision; retry", status: 409 };
    throw error;
  }
}

async function handleSupportAuthService(request, env, businessId, path) {
  const method = request.method.toUpperCase();
  if (path === "/v1/auth/support/business-summary" && method === "GET") {
    const business = await env.DB.prepare("SELECT id, business_code, business_name, business_type, owner_name, phone, email, address, city, state, gstin, logo_url, currency, active, created_at FROM businesses WHERE id = ? LIMIT 1").bind(businessId).first();
    if (!business) return json({ error: "Business not found" }, 404);
    const [license, devices, users, branding] = await Promise.all([
      env.DB.prepare("SELECT * FROM business_licenses WHERE business_id = ? ORDER BY id DESC LIMIT 1").bind(businessId).first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM registered_devices WHERE business_id = ? AND status = 'active'").bind(businessId).first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM app_users WHERE business_id = ? AND active = 1 AND is_blocked = 0").bind(businessId).first(),
      env.DB.prepare("SELECT show_powered_by_cafe_pilot FROM support_business_branding WHERE business_id = ? LIMIT 1").bind(businessId).first(),
    ]);
    return json({
      business: { ...business, active: Number(business.active) === 1 },
      license: license || null,
      activeDevices: Number(devices?.count || 0),
      activeUsers: Number(users?.count || 0),
      showPoweredByCafePilot: branding ? Number(branding.show_powered_by_cafe_pilot) === 1 : true,
    });
  }

  if (path === "/v1/auth/support/business" && method === "PATCH") {
    const parsed = await readBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const businessName = String(parsed.body.businessName || "").trim();
    if (!businessName || businessName.length > 200) return json({ error: "Business name must be 1 to 200 characters" }, 400);
    const business = await env.DB.prepare("UPDATE businesses SET business_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING id, business_name")
      .bind(businessName, businessId).first();
    return business ? json({ success: true, business }) : json({ error: "Business not found" }, 404);
  }

  if (path === "/v1/auth/support/branding" && method === "PATCH") {
    const parsed = await readBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    if (typeof parsed.body.showPoweredByCafePilot !== "boolean") return json({ error: "Choose whether Slash branding should be shown." }, 400);
    const result = await env.DB.prepare("INSERT INTO support_business_branding (business_id, show_powered_by_cafe_pilot, updated_at) SELECT id, ?, CURRENT_TIMESTAMP FROM businesses WHERE id = ? ON CONFLICT(business_id) DO UPDATE SET show_powered_by_cafe_pilot = excluded.show_powered_by_cafe_pilot, updated_at = CURRENT_TIMESTAMP RETURNING show_powered_by_cafe_pilot")
      .bind(parsed.body.showPoweredByCafePilot ? 1 : 0, businessId).first();
    return result ? json({ success: true, showPoweredByCafePilot: Number(result.show_powered_by_cafe_pilot) === 1 }) : json({ error: "Business not found" }, 404);
  }

  if (path === "/v1/auth/support/users" && method === "GET") {
    const [users, profiles] = await Promise.all([
      env.DB.prepare("SELECT u.id, u.display_name, u.username, u.profile_id, u.active, u.is_blocked, u.blocked_at, u.block_reason, u.failed_login_attempts, u.created_at, u.is_owner, p.name AS profile_name, u.permissions_override, COALESCE(u.permissions_override, p.permissions, '{}') AS permissions FROM app_users u LEFT JOIN access_profiles p ON p.id = u.profile_id AND p.business_id = u.business_id WHERE u.business_id = ? ORDER BY u.id").bind(businessId).all(),
      env.DB.prepare("SELECT id, name, description, permissions FROM access_profiles WHERE business_id = ? ORDER BY name").bind(businessId).all(),
    ]);
    const publicUser = row => ({
      ...row,
      active: Number(row.active) === 1,
      is_blocked: Number(row.is_blocked) === 1,
      is_owner: Number(row.is_owner) === 1,
      permissions_override: row.permissions_override == null ? null : parseObject(row.permissions_override, {}),
      permissions: parseObject(row.permissions, {}),
    });
    return json({
      users: (users.results || []).map(publicUser),
      profiles: (profiles.results || []).map(row => ({ ...row, permissions: parseObject(row.permissions, {}) })),
    });
  }

  if (path === "/v1/auth/support/users" && method === "POST") {
    const parsed = await readBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const body = parsed.body;
    const displayName = String(body.displayName || "").trim();
    const username = String(body.username || "").trim().toLowerCase();
    const passwordHash = String(body.passwordHash || "");
    const profileId = body.profileId === null || body.profileId === undefined || body.profileId === "" ? null : Number(body.profileId);
    if (!displayName || !username) return json({ error: "Display name and username are required" }, 400);
    if (!/^[a-z0-9._-]{3,100}$/.test(username)) return json({ error: "Invalid username" }, 400);
    if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(passwordHash)) return json({ error: "Invalid password hash" }, 400);
    if (profileId !== null && (!Number.isSafeInteger(profileId) || profileId <= 0)) return json({ error: "Invalid permission profile" }, 400);
    if (body.active !== undefined && typeof body.active !== "boolean") return json({ error: "Invalid active status" }, 400);
    let profile = null;
    if (profileId !== null) {
      profile = await env.DB.prepare("SELECT id, name FROM access_profiles WHERE id = ? AND business_id = ? LIMIT 1").bind(profileId, businessId).first();
      if (!profile) return json({ error: "Permission profile must belong to the selected business" }, 400);
      if (String(profile.name || "").toLowerCase() === "slash ops") return json({ error: "Slash ops accounts are created automatically for each business" }, 400);
    }
    const permissions = body.permissionsOverride === null || body.permissionsOverride === undefined ? null : body.permissionsOverride;
    if (permissions !== null && (!permissions || typeof permissions !== "object" || Array.isArray(permissions))) return json({ error: "Custom permissions must be an object" }, 400);
    if (String(profile?.name || "") === "Admin" && permissions && (!permissions["dashboard.view"] || !permissions["access.view"] || !permissions["access.edit"])) return json({ error: "Admin custom permissions must keep Dashboard and Access management available" }, 400);
    try {
      const user = await env.DB.prepare("INSERT INTO app_users (display_name, username, password_hash, profile_id, business_id, active, permissions_override) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, display_name, username, profile_id, business_id, active, created_at, updated_at")
        .bind(displayName, username, passwordHash, profileId, businessId, body.active === false ? 0 : 1, permissions === null ? null : JSON.stringify(permissions)).first();
      return user ? json({ success: true, user: { ...user, active: Number(user.active) === 1 } }, 201) : json({ error: "Failed to add business user" }, 500);
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error?.message || ""))) return json({ error: "A user with this username already exists in this business" }, 409);
      throw error;
    }
  }

  const supportUserPath = path.startsWith("/v1/auth/support/users/") ? path.slice("/v1/auth/support/users/".length) : "";
  const blockUserId = supportUserPath.endsWith("/block") ? Number(supportUserPath.slice(0, -"/block".length)) : null;
  if (Number.isSafeInteger(blockUserId) && blockUserId > 0 && method === "PATCH") {
    const parsed = await readBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const blocked = parsed.body.blocked;
    if (typeof blocked !== "boolean") return json({ error: "Choose whether to block or unblock this user" }, 400);
    const user = await env.DB.prepare("SELECT id, username FROM app_users WHERE id = ? AND business_id = ? LIMIT 1").bind(blockUserId, businessId).first();
    if (!user) return json({ error: "User not found in this business" }, 404);
    const updated = await env.DB.prepare("UPDATE app_users SET is_blocked = ?, failed_login_attempts = CASE WHEN ? = 1 THEN failed_login_attempts ELSE 0 END, blocked_at = CASE WHEN ? = 1 THEN COALESCE(blocked_at, CURRENT_TIMESTAMP) ELSE NULL END, blocked_by_user_id = NULL, blocked_by_support_user_id = CASE WHEN ? = 1 THEN ? ELSE NULL END, block_reason = CASE WHEN ? = 1 THEN 'support' ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ? RETURNING id, username, is_blocked, blocked_at, block_reason, failed_login_attempts")
      .bind(blocked ? 1 : 0, blocked ? 1 : 0, blocked ? 1 : 0, blocked ? 1 : 0,
        Number.isSafeInteger(Number(parsed.body.supportUserId)) ? Number(parsed.body.supportUserId) : null,
        blocked ? 1 : 0, blockUserId, businessId).first();
    if (blocked) {
      await env.DB.prepare("DELETE FROM app_sessions WHERE user_id = ? AND business_id = ?").bind(blockUserId, businessId).run();
    } else {
      const identity = "business:" + businessId + ":" + String(user.username || "").trim().toLowerCase();
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)));
      const identityKey = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
      await env.DB.prepare("DELETE FROM auth_login_attempts WHERE identity_key = ?").bind(identityKey).run();
    }
    return json({ success: true, user: { ...updated, is_blocked: Number(updated.is_blocked) === 1 } });
  }

  const supportUserId = Number(supportUserPath);
  if (Number.isSafeInteger(supportUserId) && supportUserId > 0 && method === "PATCH") {
    const parsed = await readBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const body = parsed.body;
    const current = await env.DB.prepare("SELECT u.*, p.name AS profile_name FROM app_users u LEFT JOIN access_profiles p ON p.id = u.profile_id AND p.business_id = u.business_id WHERE u.id = ? AND u.business_id = ? LIMIT 1")
      .bind(supportUserId, businessId).first();
    if (!current) return json({ error: "User not found in this business" }, 404);
    if (String(current.profile_name || "").toLowerCase() === "slash ops") return json({ error: "Use the dedicated Slash ops password reset action to manage this account" }, 403);
    const displayName = body.displayName === undefined ? current.display_name : String(body.displayName).trim();
    const username = body.username === undefined ? current.username : String(body.username).trim().toLowerCase();
    const profileId = body.profileId === undefined ? current.profile_id : (body.profileId === null || body.profileId === "" ? null : Number(body.profileId));
    const active = body.active === undefined ? Number(current.active) === 1 : body.active;
    const passwordHash = String(body.passwordHash || "");
    if (!displayName || !username) return json({ error: "Display name and username are required" }, 400);
    if (!/^[a-z0-9._-]{3,100}$/.test(username)) return json({ error: "Invalid username" }, 400);
    if (body.active !== undefined && typeof body.active !== "boolean") return json({ error: "Invalid active status" }, 400);
    if (passwordHash && !/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(passwordHash)) return json({ error: "Invalid password hash" }, 400);
    if (profileId !== null && (!Number.isSafeInteger(Number(profileId)) || Number(profileId) <= 0)) return json({ error: "Invalid permission profile" }, 400);
    let profileName = current.profile_name;
    if (profileId !== null) {
      const profile = await env.DB.prepare("SELECT id, name FROM access_profiles WHERE id = ? AND business_id = ? LIMIT 1").bind(Number(profileId), businessId).first();
      if (!profile) return json({ error: "Permission profile must belong to the selected business" }, 400);
      profileName = profile.name;
    }
    if (String(profileName || "").toLowerCase() === "slash ops") return json({ error: "Slash ops accounts are created automatically for each business" }, 400);
    if (Number(current.is_owner) === 1 && (!active || Number(profileId) !== Number(current.profile_id))) return json({ error: "The business owner account must remain active and assigned to its current access profile" }, 400);
    const permissions = body.permissionsOverride === undefined ? (current.permissions_override == null ? null : parseObject(current.permissions_override, {})) : body.permissionsOverride;
    if (permissions !== null && (!permissions || typeof permissions !== "object" || Array.isArray(permissions))) return json({ error: "Custom permissions must be an object" }, 400);
    if (String(profileName || "") === "Admin" && permissions && (!permissions["dashboard.view"] || !permissions["access.view"] || !permissions["access.edit"])) return json({ error: "Admin custom permissions must keep Dashboard and Access management available" }, 400);
    try {
      const updated = await env.DB.prepare("UPDATE app_users SET display_name = ?, username = ?, profile_id = ?, active = ?, password_hash = ?, permissions_override = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ? RETURNING id, display_name, username, profile_id, business_id, active, created_at, updated_at")
        .bind(displayName, username, profileId === null ? null : Number(profileId), active ? 1 : 0,
          passwordHash || current.password_hash, permissions === null ? null : JSON.stringify(permissions), supportUserId, businessId).first();
      if (passwordHash || !active) await env.DB.prepare("DELETE FROM app_sessions WHERE user_id = ? AND business_id = ?").bind(supportUserId, businessId).run();
      return updated ? json({ success: true, user: { ...updated, active: Number(updated.active) === 1 } }) : json({ error: "User not found in this business" }, 404);
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error?.message || ""))) return json({ error: "A user with this username already exists in this business" }, 409);
      throw error;
    }
  }

  if (path === "/v1/auth/support/slash-ops/reset-password" && method === "POST") {
    const parsed = await readBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const passwordHash = String(parsed.body.passwordHash || "");
    if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(passwordHash)) return json({ error: "Invalid password hash" }, 400);
    const user = await env.DB.prepare("SELECT u.id FROM app_users u JOIN access_profiles p ON p.id = u.profile_id AND p.business_id = u.business_id WHERE u.business_id = ? AND LOWER(p.name) = 'slash ops' ORDER BY u.id LIMIT 1")
      .bind(businessId).first();
    if (!user) return json({ error: "Slash ops user was not found for this business" }, 404);
    await env.DB.batch([
      env.DB.prepare("UPDATE app_users SET password_hash = ?, active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?").bind(passwordHash, user.id, businessId),
      env.DB.prepare("DELETE FROM app_sessions WHERE user_id = ? AND business_id = ?").bind(user.id, businessId),
    ]);
    return json({ success: true });
  }

  if (path === "/v1/auth/support/devices" && method === "GET") {
    const result = await env.DB.prepare(`SELECT d.id, d.business_id, d.device_id, d.device_name, d.device_type, d.status,
      d.registered_at, d.last_seen_at, d.last_ip, d.user_agent, l.plan, l.status AS license_status, l.expires_at
      FROM registered_devices d LEFT JOIN business_licenses l ON l.id = d.license_id AND l.business_id = d.business_id
      WHERE d.business_id = ? ORDER BY d.id DESC`).bind(businessId).all();
    return json(result.results || []);
  }

  const licenseMatch = path.match(/^\/v1\/auth\/support\/licenses\/(\d+)$/);
  if (licenseMatch && method === "GET") {
    const license = await env.DB.prepare("SELECT * FROM business_licenses WHERE id = ? AND business_id = ? LIMIT 1")
      .bind(Number(licenseMatch[1]), businessId).first();
    return license ? json({ license }) : json({ error: "License not found" }, 404);
  }

  if ((path === "/v1/auth/support/licenses" && method === "POST") || (licenseMatch && method === "PATCH")) {
    const parsed = await readBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const body = parsed.body;
    const licenseType = String(body.licenseType || body.plan || "").trim();
    const addOn = String(body.addOn || "").trim() || null;
    const durationMonths = Number(body.durationMonths);
    const status = String(body.status || "active").trim();
    const startsAt = String(body.startsAt || "").trim();
    const expiresAt = String(body.expiresAt || "").trim();
    const maxDevices = Number(body.maxDevices);
    const startsMs = Date.parse(startsAt);
    const expiresMs = Date.parse(expiresAt);
    const allowedAddons = new Set(["Marketing", "Table QR"]);
    const selectedAddons = addOn ? addOn.split(/[;,]/).map(value => value.trim()).filter(Boolean) : [];
    if (!["Trial", "Sales"].includes(licenseType) ||
        (licenseType === "Trial" ? durationMonths !== 1 : ![3, 6, 12].includes(durationMonths)) ||
        !["active", "suspended", "revoked", "expired"].includes(status) ||
        !Number.isInteger(maxDevices) || maxDevices < 1 ||
        !Number.isFinite(startsMs) || !Number.isFinite(expiresMs) || expiresMs <= startsMs ||
        selectedAddons.some(value => !allowedAddons.has(value))) {
      return json({ error: "Invalid license details" }, 400);
    }
    const notes = String(body.notes || "").trim().slice(0, 2000) || null;
    if (path === "/v1/auth/support/licenses" && method === "POST") {
      const business = await env.DB.prepare("SELECT id FROM businesses WHERE id = ? LIMIT 1").bind(businessId).first();
      if (!business) return json({ error: "Business not found" }, 404);
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE business_licenses SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND status = 'active'").bind(businessId),
        env.DB.prepare(`INSERT INTO business_licenses (
          business_id, plan, license_type, add_on, duration_months, status, starts_at, expires_at, max_devices, notes, created_by_support_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *`).bind(businessId, licenseType, licenseType, addOn, durationMonths, status, startsAt, expiresAt, maxDevices, notes,
          Number.isSafeInteger(Number(body.createdBySupportUserId)) ? Number(body.createdBySupportUserId) : null),
      ]);
      const license = results?.[1]?.results?.[0];
      return license ? json({ success: true, license }, 201) : json({ error: "Could not issue license" }, 500);
    }
    const id = Number(licenseMatch[1]);
    const updated = await env.DB.prepare(`UPDATE business_licenses
      SET plan = ?, license_type = ?, add_on = ?, duration_months = ?, status = ?, starts_at = ?, expires_at = ?,
        max_devices = ?, notes = ?, updated_at = CURRENT_TIMESTAMP,
        revoked_at = CASE WHEN ? = 'revoked' THEN COALESCE(revoked_at, CURRENT_TIMESTAMP) ELSE NULL END
      WHERE id = ? AND business_id = ? RETURNING *`)
      .bind(licenseType, licenseType, addOn, durationMonths, status, startsAt, expiresAt, maxDevices, notes, status, id, businessId).first();
    return updated ? json({ success: true, license: updated }) : json({ error: "License not found" }, 404);
  }

  if (path === "/v1/auth/support/registration-keys" && method === "POST") {
    const parsed = await readBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const created = await createRegistrationKeyInD1(env, businessId, parsed.body, "support",
      Number.isSafeInteger(Number(parsed.body.createdByUserId)) ? Number(parsed.body.createdByUserId) : null);
    return created.registrationKey ? json({ success: true, registrationKey: created.registrationKey }, created.status)
      : json({ error: created.error }, created.status);
  }

  const revokeKeyMatch = path.match(/^\/v1\/auth\/support\/registration-keys\/(\d+)\/revoke$/);
  if (revokeKeyMatch && method === "POST") {
    const key = await env.DB.prepare(`UPDATE device_registration_keys SET status = 'revoked'
      WHERE id = ? AND business_id = ? AND status = 'unused'
      RETURNING id, business_id, key_hint, status`).bind(Number(revokeKeyMatch[1]), businessId).first();
    return key ? json({ success: true, key }) : json({ error: "Unused registration key not found" }, 404);
  }

  const revokeDeviceMatch = path.match(/^\/v1\/auth\/support\/devices\/(\d+)\/revoke$/);
  if (revokeDeviceMatch && method === "POST") {
    const device = await env.DB.prepare(`UPDATE registered_devices SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?
      RETURNING id, business_id, device_id, device_name, status, revoked_at`).bind(Number(revokeDeviceMatch[1]), businessId).first();
    if (!device) return json({ error: "Device not found" }, 404);
    await env.DB.prepare("DELETE FROM app_sessions WHERE business_id = ? AND device_id = ?").bind(businessId, device.device_id).run();
    return json({ success: true, device: { id: device.id, business_id: device.business_id, device_name: device.device_name, status: device.status, revoked_at: device.revoked_at } });
  }

  const deleteDeviceMatch = path.match(/^\/v1\/auth\/support\/devices\/(\d+)$/);
  if (deleteDeviceMatch && method === "DELETE") {
    const id = Number(deleteDeviceMatch[1]);
    const existing = await env.DB.prepare("SELECT id, status, device_id FROM registered_devices WHERE id = ? AND business_id = ? LIMIT 1").bind(id, businessId).first();
    if (!existing) return json({ error: "Device not found" }, 404);
    if (existing.status !== "revoked") return json({ error: "Only revoked devices can be deleted. Revoke the device first." }, 409);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM app_sessions WHERE business_id = ? AND device_id = ?").bind(businessId, existing.device_id),
      env.DB.prepare("UPDATE device_registration_keys SET used_device_id = NULL WHERE used_device_id = ?").bind(id),
      env.DB.prepare("DELETE FROM registered_devices WHERE id = ? AND business_id = ? AND status = 'revoked'").bind(id, businessId),
    ]);
    return json({ success: true, device: { id, business_id: businessId, status: "deleted" } });
  }

  return null;
}

async function handleSystemSupportAuthService(request, env, path, url) {
  if (!path.startsWith("/v1/auth/system-support/")) return null;
  const method = request.method.toUpperCase();

  if (path === "/v1/auth/system-support/login-user" && method === "POST") {
    const parsed = await readBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const username = String(parsed.body.username || "").trim().toLowerCase().slice(0, 100);
    if (!/^[a-z0-9._-]{3,100}$/.test(username)) return json({ error: "Invalid username" }, 400);
    const user = await env.DB.prepare(
      "SELECT id, username, display_name, password_hash, active FROM support_users WHERE lower(username) = ? LIMIT 1"
    ).bind(username).first();
    return json({ user: user ? { ...user, active: Number(user.active) === 1 } : null });
  }

  if (path === "/v1/auth/system-support/login-lockout" && method === "GET") {
    const identityKey = String(url.searchParams.get("identity_key") || "");
    if (!/^[a-f0-9]{64}$/i.test(identityKey)) return json({ error: "Invalid login identity" }, 400);
    const row = await env.DB.prepare(
      "SELECT CAST(strftime('%s', locked_until) AS INTEGER) * 1000 AS lockedUntil FROM auth_login_attempts WHERE identity_key = ? LIMIT 1"
    ).bind(identityKey).first();
    const lockedUntil = Number(row?.lockedUntil || 0);
    return json({ lockedUntil: lockedUntil > Date.now() ? lockedUntil : 0 });
  }

  if (path === "/v1/auth/system-support/login-failure" && method === "POST") {
    const parsed = await readBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const identityKey = String(parsed.body.identityKey || "");
    if (!/^[a-f0-9]{64}$/i.test(identityKey)) return json({ error: "Invalid login identity" }, 400);
    await env.DB.prepare(`
      INSERT INTO auth_login_attempts(identity_key, window_started_at, failure_count, locked_until, updated_at)
      VALUES (?, CURRENT_TIMESTAMP, 1, NULL, CURRENT_TIMESTAMP)
      ON CONFLICT(identity_key) DO UPDATE SET
        failure_count = CASE WHEN datetime(auth_login_attempts.window_started_at) <= datetime('now', '-15 minutes') THEN 1 ELSE auth_login_attempts.failure_count + 1 END,
        window_started_at = CASE WHEN datetime(auth_login_attempts.window_started_at) <= datetime('now', '-15 minutes') THEN CURRENT_TIMESTAMP ELSE auth_login_attempts.window_started_at END,
        locked_until = CASE WHEN (CASE WHEN datetime(auth_login_attempts.window_started_at) <= datetime('now', '-15 minutes') THEN 1 ELSE auth_login_attempts.failure_count + 1 END) >= 5 THEN datetime('now', '+15 minutes') ELSE NULL END,
        updated_at = CURRENT_TIMESTAMP
    `).bind(identityKey).run();
    const row = await env.DB.prepare(
      "SELECT CAST(strftime('%s', locked_until) AS INTEGER) * 1000 AS lockedUntil FROM auth_login_attempts WHERE identity_key = ? LIMIT 1"
    ).bind(identityKey).first();
    const lockedUntil = Number(row?.lockedUntil || 0);
    return json({ lockedUntil: lockedUntil > Date.now() ? lockedUntil : 0 });
  }

  if (path === "/v1/auth/system-support/login-failures" && method === "DELETE") {
    const identityKey = String(url.searchParams.get("identity_key") || "");
    if (!/^[a-f0-9]{64}$/i.test(identityKey)) return json({ error: "Invalid login identity" }, 400);
    await env.DB.prepare("DELETE FROM auth_login_attempts WHERE identity_key = ?").bind(identityKey).run();
    return json({ success: true });
  }

  if (path === "/v1/auth/system-support/session" && method === "POST") {
    const parsed = await readBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const supportUserId = Number(parsed.body.supportUserId);
    const tokenHash = String(parsed.body.tokenHash || "").trim().toLowerCase();
    const expiresAt = String(parsed.body.expiresAt || "");
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isSafeInteger(supportUserId) || supportUserId <= 0 || !/^[a-f0-9]{64}$/i.test(tokenHash)
      || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() || expiresAtMs > Date.now() + 31 * 24 * 60 * 60 * 1000) {
      return json({ error: "Invalid support session details" }, 400);
    }
    const user = await env.DB.prepare("SELECT id FROM support_users WHERE id = ? AND active = 1 LIMIT 1").bind(supportUserId).first();
    if (!user) return json({ error: "Support account is inactive" }, 403);
    await env.DB.prepare(
      "INSERT INTO support_sessions(token, support_user_id, expires_at, token_hash) VALUES (?, ?, ?, ?)"
    ).bind(tokenHash, supportUserId, new Date(expiresAtMs).toISOString(), tokenHash).run();
    return json({ success: true }, 201);
  }

  if (path === "/v1/auth/system-support/session" && method === "GET") {
    const tokenHash = String(url.searchParams.get("token_hash") || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/i.test(tokenHash)) return json({ error: "Invalid support session" }, 400);
    const row = await env.DB.prepare(`
      SELECT s.token_hash AS token, s.token_hash, s.support_user_id, s.expires_at, u.username, u.display_name
      FROM support_sessions s JOIN support_users u ON u.id = s.support_user_id
      WHERE s.token_hash = ? AND u.active = 1 LIMIT 1
    `).bind(tokenHash).first();
    if (!row) return json({ error: "Support authentication required" }, 404);
    if (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.now()) {
      await env.DB.prepare("DELETE FROM support_sessions WHERE token_hash = ?").bind(tokenHash).run();
      return json({ error: "Support authentication required" }, 401);
    }
    return json({ session: row });
  }

  if (path === "/v1/auth/system-support/session" && method === "DELETE") {
    const tokenHash = String(url.searchParams.get("token_hash") || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/i.test(tokenHash)) return json({ error: "Invalid support session" }, 400);
    await env.DB.prepare("DELETE FROM support_sessions WHERE token_hash = ?").bind(tokenHash).run();
    return json({ success: true });
  }

  return json({ error: "Not found" }, 404);
}

async function handleAuthService(request, env, businessId, claims, path, url) {
  const method = request.method.toUpperCase();
  const requiredScope = authPathScope(path, method);
  if (!requiredScope || claims.sub !== 0 || claims.business_id !== businessId || claims.scope !== requiredScope) {
    return json({ error: "Unauthorized staging authentication request" }, 403);
  }
  try {
    const systemSupportResponse = await handleSystemSupportAuthService(request, env, path, url);
    if (systemSupportResponse) return systemSupportResponse;
    const supportResponse = await handleSupportAuthService(request, env, businessId, path);
    if (supportResponse) return supportResponse;
    if (path === "/v1/auth/register-device" && method === "POST") {
      const parsed = await readBody(request);
      if (parsed.error) return json({ error: parsed.error }, parsed.status);
      const keyHash = String(parsed.body.keyHash || "").trim().toLowerCase();
      const deviceId = String(parsed.body.deviceId || "").trim().slice(0, 128);
      const deviceName = String(parsed.body.deviceName || "POS Device").trim().slice(0, 120) || "POS Device";
      const deviceType = String(parsed.body.deviceType || "Web").trim().slice(0, 50) || "Web";
      const ip = String(parsed.body.ip || "").trim().slice(0, 100);
      const userAgent = String(parsed.body.userAgent || "").trim().slice(0, 512);
      if (!/^[a-f0-9]{64}$/.test(keyHash) || !deviceId) return json({ error: "Invalid device registration details" }, 400);

      const key = await env.DB.prepare(`
        SELECT k.id, k.business_id, k.license_id, k.status, k.expires_at,
          l.status AS license_status, l.starts_at AS license_starts_at, l.expires_at AS license_expires_at,
          l.max_devices, b.business_name, b.business_code, b.active AS business_active
        FROM device_registration_keys k
        JOIN businesses b ON b.id = k.business_id
        LEFT JOIN business_licenses l ON l.id = k.license_id AND l.business_id = k.business_id
        WHERE k.business_id = ? AND k.key_hash = ? LIMIT 1
      `).bind(businessId, keyHash).first();
      if (!key) return json({ error: "Invalid registration key" }, 404);
      if (key.status !== "unused") return json({ error: "This registration key has already been used or revoked" }, 409);
      const keyExpiresAt = key.expires_at ? Date.parse(key.expires_at) : Number.POSITIVE_INFINITY;
      if (key.expires_at && (!Number.isFinite(keyExpiresAt) || keyExpiresAt < Date.now())) {
        await env.DB.prepare("UPDATE device_registration_keys SET status = 'expired' WHERE id = ? AND status = 'unused'").bind(key.id).run();
        return json({ error: "This registration key has expired" }, 410);
      }
      if (Number(key.business_active) !== 1) return json({ error: "Business account is inactive" }, 403);
      if (!key.license_id || !key.license_status) return json({ error: "No license is assigned to this business", code: "LICENSE_MISSING" }, 403);
      if (key.license_status !== "active") return json({ error: "Business license is not active", code: "LICENSE_INACTIVE" }, 403);
      const licenseStartsAt = Date.parse(key.license_starts_at);
      const licenseExpiresAt = Date.parse(key.license_expires_at);
      if (!Number.isFinite(licenseStartsAt) || licenseStartsAt > Date.now()) return json({ error: "Business license has not started yet", code: "LICENSE_NOT_STARTED" }, 403);
      if (!Number.isFinite(licenseExpiresAt) || licenseExpiresAt < Date.now()) {
        await env.DB.prepare("UPDATE business_licenses SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'").bind(key.license_id).run();
        return json({ error: "Business license has expired", code: "LICENSE_EXPIRED" }, 403);
      }

      const existingDevice = await env.DB.prepare("SELECT status FROM registered_devices WHERE device_id = ? LIMIT 1").bind(deviceId).first();
      if (existingDevice?.status === "active") return json({ error: "This device is already registered to a business." }, 409);
      const activeCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM registered_devices WHERE business_id = ? AND status = 'active'").bind(businessId).first();
      if (Number(activeCount?.count || 0) >= Number(key.max_devices || 0)) return json({ error: `Device limit reached (${key.max_devices})` }, 409);

      const deviceInsert = env.DB.prepare(`
        INSERT INTO registered_devices (
          business_id, license_id, device_id, device_name, device_type, status, registration_key_id,
          registered_at, last_seen_at, last_ip, user_agent, revoked_at, created_at, updated_at
        )
        SELECT k.business_id, k.license_id, ?, ?, ?, 'active', k.id,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM device_registration_keys k
        JOIN business_licenses l ON l.id = k.license_id AND l.business_id = k.business_id
        JOIN businesses b ON b.id = k.business_id
        WHERE k.id = ? AND k.business_id = ? AND k.key_hash = ? AND k.status = 'unused'
          AND (k.expires_at IS NULL OR julianday(k.expires_at) >= julianday('now'))
          AND b.active = 1 AND l.status = 'active'
          AND julianday(CASE
            WHEN substr(l.starts_at, -3, 1) IN ('+', '-') AND substr(l.starts_at, -2, 2) NOT GLOB '*[^0-9]*'
              THEN substr(l.starts_at, 1, length(l.starts_at) - 3) || substr(l.starts_at, -3, 3) || ':00'
            ELSE l.starts_at
          END) <= julianday('now')
          AND julianday(CASE
            WHEN substr(l.expires_at, -3, 1) IN ('+', '-') AND substr(l.expires_at, -2, 2) NOT GLOB '*[^0-9]*'
              THEN substr(l.expires_at, 1, length(l.expires_at) - 3) || substr(l.expires_at, -3, 3) || ':00'
            ELSE l.expires_at
          END) >= julianday('now')
          AND (SELECT COUNT(*) FROM registered_devices d WHERE d.business_id = k.business_id AND d.status = 'active') < l.max_devices
        ON CONFLICT(device_id) DO UPDATE SET
          business_id = excluded.business_id, license_id = excluded.license_id,
          device_name = excluded.device_name, device_type = excluded.device_type, status = 'active',
          registration_key_id = excluded.registration_key_id, registered_at = CURRENT_TIMESTAMP,
          last_seen_at = CURRENT_TIMESTAMP, last_ip = excluded.last_ip, user_agent = excluded.user_agent,
          revoked_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE registered_devices.status <> 'active'
        RETURNING id, business_id, license_id, device_id, device_name, device_type, status, registered_at, last_seen_at
      `).bind(deviceId, deviceName, deviceType, ip, userAgent, key.id, businessId, keyHash);
      const keyUpdate = env.DB.prepare(`
        UPDATE device_registration_keys
        SET status = 'used', used_at = CURRENT_TIMESTAMP,
          used_device_id = (SELECT id FROM registered_devices WHERE device_id = ? AND business_id = ? AND registration_key_id = ? AND status = 'active')
        WHERE id = ? AND business_id = ? AND key_hash = ? AND status = 'unused'
          AND EXISTS (SELECT 1 FROM registered_devices WHERE device_id = ? AND business_id = ? AND registration_key_id = ? AND status = 'active')
        RETURNING id, used_device_id
      `).bind(deviceId, businessId, key.id, key.id, businessId, keyHash, deviceId, businessId, key.id);
      const registrationWrites = await env.DB.batch([deviceInsert, keyUpdate]);
      // Use D1 RETURNING rows directly so success does not depend on an immediate read.
      const device = registrationWrites?.[0]?.results?.[0] || null;
      const consumedKey = registrationWrites?.[1]?.results?.[0] || null;
      if (!device || !consumedKey) {
        const [latestKey, existingDevice, activeCountAfter] = await Promise.all([
          env.DB.prepare("SELECT status FROM device_registration_keys WHERE id = ? AND business_id = ? LIMIT 1").bind(key.id, businessId).first(),
          env.DB.prepare("SELECT status, business_id FROM registered_devices WHERE device_id = ? LIMIT 1").bind(deviceId).first(),
          env.DB.prepare("SELECT COUNT(*) AS count FROM registered_devices WHERE business_id = ? AND status = 'active'").bind(businessId).first(),
        ]);
        if (existingDevice?.status === "active") {
          return json({ error: "This browser device is already registered. Sign in with its existing account, or revoke that device before registering it again.", code: "DEVICE_ALREADY_REGISTERED" }, 409);
        }
        if (!latestKey || latestKey.status !== "unused") {
          return json({ error: "This registration key was consumed or changed during registration. Generate a fresh key and retry.", code: "REGISTRATION_KEY_NOT_UNUSED" }, 409);
        }
        if (Number(activeCountAfter?.count || 0) >= Number(key.max_devices || 0)) {
          return json({ error: "Device limit reached (" + key.max_devices + ")", code: "DEVICE_LIMIT_REACHED" }, 409);
        }
        if (device && !consumedKey) {
          const repairedKey = await env.DB.prepare("UPDATE device_registration_keys SET status = 'used', used_at = CURRENT_TIMESTAMP, used_device_id = ? WHERE id = ? AND business_id = ? AND key_hash = ? AND status = 'unused' RETURNING id").bind(device.id, key.id, businessId, keyHash).first();
          if (repairedKey) return json({
            success: true,
            business: { id: Number(businessId), business_code: key.business_code, business_name: key.business_name },
            device,
          }, 201);
        }
        console.error("D1 device registration could not verify its saved rows", {
          businessId, deviceId, keyId: key.id, deviceSaved: Boolean(device), keyConsumed: Boolean(consumedKey),
          insertRowsReturned: Number(Boolean(registrationWrites?.[0]?.results?.length)), keyRowsReturned: Number(Boolean(registrationWrites?.[1]?.results?.length)),
          activeDevices: Number(activeCountAfter?.count || 0), maxDevices: Number(key.max_devices || 0),
        });
        return json({ error: "D1 could not finish saving this device registration. Check the device and key status before retrying.", code: "DEVICE_REGISTRATION_WRITE_INCOMPLETE" }, 409);
      }
      return json({
        success: true,
        business: { id: Number(businessId), business_code: key.business_code, business_name: key.business_name },
        device,
      }, 201);
    }

    if (path === "/v1/auth/device" && method === "GET") {
      const deviceId = String(url.searchParams.get("device_id") || "").trim().slice(0, 128);
      if (!deviceId) return json({ error: "Device ID is required" }, 400);
      const context = await loadDeviceContext(env, businessId, deviceId);
      if (!context) return json({ error: "Device not found" }, 404);
      return json(context);
    }

    if (path === "/v1/auth/users" && method === "GET") {
      const deviceId = String(url.searchParams.get("device_id") || "").trim().slice(0, 128);
      const context = deviceId ? await loadDeviceContext(env, businessId, deviceId) : null;
      if (!context || context.device.status !== "active" || Number(context.business.active) !== 1) return json({ error: "This device is not registered" }, 403);
      const result = await env.DB.prepare(`
        SELECT u.display_name AS displayName, u.username, p.name AS profileName,
          u.is_blocked AS isBlocked
        FROM app_users u
        LEFT JOIN access_profiles p ON p.id = u.profile_id AND p.business_id = u.business_id
        WHERE u.business_id = ? AND u.active = 1
        ORDER BY u.is_owner DESC, lower(u.display_name), lower(u.username)
      `).bind(businessId).all();
      return json({ users: result.results || [] });
    }

    if (path === "/v1/auth/login-user" && method === "POST") {
      const parsed = await readBody(request);
      if (parsed.error) return json({ error: parsed.error }, parsed.status);
      const username = String(parsed.body.username || "").trim().toLowerCase().slice(0, 100);
      const deviceId = String(parsed.body.deviceId || "").trim().slice(0, 128);
      const context = deviceId ? await loadDeviceContext(env, businessId, deviceId) : null;
      if (!context || context.device.status !== "active" || Number(context.business.active) !== 1) return json({ error: "This device is not registered", code: "DEVICE_NOT_REGISTERED" }, 403);
      const user = await env.DB.prepare(`
        SELECT u.id, u.display_name, u.username, u.profile_id, u.business_id, u.active,
          u.password_hash, u.permissions_override, u.is_owner, u.failed_login_attempts, u.is_blocked,
          b.business_code, b.business_name, b.business_type, b.owner_name, b.phone AS business_phone,
          b.email AS business_email, b.address AS business_address, b.city, b.state, b.gstin,
          b.logo_url, b.currency, b.active AS business_active,
          p.name AS profile_name, COALESCE(u.permissions_override, p.permissions, '{}') AS permissions
        FROM app_users u
        LEFT JOIN businesses b ON b.id = u.business_id
        LEFT JOIN access_profiles p ON p.id = u.profile_id AND p.business_id = u.business_id
        WHERE u.business_id = ? AND lower(u.username) = ? LIMIT 1
      `).bind(businessId, username).first();
      if (!user) return json({ user: null, device: context.device, license: context.license });
      return json({ user: { ...user, active: Boolean(user.active), is_owner: Boolean(user.is_owner), is_blocked: Boolean(user.is_blocked), permissions: parseObject(user.permissions, {}) }, device: context.device, license: context.license });
    }

    if (path === "/v1/auth/login-failure" && method === "POST") {
      const parsed = await readBody(request);
      if (parsed.error) return json({ error: parsed.error }, parsed.status);
      const userId = Number(parsed.body.userId);
      if (!Number.isSafeInteger(userId) || userId <= 0) return json({ error: "Invalid user ID" }, 400);
      const updated = await env.DB.prepare(`
        UPDATE app_users SET failed_login_attempts = failed_login_attempts + 1,
          is_blocked = CASE WHEN failed_login_attempts + 1 >= 5 THEN 1 ELSE 0 END,
          blocked_at = CASE WHEN failed_login_attempts + 1 >= 5 THEN COALESCE(blocked_at, CURRENT_TIMESTAMP) ELSE blocked_at END,
          blocked_by_user_id = NULL, blocked_by_support_user_id = NULL,
          block_reason = CASE WHEN failed_login_attempts + 1 >= 5 THEN 'failed_attempts' ELSE block_reason END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND business_id = ? AND active = 1 AND is_blocked = 0
        RETURNING failed_login_attempts, is_blocked
      `).bind(userId, businessId).first();
      if (!updated) return json({ blocked: false, failedAttempts: 0 });
      if (Boolean(updated.is_blocked)) await env.DB.prepare("DELETE FROM app_sessions WHERE user_id = ? AND business_id = ?").bind(userId, businessId).run();
      return json({ blocked: Boolean(updated.is_blocked), failedAttempts: Number(updated.failed_login_attempts || 0) });
    }

    if (path === "/v1/auth/login-failures" && method === "DELETE") {
      const identityKey = String(url.searchParams.get("identity_key") || "");
      if (!/^[a-f0-9]{64}$/i.test(identityKey)) return json({ error: "Invalid login identity" }, 400);
      await env.DB.prepare("DELETE FROM auth_login_attempts WHERE identity_key = ?").bind(identityKey).run();
      return json({ success: true });
    }

    if (path === "/v1/auth/session" && method === "POST") {
      const parsed = await readBody(request);
      if (parsed.error) return json({ error: parsed.error }, parsed.status);
      const userId = Number(parsed.body.userId);
      const tokenHash = String(parsed.body.tokenHash || "");
      const deviceId = String(parsed.body.deviceId || "").trim().slice(0, 128);
      const expiresAt = String(parsed.body.expiresAt || "");
      if (!Number.isSafeInteger(userId) || userId <= 0 || !/^[a-f0-9]{64}$/i.test(tokenHash) || !Number.isFinite(Date.parse(expiresAt))) return json({ error: "Invalid session details" }, 400);
      const context = deviceId ? await loadDeviceContext(env, businessId, deviceId) : null;
      if (!context || context.device.status !== "active" || Number(context.business.active) !== 1) return json({ error: "Device registration is not active", code: "DEVICE_REVOKED" }, 403);
      if (!context.license) return json({ error: "No license is assigned to this business", code: "LICENSE_MISSING" }, 403);
      const license = context.license;
      if (license.status !== "active") return json({ error: "Business license is " + license.status, code: "LICENSE_INACTIVE" }, 403);
      if (Date.parse(license.starts_at) > Date.now()) return json({ error: "Business license has not started yet", code: "LICENSE_NOT_STARTED" }, 403);
      if (Date.parse(license.expires_at) < Date.now()) return json({ error: "Business license has expired", code: "LICENSE_EXPIRED" }, 403);
      const eligible = await env.DB.prepare("SELECT id FROM app_users WHERE id = ? AND business_id = ? AND active = 1 AND is_blocked = 0 LIMIT 1").bind(userId, businessId).first();
      if (!eligible) return json({ error: "This account is blocked or inactive", code: "ACCOUNT_INACTIVE" }, 423);
      await env.DB.batch([
        env.DB.prepare("UPDATE app_users SET failed_login_attempts = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?").bind(userId, businessId),
        env.DB.prepare("DELETE FROM app_sessions WHERE user_id = ? AND business_id = ?").bind(userId, businessId),
        env.DB.prepare("INSERT INTO app_sessions (token, token_hash, user_id, business_id, device_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(tokenHash, tokenHash, userId, businessId, deviceId, new Date(Date.parse(expiresAt)).toISOString()),
      ]);
      await env.DB.prepare("UPDATE registered_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE business_id = ? AND device_id = ?").bind(businessId, deviceId).run();
      return json({ success: true });
    }

    if (path === "/v1/auth/session" && method === "GET") {
      const tokenHash = String(url.searchParams.get("token_hash") || "");
      if (!/^[a-f0-9]{64}$/i.test(tokenHash)) return json({ error: "Invalid session" }, 400);
      const row = await env.DB.prepare(`
        SELECT s.token_hash, s.user_id, s.business_id, s.device_id, s.expires_at,
          u.id, u.display_name, u.username, u.profile_id, u.active, u.is_blocked,
          u.permissions_override, u.is_owner, b.business_name, b.business_type, b.owner_name,
          b.phone AS business_phone, b.email AS business_email, b.address AS business_address,
          b.city, b.state, b.gstin, b.currency, b.active AS business_active,
          p.name AS profile_name, COALESCE(u.permissions_override, p.permissions, '{}') AS permissions
        FROM app_sessions s
        JOIN app_users u ON u.id = s.user_id AND u.business_id = s.business_id
        JOIN businesses b ON b.id = s.business_id
        LEFT JOIN access_profiles p ON p.id = u.profile_id AND p.business_id = u.business_id
        WHERE s.business_id = ? AND s.token_hash = ? LIMIT 1
      `).bind(businessId, tokenHash).first();
      if (!row) return json({ error: "Authentication required" }, 404);
      const context = await loadDeviceContext(env, businessId, row.device_id);
      if (Date.parse(row.expires_at) <= Date.now()) {
        await env.DB.prepare("DELETE FROM app_sessions WHERE business_id = ? AND token_hash = ?").bind(businessId, tokenHash).run();
        return json({ error: "Authentication required" }, 401);
      }
      if (!Boolean(row.active) || Boolean(row.is_blocked)) return json({ error: "This account is blocked or inactive", code: "ACCOUNT_INACTIVE" }, 401);
      if (Number(row.business_active) !== 1) return json({ error: "Business account is inactive", code: "BUSINESS_INACTIVE" }, 403);
      if (!context || context.device.status !== "active") return json({ error: "Device registration has been revoked", code: "DEVICE_REVOKED" }, 403);
      if (!context.license) return json({ error: "No license is assigned to this business", code: "LICENSE_MISSING" }, 403);
      if (context.license.status !== "active") return json({ error: "Business license is " + context.license.status, code: "LICENSE_INACTIVE" }, 403);
      if (Date.parse(context.license.starts_at) > Date.now()) return json({ error: "Business license has not started yet", code: "LICENSE_NOT_STARTED" }, 403);
      if (Date.parse(context.license.expires_at) < Date.now()) return json({ error: "Business license has expired", code: "LICENSE_EXPIRED" }, 403);
      await env.DB.prepare("UPDATE registered_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE business_id = ? AND device_id = ? AND (last_seen_at IS NULL OR datetime(last_seen_at) < datetime('now', '-1 minute'))").bind(businessId, row.device_id).run();
      const user = {
        id: row.id, display_name: row.display_name, username: row.username, profile_id: row.profile_id,
        business_id: businessId, active: Boolean(row.active), is_blocked: Boolean(row.is_blocked),
        permissions_override: parseObject(row.permissions_override, null), is_owner: Boolean(row.is_owner),
        business_name: row.business_name, business_type: row.business_type, owner_name: row.owner_name,
        business_phone: row.business_phone, business_email: row.business_email, business_address: row.business_address,
        city: row.city, state: row.state, gstin: row.gstin, currency: row.currency,
        business_active: Boolean(row.business_active), profile_name: row.profile_name,
        permissions: parseObject(row.permissions, {}),
      };
      return json({ token_hash: tokenHash, user_id: Number(row.user_id), business_id: businessId, device_id: row.device_id,
        expires_at: row.expires_at, user, device: context.device, license: context.license });
    }

    if (path === "/v1/auth/session" && method === "DELETE") {
      const tokenHash = String(url.searchParams.get("token_hash") || "");
      if (!/^[a-f0-9]{64}$/i.test(tokenHash)) return json({ error: "Invalid session" }, 400);
      await env.DB.prepare("DELETE FROM app_sessions WHERE business_id = ? AND token_hash = ?").bind(businessId, tokenHash).run();
      return json({ success: true });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message || ""))) {
      if (path === "/v1/auth/register-device") return json({ error: "This device is already registered to a business." }, 409);
      return json({ error: "That account name is already in use" }, 409);
    }
    console.error("D1 auth request failed", { businessId, path, name: error?.name || "Error", message: String(error?.message || "").slice(0, 300) });
    return json({ error: "D1 authentication request failed" }, 500);
  }
}

async function handlePublicD1Auth(request, env, claims, path, url, configuredBusinessIds) {
  const method = request.method.toUpperCase();
  const requiredScope = authPathScope(path, method);
  if (!requiredScope || claims.sub !== 0 || Number(claims.business_id) !== 0 || claims.scope !== requiredScope) {
    return json({ error: "Unauthorized public D1 onboarding request" }, 403);
  }

  if (path === "/v1/auth/public/register-business" && method === "POST") {
    if (String(env.D1_PUBLIC_REGISTRATION_ENABLED || "").toLowerCase() !== "true") return json({ error: "D1 business registration is disabled" }, 404);
    return createBusinessInD1(request, env);
  }

  if (path === "/v1/auth/public/business-enabled" && method === "GET") {
    const businessId = Number(url.searchParams.get("target_business_id"));
    if (!Number.isSafeInteger(businessId) || businessId <= 0) return json({ error: "A valid business ID is required" }, 400);
    return json({ enabled: await isBusinessEnabled(env, businessId, configuredBusinessIds) });
  }

  if (path === "/v1/auth/public/device" && method === "GET") {
    const deviceId = String(url.searchParams.get("device_id") || "").trim().slice(0, 128);
    if (!deviceId) return json({ error: "Device ID is required" }, 400);
    const row = await env.DB.prepare("SELECT business_id FROM registered_devices WHERE device_id = ? AND status = 'active' LIMIT 1").bind(deviceId).first();
    const businessId = Number(row?.business_id || 0);
    if (!businessId || !(await isBusinessEnabled(env, businessId, configuredBusinessIds))) return json({ error: "Device not found" }, 404);
    const context = await loadDeviceContext(env, businessId, deviceId);
    return context ? json({ ...context, businessId }) : json({ error: "Device not found" }, 404);
  }

  if (path === "/v1/auth/public/register-device" && method === "POST") {
    const parsed = await readBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const keyHash = String(parsed.body.keyHash || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(keyHash)) return json({ error: "Invalid registration key" }, 400);
    const key = await env.DB.prepare("SELECT business_id FROM device_registration_keys WHERE key_hash = ? LIMIT 1").bind(keyHash).first();
    const businessId = Number(key?.business_id || 0);
    if (!businessId || !(await isBusinessEnabled(env, businessId, configuredBusinessIds))) return json({ error: "Invalid registration key" }, 404);
    const scopedClaims = { ...claims, business_id: businessId, scope: "auth.device.register" };
    const scopedUrl = new URL(request.url);
    scopedUrl.pathname = "/v1/auth/register-device";
    scopedUrl.search = `?business_id=${businessId}`;
    const scopedRequest = new Request(scopedUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed.body),
    });
    return handleAuthService(scopedRequest, env, businessId, scopedClaims, "/v1/auth/register-device", scopedUrl);
  }

  if (path === "/v1/auth/public/session" && ["GET", "DELETE"].includes(method)) {
    const tokenHash = String(url.searchParams.get("token_hash") || "");
    if (!/^[a-f0-9]{64}$/i.test(tokenHash)) return json({ error: "Invalid session" }, 400);
    const row = await env.DB.prepare("SELECT business_id FROM app_sessions WHERE token_hash = ? LIMIT 1").bind(tokenHash).first();
    const businessId = Number(row?.business_id || 0);
    if (!businessId || !(await isBusinessEnabled(env, businessId, configuredBusinessIds))) return json({ error: "Authentication required" }, 404);
    const scopedClaims = { ...claims, business_id: businessId, scope: method === "GET" ? "auth.session.read" : "auth.session.write" };
    const scopedUrl = new URL(request.url);
    scopedUrl.pathname = "/v1/auth/session";
    scopedUrl.search = `?business_id=${businessId}&token_hash=${encodeURIComponent(tokenHash)}`;
    return handleAuthService(new Request(scopedUrl, { method }), env, businessId, scopedClaims, "/v1/auth/session", scopedUrl);
  }

  return json({ error: "Not found" }, 404);
}

async function createBusinessInD1(request, env) {
  let parsed;
  try {
    const raw = await request.text();
    if (raw.length > 65536) return json({ error: "Registration request is too large" }, 413);
    parsed = JSON.parse(raw || "{}");
  } catch {
    return json({ error: "Invalid registration request" }, 400);
  }
  const businessInput = parsed.business && typeof parsed.business === "object" ? parsed.business : {};
  const businessName = String(businessInput.businessName || "").trim();
  const businessType = String(businessInput.businessType || "Cafe").trim() || "Cafe";
  const ownerName = String(businessInput.ownerName || "").trim();
  const username = String(parsed.username || "").trim().toLowerCase();
  const ownerPasswordHash = String(parsed.ownerPasswordHash || "");
  const slashOpsPasswordHash = String(parsed.slashOpsPasswordHash || "");
  const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
  const keyHash = String(parsed.keyHash || "").trim().toLowerCase();
  const keyHint = String(parsed.keyHint || "").trim().slice(0, 20);
  const keyExpiresAt = String(parsed.keyExpiresAt || "").trim();
  const maxDevices = Math.max(1, Math.min(1000, Math.floor(Number(parsed.maxDevices) || 1)));
  const code = String(parsed.businessCode || "").trim();
  const textField = (name, max) => String(businessInput[name] || "").trim().slice(0, max) || null;
  const email = textField("email", 180);
  const logoUrl = textField("logoUrl", 2048);
  const expiresMs = Date.parse(keyExpiresAt);
  if (!businessName || businessName.length > 200 || !ownerName || ownerName.length > 150 || businessType.length > 80
      || !/^[a-z0-9._-]{3,100}$/.test(username) || !/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(ownerPasswordHash)
      || !/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(slashOpsPasswordHash) || !/^[a-f0-9]{64}$/.test(keyHash)
      || !keyHint || !Number.isFinite(expiresMs) || expiresMs <= Date.now() || !code || code.length > 100
      || profiles.length !== 4 || !["admin", "slash ops", "manager", "cashier"].every(name => profiles.some(profile => String(profile?.name || "").trim().toLowerCase() === name))) {
    return json({ error: "Business registration details are incomplete or invalid" }, 400);
  }
  if (email && email.length > 180) return json({ error: "Email address is too long" }, 400);
  if (logoUrl && !/^https:\/\//i.test(logoUrl)) return json({ error: "Choose a valid HTTPS logo URL" }, 400);
  const permissionsFor = name => {
    const profile = profiles.find(entry => String(entry?.name || "").trim().toLowerCase() === name);
    const permissions = profile?.permissions;
    if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return null;
    const entries = Object.entries(permissions);
    if (entries.length > 500 || entries.some(([key, value]) => !/^[a-zA-Z0-9._-]{1,120}$/.test(key) || typeof value !== "boolean")) return null;
    return { description: String(profile.description || "").trim().slice(0, 200), permissions };
  };
  const normalizedProfiles = ["slash ops", "admin", "manager", "cashier"].map(name => ({ name, ...permissionsFor(name) }));
  if (normalizedProfiles.some(profile => !profile.permissions)) return json({ error: "Invalid access profile setup" }, 400);
  const now = new Date();
  const trialExpires = new Date(now);
  trialExpires.setUTCMonth(trialExpires.getUTCMonth() + 1);
  let business;
  try {
    business = await env.DB.prepare(`INSERT INTO businesses (
      business_code,business_name,business_type,owner_name,phone,email,address,city,state,gstin,logo_url,currency,active
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1) RETURNING id,business_code,business_name,business_type,owner_name,phone,email,address,city,state,gstin,logo_url,currency,active,created_at,updated_at`)
      .bind(code, businessName, businessType, ownerName, textField("phone", 40), email, textField("address", 2000),
        textField("city", 100), textField("state", 100), textField("gstin", 40), logoUrl, textField("currency", 10) || "₹").first();
    if (!business) return json({ error: "Could not create business profile" }, 500);
    const statements = [
      env.DB.prepare("INSERT INTO d1_onboarded_businesses (business_id) VALUES (?)").bind(business.id),
      ...normalizedProfiles.map(profile => env.DB.prepare("INSERT INTO access_profiles (name,business_id,description,permissions) VALUES (?,?,?,?)").bind(profile.name, business.id, profile.description, JSON.stringify(profile.permissions))),
      env.DB.prepare(`INSERT INTO app_users (display_name,username,password_hash,profile_id,business_id,active,permissions_override,is_owner)
        SELECT ?,?,?,id,?,1,NULL,1 FROM access_profiles WHERE business_id = ? AND lower(name) = 'admin' LIMIT 1`)
        .bind(ownerName, username, ownerPasswordHash, business.id, business.id),
      env.DB.prepare(`INSERT INTO app_users (display_name,username,password_hash,profile_id,business_id,active,permissions_override,is_owner)
        SELECT 'Slash ops',?,?,id,?,1,NULL,0 FROM access_profiles WHERE business_id = ? AND lower(name) = 'slash ops' LIMIT 1`)
        .bind(`slashops-${business.id}`, slashOpsPasswordHash, business.id, business.id),
      env.DB.prepare(`INSERT INTO business_licenses (business_id,plan,status,starts_at,expires_at,max_devices,notes,license_type,duration_months)
        VALUES (?,'Trial','active',?,?,?,'Automatically created trial license','Trial',1)`)
        .bind(business.id, now.toISOString(), trialExpires.toISOString(), maxDevices),
      env.DB.prepare(`INSERT INTO device_registration_keys (business_id,license_id,key_hash,key_hint,device_name,status,created_by_type,expires_at)
        SELECT ?,id,?,?,?,'unused','system',? FROM business_licenses WHERE business_id = ? ORDER BY id DESC LIMIT 1`)
        .bind(business.id, keyHash, keyHint, String(parsed.deviceName || "Initial Device").trim().slice(0, 160) || "Initial Device", keyExpiresAt, business.id),
      env.DB.prepare("INSERT INTO kot_groups (name,description,station,sort_order,active,business_id) VALUES ('Main Kitchen','Default KOT group','Kitchen',0,1,?)").bind(business.id),
      ...["Purchase / Supplies", "Staff / Salary", "Rent", "Utilities", "Marketing", "Maintenance", "Delivery / Logistics", "Other"]
        .map(name => env.DB.prepare("INSERT INTO expense_categories (name,business_id) VALUES (?,?)").bind(name, business.id)),
    ];
    await env.DB.batch(statements);
    const [user, license, registrationKey] = await Promise.all([
      env.DB.prepare("SELECT u.id,u.display_name,u.username,u.profile_id,u.business_id,u.active FROM app_users u WHERE u.business_id = ? AND lower(u.username) = ? LIMIT 1").bind(business.id, username).first(),
      env.DB.prepare("SELECT * FROM business_licenses WHERE business_id = ? ORDER BY id DESC LIMIT 1").bind(business.id).first(),
      env.DB.prepare("SELECT id,business_id,license_id,key_hint,device_name,status,expires_at,created_at FROM device_registration_keys WHERE business_id = ? AND key_hash = ? LIMIT 1").bind(business.id, keyHash).first(),
    ]);
    if (!user || !license || !registrationKey) throw new Error("Business setup did not finish");
    return json({ success: true, business: { ...business, active: Boolean(business.active) }, user: { ...user, active: Boolean(user.active) }, license }, 201);
  } catch (error) {
    if (business?.id) await env.DB.prepare("DELETE FROM businesses WHERE id = ?").bind(business.id).run().catch(() => {});
    const message = String(error?.message || "");
    if (/UNIQUE constraint failed/i.test(message)) return json({ error: /username/i.test(message) ? "Username already exists" : "Business registration details already exist" }, 409);
    console.error("D1 business registration failed", { name: error?.name || "Error", message: message.slice(0, 240) });
    return json({ error: "Could not create business profile" }, 500);
  }
}

async function isBusinessEnabled(env, businessId, configuredBusinessIds) {
  const id = Number(businessId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  if (configuredBusinessIds.has(id)) return true;
  try {
    const row = await env.DB.prepare(`SELECT 1 AS enabled FROM d1_onboarded_businesses o
      JOIN businesses b ON b.id = o.business_id AND b.active = 1 WHERE o.business_id = ? LIMIT 1`).bind(id).first();
    return Boolean(row?.enabled);
  } catch {
    return false;
  }
}

async function accessActor(env, businessId, claims) {
  if (!Number.isSafeInteger(Number(claims.sub)) || Number(claims.sub) <= 0 || Number(claims.business_id) !== businessId) return null;
  return env.DB.prepare(`
    SELECT u.id, u.profile_id, u.active, u.is_blocked, u.is_owner, p.name AS profile_name
    FROM app_users u LEFT JOIN access_profiles p ON p.id = u.profile_id AND p.business_id = u.business_id
    WHERE u.id = ? AND u.business_id = ? LIMIT 1
  `).bind(Number(claims.sub), businessId).first();
}

async function handleD1Access(request, env, businessId, claims, path) {
  const method = request.method.toUpperCase();
  const requiredScope = accessPathScope(path, method);
  if (!requiredScope || claims.scope !== requiredScope || Number(claims.business_id) !== businessId) return json({ error: "Access request is not authorized" }, 403);
  try {
    const actor = await accessActor(env, businessId, claims);
    if (!actor || !Boolean(actor.active) || Boolean(actor.is_blocked)) return json({ error: "Access is unavailable for this account" }, 403);
    const actorName = String(actor.profile_name || "");
    const slashOps = actorName.trim().toLowerCase() === "slash ops";
    const parsed = ["POST", "PUT", "PATCH"].includes(method) ? await readBody(request) : { body: {} };
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const body = parsed.body;

    if (path === "/v1/pos/access" && method === "GET") {
      const [users, profiles] = await Promise.all([
        env.DB.prepare(`
          SELECT u.id, u.display_name, u.username, u.profile_id, u.active, u.is_blocked,
            u.blocked_at, u.block_reason, u.failed_login_attempts, u.created_at,
            p.name AS profile_name
          FROM app_users u LEFT JOIN access_profiles p ON p.id = u.profile_id AND p.business_id = u.business_id
          WHERE u.business_id = ? ORDER BY u.id
        `).bind(businessId).all(),
        env.DB.prepare("SELECT id, name, description, permissions, created_at, updated_at FROM access_profiles WHERE business_id = ? ORDER BY name").bind(businessId).all(),
      ]);
      const manageable = (profiles.results || []).filter((profile) => canManageRole(actorName, profile.name));
      return json({
        users: (users.results || []).map((user) => ({ ...user, active: Boolean(user.active), is_blocked: Boolean(user.is_blocked), can_manage: Number(user.id) !== Number(actor.id) && canManageRole(actorName, user.profile_name) })),
        profiles: manageable.map((profile) => {
          const builtIn = BUILT_IN_ACCESS_PROFILES.has(String(profile.name || "").trim().toLowerCase());
          return { ...publicProfile(profile), can_assign: true, can_edit: true, can_edit_identity: slashOps && !builtIn, can_delete: slashOps && !builtIn, is_built_in: builtIn };
        }),
        currentProfileName: actorName,
        canManageProfiles: manageable.length > 0,
        canCreateProfiles: slashOps,
      });
    }
    if (path === "/v1/pos/access/users" && method === "GET") {
      const result = await env.DB.prepare(`
        SELECT u.id, u.display_name, u.username, u.profile_id, u.active, u.is_blocked,
          u.blocked_at, u.block_reason, u.failed_login_attempts, u.created_at,
          p.name AS profile_name
        FROM app_users u LEFT JOIN access_profiles p ON p.id = u.profile_id AND p.business_id = u.business_id
        WHERE u.business_id = ? ORDER BY u.id
      `).bind(businessId).all();
      return json((result.results || []).map((user) => ({ ...user, active: Boolean(user.active), is_blocked: Boolean(user.is_blocked) })));
    }
    if (path === "/v1/pos/access/profiles" && method === "GET") {
      const result = await env.DB.prepare("SELECT id, name, description, permissions, created_at, updated_at FROM access_profiles WHERE business_id = ? ORDER BY name").bind(businessId).all();
      return json((result.results || []).filter((profile) => canManageRole(actorName, profile.name)).map(publicProfile));
    }

    if (path === "/v1/pos/access/profiles" && method === "POST") {
      if (!slashOps) return json({ error: "Only Slash ops can manage access profiles" }, 403);
      const name = String(body.name || "").trim().slice(0, 80);
      const description = String(body.description || "").trim().slice(0, 500);
      const permissions = body.permissions && typeof body.permissions === "object" ? body.permissions : {};
      if (!name) return json({ error: "Profile name is required" }, 400);
      if (BUILT_IN_ACCESS_PROFILES.has(name.toLowerCase())) return json({ error: "That name is reserved for a built-in access profile" }, 400);
      const created = await env.DB.prepare("INSERT INTO access_profiles (name, business_id, description, permissions) VALUES (?, ?, ?, ?) RETURNING id, name, description, permissions, created_at, updated_at")
        .bind(name, businessId, description || null, JSON.stringify(permissions)).first();
      return json({ success: true, profile: publicProfile(created) }, 201);
    }

    const profileId = accessId(path, "profiles");
    if (profileId && method === "PUT") {
      const old = await env.DB.prepare("SELECT id, name, description, permissions FROM access_profiles WHERE id = ? AND business_id = ? LIMIT 1").bind(profileId, businessId).first();
      if (!old) return json({ error: "Access profile not found" }, 404);
      if (!canManageRole(actorName, old.name)) return json({ error: "You can only change permissions for profiles below your access level" }, 403);
      const builtIn = BUILT_IN_ACCESS_PROFILES.has(String(old.name || "").trim().toLowerCase());
      if (!builtIn && !slashOps) return json({ error: "Only Slash ops can edit custom access profiles" }, 403);
      const name = builtIn ? old.name : String(body.name ?? old.name).trim().slice(0, 80);
      const description = builtIn ? (old.description || "") : String(body.description ?? old.description ?? "").trim().slice(0, 500);
      const permissions = body.permissions && typeof body.permissions === "object" ? body.permissions : parseObject(old.permissions, {});
      if (!name) return json({ error: "Profile name is required" }, 400);
      if (!builtIn && BUILT_IN_ACCESS_PROFILES.has(name.toLowerCase())) return json({ error: `${name} is a reserved built-in profile name` }, 400);
      const own = await env.DB.prepare("SELECT 1 AS found FROM app_users WHERE id = ? AND business_id = ? AND profile_id = ? LIMIT 1").bind(Number(actor.id), businessId, profileId).first();
      if (own) return json({ error: "You cannot edit the access profile assigned to your own account" }, 403);
      const updated = await env.DB.prepare("UPDATE access_profiles SET name = ?, description = ?, permissions = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ? RETURNING id, name, description, permissions, created_at, updated_at")
        .bind(name, description || null, JSON.stringify(permissions), profileId, businessId).first();
      return json({ success: true, profile: publicProfile(updated) });
    }
    if (profileId && method === "DELETE") {
      if (!slashOps) return json({ error: "Only Slash ops can manage access profiles" }, 403);
      const profile = await env.DB.prepare("SELECT name FROM access_profiles WHERE id = ? AND business_id = ? LIMIT 1").bind(profileId, businessId).first();
      if (!profile) return json({ error: "Access profile not found" }, 404);
      if (BUILT_IN_ACCESS_PROFILES.has(String(profile.name || "").toLowerCase())) return json({ error: "Built-in access profiles cannot be deleted" }, 400);
      await env.DB.prepare("DELETE FROM access_profiles WHERE id = ? AND business_id = ?").bind(profileId, businessId).run();
      return json({ success: true });
    }

    if (path === "/v1/pos/access/users" && method === "POST") {
      const displayName = String(body.displayName || "").trim().slice(0, 150);
      const username = String(body.username || "").trim().toLowerCase().slice(0, 100);
      const passwordHash = String(body.passwordHash || "");
      const profileId = Number(body.profileId);
      const active = body.active !== false;
      if (!displayName || !username) return json({ error: "Display name and username are required" }, 400);
      if (!/^[a-z0-9._-]{1,100}$/.test(username)) return json({ error: "Username may contain only letters, numbers, dot, underscore and hyphen" }, 400);
      if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(passwordHash)) return json({ error: "A valid password hash is required" }, 400);
      if (!Number.isSafeInteger(profileId) || profileId <= 0) return json({ error: "Choose an access profile for the new user" }, 400);
      const profile = await env.DB.prepare("SELECT id, name FROM access_profiles WHERE id = ? AND business_id = ? LIMIT 1").bind(profileId, businessId).first();
      if (!profile) return json({ error: "Invalid access profile" }, 400);
      if (!canManageRole(actorName, profile.name)) return json({ error: "You can only create users with a lower access level than yours" }, 403);
      if (profile.name.toLowerCase() === "slash ops" && !slashOps) return json({ error: "Only Slash ops can create a Slash ops account" }, 403);
      const created = await env.DB.prepare(`
        INSERT INTO app_users (display_name, username, password_hash, profile_id, business_id, active)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING id, display_name, username, profile_id, business_id, active, created_at, updated_at
      `).bind(displayName, username, passwordHash, profileId, businessId, active ? 1 : 0).first();
      return json({ success: true, user: { ...created, active: Boolean(created.active) } }, 201);
    }

    const userId = accessId(path, "users");
    const blockMatch = path.match(/^\/v1\/pos\/access\/users\/(\d+)\/block$/);
    const blockUserId = Number(blockMatch?.[1]);
    if (blockUserId && method === "PATCH") {
      const blocked = body.blocked;
      if (typeof blocked !== "boolean") return json({ error: "Choose whether to block or unblock this user" }, 400);
      if (blockUserId === Number(actor.id)) return json({ error: "You cannot block or unblock your own account" }, 403);
      const current = await env.DB.prepare(`
        SELECT u.id, u.username, u.is_owner, p.name AS profile_name
        FROM app_users u LEFT JOIN access_profiles p ON p.id = u.profile_id AND p.business_id = u.business_id
        WHERE u.id = ? AND u.business_id = ? LIMIT 1
      `).bind(blockUserId, businessId).first();
      if (!current) return json({ error: "User not found" }, 404);
      if (!canManageRole(actorName, current.profile_name)) return json({ error: "Only a user above this account's role can block or unblock it" }, 403);
      if (Boolean(current.is_owner) && !slashOps) return json({ error: "The business owner account cannot be blocked from Access management" }, 403);
      const updated = await env.DB.prepare(`
        UPDATE app_users SET is_blocked = ?, failed_login_attempts = CASE WHEN ? = 1 THEN failed_login_attempts ELSE 0 END,
          blocked_at = CASE WHEN ? = 1 THEN COALESCE(blocked_at, CURRENT_TIMESTAMP) ELSE NULL END,
          blocked_by_user_id = CASE WHEN ? = 1 THEN ? ELSE NULL END, blocked_by_support_user_id = NULL,
          block_reason = CASE WHEN ? = 1 THEN 'manual' ELSE NULL END, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND business_id = ?
        RETURNING id, username, is_blocked, blocked_at, block_reason, failed_login_attempts
      `).bind(blocked ? 1 : 0, blocked ? 1 : 0, blocked ? 1 : 0, blocked ? 1 : 0, actor.id, blocked ? 1 : 0, blockUserId, businessId).first();
       if (blocked) await env.DB.prepare("DELETE FROM app_sessions WHERE user_id = ? AND business_id = ?").bind(blockUserId, businessId).run();
       else {
         const key = await loginIdentityKey(businessId, current.username);
         await env.DB.prepare("DELETE FROM auth_login_attempts WHERE identity_key = ?").bind(key).run();
       }
      return json({ success: true, user: { ...updated, is_blocked: Boolean(updated.is_blocked) } });
    }

    if (userId && method === "PUT") {
      if (userId === Number(actor.id)) return json({ error: "You cannot edit your own account from Access management" }, 403);
      const old = await env.DB.prepare("SELECT * FROM app_users WHERE id = ? AND business_id = ? LIMIT 1").bind(userId, businessId).first();
      if (!old) return json({ error: "User not found" }, 404);
      const oldProfile = await env.DB.prepare("SELECT name FROM access_profiles WHERE id = ? AND business_id = ? LIMIT 1").bind(Number(old.profile_id), businessId).first();
      if (!canManageRole(actorName, oldProfile?.name)) return json({ error: "You can only edit users below your access level" }, 403);
      const displayName = body.displayName === undefined ? old.display_name : String(body.displayName).trim().slice(0, 150);
      const username = body.username === undefined ? old.username : String(body.username).trim().toLowerCase().slice(0, 100);
      const profileId = body.profileId === undefined ? Number(old.profile_id) : Number(body.profileId);
      const active = body.active === undefined ? Boolean(old.active) : body.active === true;
      const passwordHash = String(body.passwordHash || "");
      if (!displayName || !username) return json({ error: "Display name and username are required" }, 400);
      if (!/^[a-z0-9._-]{1,100}$/.test(username)) return json({ error: "Username may contain only letters, numbers, dot, underscore and hyphen" }, 400);
      if (!Number.isSafeInteger(profileId) || profileId <= 0) return json({ error: "Choose a valid access profile for this user" }, 400);
      if (passwordHash && !/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(passwordHash)) return json({ error: "Invalid password hash" }, 400);
      const targetProfile = await env.DB.prepare("SELECT id, name FROM access_profiles WHERE id = ? AND business_id = ? LIMIT 1").bind(profileId, businessId).first();
      if (!targetProfile) return json({ error: "Invalid access profile" }, 400);
      if (!canManageRole(actorName, targetProfile.name)) return json({ error: "You can only assign a lower access level than yours" }, 403);
      const identityChanged = username !== old.username;
      const query = passwordHash
        ? "UPDATE app_users SET display_name = ?, username = ?, password_hash = ?, profile_id = ?, active = ?, permissions_override = NULL, is_owner = CASE WHEN ? <> ? THEN 0 ELSE is_owner END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ? RETURNING id, display_name, username, profile_id, business_id, active, created_at, updated_at"
        : "UPDATE app_users SET display_name = ?, username = ?, profile_id = ?, active = ?, permissions_override = NULL, is_owner = CASE WHEN ? <> ? THEN 0 ELSE is_owner END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ? RETURNING id, display_name, username, profile_id, business_id, active, created_at, updated_at";
      const params = passwordHash
        ? [displayName, username, passwordHash, profileId, active ? 1 : 0, profileId, Number(old.profile_id), userId, businessId]
        : [displayName, username, profileId, active ? 1 : 0, profileId, Number(old.profile_id), userId, businessId];
      const updated = await env.DB.prepare(query).bind(...params).first();
      if (passwordHash || !active || identityChanged) await env.DB.prepare("DELETE FROM app_sessions WHERE user_id = ? AND business_id = ?").bind(userId, businessId).run();
      if (passwordHash || identityChanged) {
         const keys = new Set([
           await loginIdentityKey(businessId, old.username),
           await loginIdentityKey(businessId, username),
         ]);
         for (const key of keys) await env.DB.prepare("DELETE FROM auth_login_attempts WHERE identity_key = ?").bind(key).run();
      }
      return json({ success: true, user: { ...updated, active: Boolean(updated.active) } });
    }

    if (userId && method === "DELETE") {
      if (userId === Number(actor.id)) return json({ error: "You cannot delete your own account" }, 403);
      const target = await env.DB.prepare(`
        SELECT u.id, u.username, p.name AS profile_name FROM app_users u
        LEFT JOIN access_profiles p ON p.id = u.profile_id AND p.business_id = u.business_id
        WHERE u.id = ? AND u.business_id = ? LIMIT 1
      `).bind(userId, businessId).first();
      if (!target) return json({ error: "User not found" }, 404);
      if (!canManageRole(actorName, target.profile_name)) return json({ error: "You can only delete users below your access level" }, 403);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM app_sessions WHERE user_id = ? AND business_id = ?").bind(userId, businessId),
        env.DB.prepare("DELETE FROM app_users WHERE id = ? AND business_id = ?").bind(userId, businessId),
      ]);
      return json({ success: true });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    const message = String(error?.message || "");
    if (/UNIQUE constraint failed/i.test(message)) return json({ error: "A user or access profile with that name already exists" }, 409);
    console.error("D1 access request failed", { businessId, path, name: error?.name || "Error", message: message.slice(0, 300) });
    return json({ error: "D1 access request failed" }, 500);
  }
}

export { AUTH_SERVICE_SCOPES, accessPathScope, authPathScope, deviceAdminPathScope, handleAuthService, handlePublicD1Auth, handleD1Access, handleD1DeviceAdmin };
