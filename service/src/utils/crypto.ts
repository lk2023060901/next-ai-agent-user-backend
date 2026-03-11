import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

const VERSION_PREFIX = "v1:";

function deriveKey(secret: string, salt: Buffer): Buffer {
  // N=16384: ~17ms vs N=32768 ~35ms. Acceptable for stored-secret KDF
  // (rare writes, not a login rate-limited path).
  return scryptSync(secret, salt, KEY_LENGTH, { N: 16384 });
}

export function encryptSecret(plaintext: string, masterSecret: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(masterSecret, salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return VERSION_PREFIX + Buffer.concat([salt, iv, authTag, encrypted]).toString("base64");
}

export function decryptSecret(ciphertext: string, masterSecret: string): string {
  const raw = ciphertext.startsWith(VERSION_PREFIX) ? ciphertext.slice(VERSION_PREFIX.length) : ciphertext;
  const combined = Buffer.from(raw, "base64");
  const MIN_SIZE = SALT_LENGTH + IV_LENGTH + TAG_LENGTH;
  if (combined.length < MIN_SIZE) {
    throw new Error("Invalid ciphertext: too short");
  }
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const key = deriveKey(masterSecret, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted).toString("utf-8") + decipher.final("utf-8");
}

/**
 * Detect legacy base64-only "encryption". New AES-256-GCM ciphertexts are
 * prefixed with "v1:". Anything without that prefix is treated as legacy.
 */
export function isLegacyEncrypted(ciphertext: string): boolean {
  return !ciphertext.startsWith(VERSION_PREFIX);
}

/**
 * Decrypt with backward compatibility: legacy base64-only values are decoded
 * as plain base64, new values use AES-256-GCM.
 */
export function decryptSecretCompat(ciphertext: string, masterSecret: string): string {
  if (isLegacyEncrypted(ciphertext)) {
    console.warn("[crypto] Legacy Base64 decryption used — consider migrating to AES-256-GCM");
    return Buffer.from(ciphertext, "base64").toString("utf-8").trim();
  }
  return decryptSecret(ciphertext, masterSecret);
}
