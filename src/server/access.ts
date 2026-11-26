import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

const ROLE_LEVELS: Record<string, number> = {
  "slash ops": 0,
  admin: 1,
  manager: 2,
  cashier: 3,
};

export function roleLevel(name: unknown) {
  return ROLE_LEVELS[String(name || "").trim().toLocaleLowerCase()] ?? 99;
}

export function isBuiltInRole(name: unknown) {
  return Object.prototype.hasOwnProperty.call(ROLE_LEVELS, String(name || "").trim().toLocaleLowerCase());
}

export function canManageRole(currentRole: unknown, targetRole: unknown) {
  return roleLevel(currentRole) < roleLevel(targetRole);
}

export function isSlashOps(name: unknown) {
  return String(name || "").trim().toLocaleLowerCase() === "slash ops";
}

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export function reservedProfileName(name: unknown) {
  return ["slash ops", "admin", "manager", "cashier"].includes(String(name || "").trim().toLocaleLowerCase());
}

export function accessUser(row: any) {
  return {
    id: row.id,
    display_name: row.display_name,
    username: row.username,
    profile_id: row.profile_id,
    active: row.active,
    is_blocked: row.is_blocked,
    blocked_at: row.blocked_at,
    block_reason: row.block_reason,
    failed_login_attempts: row.failed_login_attempts,
    created_at: row.created_at,
    profile_name: row.profile_name,
  };
}
