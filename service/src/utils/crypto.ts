import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, KEY_LENGTH);
}

export function encryptSecret(plaintext: string, masterSecret: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(masterSecret, salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, encrypted]).toString("base64");
}

export function decryptSecret(ciphertext: string, masterSecret: string): string {
  const combined = Buffer.from(ciphertext, "base64");
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
 * Detect legacy base64-only "encryption". AES-256-GCM ciphertext is always
 * at least salt(16) + iv(16) + tag(16) + 1 byte of data = 49 bytes.
 */
export function isLegacyEncrypted(ciphertext: string): boolean {
  try {
    const buf = Buffer.from(ciphertext, "base64");
    return buf.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 1;
  } catch {
    return true;
  }
}

/**
 * Decrypt with backward compatibility: legacy base64-only values are decoded
 * as plain base64, new values use AES-256-GCM.
 */
export function decryptSecretCompat(ciphertext: string, masterSecret: string): string {
  if (isLegacyEncrypted(ciphertext)) {
    return Buffer.from(ciphertext, "base64").toString("utf-8").trim();
  }
  return decryptSecret(ciphertext, masterSecret);
}
