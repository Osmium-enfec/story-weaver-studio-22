import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { isAdminEmail } from "@/lib/admin";
import { pgQuery } from "@/lib/pg";
import type { AuthUser } from "@/lib/local-auth-db";

const SESSION_DAYS = 30;

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, 64);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function hashToken(token: string): string {
  return scryptSync(token, "session-salt", 32).toString("hex");
}

function sessionExpiry(): string {
  const d = new Date();
  d.setDate(d.getDate() + SESSION_DAYS);
  return d.toISOString();
}

export async function pgRegisterUser(email: string, password: string): Promise<AuthUser> {
  const normalized = email.trim().toLowerCase();
  const existing = await pgQuery<{ id: string }>(
    `SELECT id FROM users WHERE lower(email) = lower($1)`,
    [normalized],
  );
  if (existing.rows[0]) throw new Error("An account with this email already exists.");

  const id = randomUUID();
  const now = new Date().toISOString();
  await pgQuery(
    `INSERT INTO users (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)`,
    [id, normalized, hashPassword(password), now],
  );
  return { id, email: normalized, created_at: now };
}

export async function pgLoginUser(
  email: string,
  password: string,
): Promise<{ user: AuthUser; token: string }> {
  const normalized = email.trim().toLowerCase();
  const res = await pgQuery<{
    id: string;
    email: string;
    password_hash: string;
    created_at: string;
  }>(
    `SELECT id, email, password_hash, created_at::text AS created_at
     FROM users WHERE lower(email) = lower($1)`,
    [normalized],
  );
  const row = res.rows[0];
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw new Error("Invalid email or password.");
  }

  const token = randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  await pgQuery(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), row.id, hashToken(token), sessionExpiry(), now],
  );

  return {
    user: { id: row.id, email: row.email, created_at: row.created_at },
    token,
  };
}

export async function pgValidateSession(token: string): Promise<AuthUser | null> {
  if (!token) return null;
  const res = await pgQuery<{
    id: string;
    email: string;
    created_at: string;
    expires_at: string;
  }>(
    `SELECT u.id, u.email, u.created_at::text AS created_at, s.expires_at::text AS expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashToken(token)],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await pgQuery(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
    return null;
  }
  return { id: row.id, email: row.email, created_at: row.created_at };
}

export async function pgLogoutSession(token: string): Promise<void> {
  if (!token) return;
  await pgQuery(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

export async function pgListUsers(): Promise<AuthUser[]> {
  const res = await pgQuery<AuthUser>(
    `SELECT id, email, created_at::text AS created_at FROM users ORDER BY created_at DESC`,
  );
  return res.rows;
}

export async function pgGetUserById(id: string): Promise<AuthUser | null> {
  const res = await pgQuery<AuthUser>(
    `SELECT id, email, created_at::text AS created_at FROM users WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

export async function pgEnsureUser(email: string, password: string): Promise<AuthUser> {
  const normalized = email.trim().toLowerCase();
  const res = await pgQuery<AuthUser>(
    `SELECT id, email, created_at::text AS created_at FROM users WHERE lower(email) = lower($1)`,
    [normalized],
  );
  if (res.rows[0]) return res.rows[0];
  return pgRegisterUser(normalized, password);
}

export async function pgActiveSessionCount(userId: string): Promise<number> {
  const res = await pgQuery<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM sessions
     WHERE user_id = $1 AND expires_at > $2::timestamptz`,
    [userId, new Date().toISOString()],
  );
  return Number(res.rows[0]?.n ?? 0);
}

export async function pgDeleteUser(userId: string, actorUserId: string): Promise<void> {
  if (!userId) throw new Error("User id required.");
  if (userId === actorUserId) {
    throw new Error("You cannot delete your own account.");
  }
  const user = await pgGetUserById(userId);
  if (!user) throw new Error("User not found.");
  if (isAdminEmail(user.email)) {
    throw new Error("Cannot delete an admin account.");
  }

  // Clear assignments in projects JSON (Postgres path).
  const { pgClearAssignmentsForUser } = await import("@/lib/pg-projects-db");
  await pgClearAssignmentsForUser(userId);

  await pgQuery(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  const del = await pgQuery(`DELETE FROM users WHERE id = $1`, [userId]);
  if ((del.rowCount ?? 0) < 1) throw new Error("User not found.");
}
