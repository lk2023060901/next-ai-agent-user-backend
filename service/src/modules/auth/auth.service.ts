import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users, refreshTokens } from "../../db/schema";
import { config } from "../../config";

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  createdAt: string;
}

export async function signup(
  email: string,
  password: string,
  name: string
): Promise<{ tokens: AuthTokens; user: UserProfile }> {
  const existing = db.select().from(users).where(eq(users.email, email)).get();
  if (existing) {
    throw Object.assign(new Error("Email already in use"), { code: "ALREADY_EXISTS" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const id = uuidv4();

  db.insert(users).values({ id, email, name, passwordHash }).run();

  const user = db.select().from(users).where(eq(users.id, id)).get()!;
  const tokens = await issueTokens(user.id, user.email, user.name);

  return { tokens, user: toProfile(user) };
}

export async function login(
  email: string,
  password: string
): Promise<{ tokens: AuthTokens; user: UserProfile }> {
  const user = db.select().from(users).where(eq(users.email, email)).get();
  if (!user) {
    throw Object.assign(new Error("Invalid credentials"), { code: "UNAUTHENTICATED" });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw Object.assign(new Error("Invalid credentials"), { code: "UNAUTHENTICATED" });
  }

  const tokens = await issueTokens(user.id, user.email, user.name);
  return { tokens, user: toProfile(user) };
}

export async function refresh(token: string): Promise<{ tokens: AuthTokens; user: UserProfile }> {
  const stored = db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.token, token))
    .get();

  if (!stored || new Date(stored.expiresAt) < new Date()) {
    throw Object.assign(new Error("Invalid or expired refresh token"), { code: "UNAUTHENTICATED" });
  }

  // Rotate refresh token
  db.delete(refreshTokens).where(eq(refreshTokens.id, stored.id)).run();

  const user = db.select().from(users).where(eq(users.id, stored.userId)).get()!;
  const tokens = await issueTokens(user.id, user.email, user.name);
  return { tokens, user: toProfile(user) };
}

export function logout(refreshToken: string): void {
  db.delete(refreshTokens).where(eq(refreshTokens.token, refreshToken)).run();
}

export function getMe(userId: string): UserProfile {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) {
    throw Object.assign(new Error("User not found"), { code: "NOT_FOUND" });
  }
  return toProfile(user);
}

async function issueTokens(userId: string, email: string, name: string): Promise<AuthTokens> {
  const accessToken = jwt.sign(
    { user_id: userId, email, name },
    config.jwtSecret,
    { expiresIn: config.jwtAccessExpiry } as jwt.SignOptions
  );

  const rawRefresh = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.insert(refreshTokens)
    .values({ id: uuidv4(), userId, token: rawRefresh, expiresAt })
    .run();

  return { accessToken, refreshToken: rawRefresh };
}

function toProfile(user: typeof users.$inferSelect): UserProfile {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl ?? null,
    createdAt: user.createdAt,
  };
}
