import { describe, it, expect } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  isLegacyEncrypted,
  decryptSecretCompat,
} from "../utils/crypto.js";

const MASTER_SECRET = "test-master-secret-32-chars-long!";

describe("crypto", () => {
  describe("encryptSecret / decryptSecret", () => {
    it("round-trips a plaintext value", () => {
      const plaintext = "sk-my-api-key-12345";
      const encrypted = encryptSecret(plaintext, MASTER_SECRET);
      const decrypted = decryptSecret(encrypted, MASTER_SECRET);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertexts for the same plaintext (random IV)", () => {
      const plaintext = "same-value";
      const a = encryptSecret(plaintext, MASTER_SECRET);
      const b = encryptSecret(plaintext, MASTER_SECRET);
      expect(a).not.toBe(b);
    });

    it("fails to decrypt with a different master secret", () => {
      const encrypted = encryptSecret("secret-data", MASTER_SECRET);
      expect(() => decryptSecret(encrypted, "wrong-secret-key-32-chars-long!!")).toThrow();
    });

    it("fails on tampered ciphertext", () => {
      const encrypted = encryptSecret("test", MASTER_SECRET);
      // Flip a character in the base64 payload
      const parts = encrypted.split(":");
      const tampered = parts[0] + ":" + parts[1].slice(0, -2) + "XX";
      expect(() => decryptSecret(tampered, MASTER_SECRET)).toThrow();
    });

    it("fails on too-short ciphertext", () => {
      expect(() => decryptSecret("v1:dG9v", MASTER_SECRET)).toThrow("too short");
    });

    it("handles empty string plaintext", () => {
      const encrypted = encryptSecret("", MASTER_SECRET);
      const decrypted = decryptSecret(encrypted, MASTER_SECRET);
      expect(decrypted).toBe("");
    });

    it("handles unicode plaintext", () => {
      const plaintext = "密钥：测试密钥🔑";
      const encrypted = encryptSecret(plaintext, MASTER_SECRET);
      const decrypted = decryptSecret(encrypted, MASTER_SECRET);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe("isLegacyEncrypted", () => {
    it("identifies new v1: format as NOT legacy", () => {
      const encrypted = encryptSecret("test", MASTER_SECRET);
      expect(encrypted.startsWith("v1:")).toBe(true);
      expect(isLegacyEncrypted(encrypted)).toBe(false);
    });

    it("identifies plain base64 as legacy", () => {
      const legacy = Buffer.from("plain-api-key").toString("base64");
      expect(isLegacyEncrypted(legacy)).toBe(true);
    });
  });

  describe("decryptSecretCompat", () => {
    it("decrypts new format correctly", () => {
      const encrypted = encryptSecret("new-key", MASTER_SECRET);
      expect(decryptSecretCompat(encrypted, MASTER_SECRET)).toBe("new-key");
    });

    it("decodes legacy base64 format", () => {
      const legacy = Buffer.from("old-api-key").toString("base64");
      expect(decryptSecretCompat(legacy, MASTER_SECRET)).toBe("old-api-key");
    });
  });
});
