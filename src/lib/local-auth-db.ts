import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { isAdminEmail } from "@/lib/admin";
import { hostAppDbPath } from "@/lib/host-storage";
import { usePostgres } from "@/lib/runtime-backends";

export interface AuthUser {
  id: string;
  email: string;
  created_at: string;
}

const SESSION_DAYS = 30;

let db: Database.Database | null = null;

function dbPath(): string {
  return hostAppDbPath();
}

function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(path.dirname(dbPath()), { recursive: true });
  db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_token_idx ON sessions (token_hash);
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
  `);
  return db;
}

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

function sqliteRegisterUser(email: string, password: string): AuthUser {
  const conn = getDb();
  const normalized = email.trim().toLowerCase();
  const existing = conn
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(normalized) as { id: string } | undefined;
  if (existing) throw new Error("An account with this email already exists.");

  const id = randomUUID();
  const now = new Date().toISOString();
  conn
    .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(id, normalized, hashPassword(password), now);
  return { id, email: normalized, created_at: now };
}

function sqliteLoginUser(
  email: string,
  password: string,
): { user: AuthUser; token: string } {
  const conn = getDb();
  const normalized = email.trim().toLowerCase();
  const row = conn
    .prepare("SELECT id, email, password_hash, created_at FROM users WHERE email = ?")
    .get(normalized) as
    | { id: string; email: string; password_hash: string; created_at: string }
    | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw new Error("Invalid email or password.");
  }

  const token = randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  conn
    .prepare(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(randomUUID(), row.id, hashToken(token), sessionExpiry(), now);

  return {
    user: { id: row.id, email: row.email, created_at: row.created_at },
    token,
  };
}

function sqliteValidateSession(token: string): AuthUser | null {
  if (!token) return null;
  const conn = getDb();
  const row = conn
    .prepare(
      `SELECT u.id, u.email, u.created_at, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(hashToken(token)) as
    | { id: string; email: string; created_at: string; expires_at: string }
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    conn.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    return null;
  }
  return { id: row.id, email: row.email, created_at: row.created_at };
}

function sqliteLogoutSession(token: string): void {
  if (!token) return;
  getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

function sqliteListUsers(): AuthUser[] {
  return getDb()
    .prepare("SELECT id, email, created_at FROM users ORDER BY created_at DESC")
    .all() as AuthUser[];
}

function sqliteGetUserById(id: string): AuthUser | null {
  const row = getDb()
    .prepare("SELECT id, email, created_at FROM users WHERE id = ?")
    .get(id) as AuthUser | undefined;
  return row ?? null;
}

function sqliteEnsureUser(email: string, password: string): AuthUser {
  const conn = getDb();
  const normalized = email.trim().toLowerCase();
  const existing = conn
    .prepare("SELECT id, email, created_at FROM users WHERE email = ?")
    .get(normalized) as AuthUser | undefined;
  if (existing) return existing;
  return sqliteRegisterUser(normalized, password);
}

function sqliteActiveSessionCount(userId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions
       WHERE user_id = ? AND expires_at > ?`,
    )
    .get(userId, new Date().toISOString()) as { n: number };
  return Number(row?.n ?? 0);
}

async function sqliteDeleteUser(userId: string, actorUserId: string): Promise<void> {
  if (!userId) throw new Error("User id required.");
  if (userId === actorUserId) {
    throw new Error("You cannot delete your own account.");
  }
  const user = sqliteGetUserById(userId);
  if (!user) throw new Error("User not found.");

  if (isAdminEmail(user.email)) {
    throw new Error("Cannot delete an admin account.");
  }

  const { localClearAssignmentsForUser } = await import("@/lib/local-projects-db");
  await Promise.resolve(localClearAssignmentsForUser(userId));

  const conn = getDb();
  conn.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  const result = conn.prepare("DELETE FROM users WHERE id = ?").run(userId);
  if (result.changes < 1) throw new Error("User not found.");
}

/** Dual-backend: Postgres when DATABASE_URL is set, else local SQLite. */
export async function localRegisterUser(email: string, password: string): Promise<AuthUser> {
  if (usePostgres()) {
    const { pgRegisterUser } = await import("@/lib/pg-auth-db");
    return pgRegisterUser(email, password);
  }
  return sqliteRegisterUser(email, password);
}

export async function localLoginUser(
  email: string,
  password: string,
): Promise<{ user: AuthUser; token: string }> {
  if (usePostgres()) {
    const { pgLoginUser } = await import("@/lib/pg-auth-db");
    return pgLoginUser(email, password);
  }
  return sqliteLoginUser(email, password);
}

export async function localValidateSession(token: string): Promise<AuthUser | null> {
  if (usePostgres()) {
    const { pgValidateSession } = await import("@/lib/pg-auth-db");
    return pgValidateSession(token);
  }
  return sqliteValidateSession(token);
}

export async function localLogoutSession(token: string): Promise<void> {
  if (usePostgres()) {
    const { pgLogoutSession } = await import("@/lib/pg-auth-db");
    await pgLogoutSession(token);
    return;
  }
  sqliteLogoutSession(token);
}

export async function localListUsers(): Promise<AuthUser[]> {
  if (usePostgres()) {
    const { pgListUsers } = await import("@/lib/pg-auth-db");
    return pgListUsers();
  }
  return sqliteListUsers();
}

export async function localGetUserById(id: string): Promise<AuthUser | null> {
  if (usePostgres()) {
    const { pgGetUserById } = await import("@/lib/pg-auth-db");
    return pgGetUserById(id);
  }
  return sqliteGetUserById(id);
}

export async function localEnsureUser(email: string, password: string): Promise<AuthUser> {
  if (usePostgres()) {
    const { pgEnsureUser } = await import("@/lib/pg-auth-db");
    return pgEnsureUser(email, password);
  }
  return sqliteEnsureUser(email, password);
}

export async function localActiveSessionCount(userId: string): Promise<number> {
  if (usePostgres()) {
    const { pgActiveSessionCount } = await import("@/lib/pg-auth-db");
    return pgActiveSessionCount(userId);
  }
  return sqliteActiveSessionCount(userId);
}

export async function localDeleteUser(userId: string, actorUserId: string): Promise<void> {
  if (usePostgres()) {
    const { pgDeleteUser } = await import("@/lib/pg-auth-db");
    await pgDeleteUser(userId, actorUserId);
    return;
  }
  await sqliteDeleteUser(userId, actorUserId);
}
