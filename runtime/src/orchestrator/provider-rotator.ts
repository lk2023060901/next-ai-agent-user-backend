import type {
  FailureReason,
  ProviderProfile,
  ProviderRotator,
} from "./orchestrator-types.js";

/**
 * Cooldown durations by failure reason (from design doc §3.6).
 *
 * | Reason       | Cooldown     | Action                      |
 * |------------- |------------- |-----------------------------|
 * | rate_limit   | 30–60s       | Rotate to next provider     |
 * | auth         | Permanent    | Skip this provider          |
 * | billing      | Permanent    | Skip this provider          |
 * | timeout      | 10s          | Retry current provider      |
 * | server_error | 15s          | Rotate to next provider     |
 */
const COOLDOWN_MS: Record<FailureReason, number> = {
  rate_limit: 45_000,    // 30-60s → use midpoint
  auth: Infinity,        // Permanent for this run
  billing: Infinity,     // Permanent for this run
  timeout: 10_000,
  server_error: 15_000,
};

/**
 * Manages provider rotation with cooldown tracking.
 *
 * Providers are sorted by priority (lower = higher). When a provider
 * fails, it enters cooldown. current() returns the highest-priority
 * provider not in cooldown. next() advances past the current one.
 *
 * Usage:
 * ```
 * const rotator = new DefaultProviderRotator(profiles);
 * let provider = rotator.current();
 * try { await callLLM(provider); rotator.markSuccess(provider.id); }
 * catch { rotator.markFailure(provider.id, 'rate_limit'); provider = rotator.next(); }
 * ```
 */
export class DefaultProviderRotator implements ProviderRotator {
  private readonly profiles: ProviderProfile[];
  private currentIndex = 0;

  constructor(profiles: ProviderProfile[]) {
    // Sort by priority (ascending = higher priority first)
    this.profiles = [...profiles].sort((a, b) => a.priority - b.priority);
  }

  current(): ProviderProfile | null {
    const now = Date.now();

    // Find the first non-cooled-down profile starting from currentIndex
    for (let i = 0; i < this.profiles.length; i++) {
      const idx = (this.currentIndex + i) % this.profiles.length;
      const profile = this.profiles[idx]!;
      if (!profile.cooldownUntil || profile.cooldownUntil <= now) {
        this.currentIndex = idx;
        return profile;
      }
    }

    // All providers are in cooldown — return null
    return null;
  }

  next(): ProviderProfile | null {
    if (this.profiles.length === 0) return null;

    // Advance past the current one and find the next available
    this.currentIndex = (this.currentIndex + 1) % this.profiles.length;
    return this.current();
  }

  markFailure(providerId: string, reason: FailureReason): void {
    const profile = this.profiles.find((p) => p.id === providerId);
    if (!profile) return;

    profile.consecutiveFailures++;

    const cooldownMs = COOLDOWN_MS[reason];
    if (cooldownMs === Infinity) {
      // Permanent cooldown — set far future
      profile.cooldownUntil = Date.now() + 365 * 24 * 3600_000;
    } else {
      profile.cooldownUntil = Date.now() + cooldownMs;
    }
  }

  markSuccess(providerId: string): void {
    const profile = this.profiles.find((p) => p.id === providerId);
    if (!profile) return;

    profile.consecutiveFailures = 0;
    profile.cooldownUntil = undefined;
  }

  isInCooldown(providerId: string): boolean {
    const profile = this.profiles.find((p) => p.id === providerId);
    if (!profile) return false;
    return !!profile.cooldownUntil && profile.cooldownUntil > Date.now();
  }

  /** Number of providers not in cooldown. */
  availableCount(): number {
    const now = Date.now();
    return this.profiles.filter(
      (p) => !p.cooldownUntil || p.cooldownUntil <= now,
    ).length;
  }
}
