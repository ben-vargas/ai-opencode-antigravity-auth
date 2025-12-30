import { formatRefreshParts, parseRefreshParts } from "./auth";
import { loadAccounts, saveAccounts, type AccountStorageV3, type RateLimitStateV3, type ModelFamily, type HeaderStyle, type CooldownReason } from "./storage";
import type { OAuthAuthDetails, RefreshParts } from "./types";

export type { ModelFamily, HeaderStyle, CooldownReason } from "./storage";

export type BaseQuotaKey = "claude" | "gemini-antigravity" | "gemini-cli";
export type QuotaKey = BaseQuotaKey | `${BaseQuotaKey}:${string}`;

export interface ManagedAccount {
  index: number;
  email?: string;
  addedAt: number;
  lastUsed: number;
  parts: RefreshParts;
  access?: string;
  expires?: number;
  rateLimitResetTimes: RateLimitStateV3;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  coolingDownUntil?: number;
  cooldownReason?: CooldownReason;
}

function nowMs(): number {
  return Date.now();
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value < 0 ? 0 : Math.floor(value);
}

function getQuotaKey(family: ModelFamily, headerStyle: HeaderStyle, model?: string | null): QuotaKey {
  if (family === "claude") {
    return "claude";
  }
  const base = headerStyle === "gemini-cli" ? "gemini-cli" : "gemini-antigravity";
  if (model) {
    return `${base}:${model}`;
  }
  return base;
}

function isRateLimitedForQuotaKey(account: ManagedAccount, key: QuotaKey): boolean {
  const resetTime = account.rateLimitResetTimes[key];
  return resetTime !== undefined && nowMs() < resetTime;
}

function isRateLimitedForFamily(account: ManagedAccount, family: ModelFamily, model?: string | null): boolean {
  if (family === "claude") {
    return isRateLimitedForQuotaKey(account, "claude");
  }
  
  const antigravityIsLimited = isRateLimitedForHeaderStyle(account, family, "antigravity", model);
  const cliIsLimited = isRateLimitedForHeaderStyle(account, family, "gemini-cli", model);
  
  return antigravityIsLimited && cliIsLimited;
}

function isRateLimitedForHeaderStyle(account: ManagedAccount, family: ModelFamily, headerStyle: HeaderStyle, model?: string | null): boolean {
  clearExpiredRateLimits(account);
  
  if (family === "claude") {
    return isRateLimitedForQuotaKey(account, "claude");
  }

  // Check model-specific quota first if provided
  if (model) {
    const modelKey = getQuotaKey(family, headerStyle, model);
    if (isRateLimitedForQuotaKey(account, modelKey)) {
      return true;
    }
  }

  // Then check base family quota
  const baseKey = getQuotaKey(family, headerStyle);
  return isRateLimitedForQuotaKey(account, baseKey);
}

function clearExpiredRateLimits(account: ManagedAccount): void {
  const now = nowMs();
  const keys = Object.keys(account.rateLimitResetTimes) as QuotaKey[];
  for (const key of keys) {
    const resetTime = account.rateLimitResetTimes[key];
    if (resetTime !== undefined && now >= resetTime) {
      delete account.rateLimitResetTimes[key];
    }
  }
}

/**
 * In-memory multi-account manager with sticky account selection.
 *
 * Uses the same account until it hits a rate limit (429), then switches.
 * Rate limits are tracked per-model-family (claude/gemini) so an account
 * rate-limited for Claude can still be used for Gemini.
 *
 * Source of truth for the pool is `antigravity-accounts.json`.
 */
export class AccountManager {
  private accounts: ManagedAccount[] = [];
  private cursor = 0;
  private currentAccountIndexByFamily: Record<ModelFamily, number> = {
    claude: -1,
    gemini: -1,
  };
  private lastToastAccountIndex = -1;
  private lastToastTime = 0;

  static async loadFromDisk(authFallback?: OAuthAuthDetails): Promise<AccountManager> {
    const stored = await loadAccounts();
    return new AccountManager(authFallback, stored);
  }

  constructor(authFallback?: OAuthAuthDetails, stored?: AccountStorageV3 | null) {
    const authParts = authFallback ? parseRefreshParts(authFallback.refresh) : null;

    if (stored && stored.accounts.length === 0) {
      this.accounts = [];
      this.cursor = 0;
      return;
    }

    if (stored && stored.accounts.length > 0) {
      const baseNow = nowMs();
      this.accounts = stored.accounts
        .map((acc, index): ManagedAccount | null => {
          if (!acc.refreshToken || typeof acc.refreshToken !== "string") {
            return null;
          }
          const matchesFallback = !!(
            authFallback &&
            authParts &&
            authParts.refreshToken &&
            acc.refreshToken === authParts.refreshToken
          );

          return {
            index,
            email: acc.email,
            addedAt: clampNonNegativeInt(acc.addedAt, baseNow),
            lastUsed: clampNonNegativeInt(acc.lastUsed, 0),
            parts: {
              refreshToken: acc.refreshToken,
              projectId: acc.projectId,
              managedProjectId: acc.managedProjectId,
            },
            access: matchesFallback ? authFallback?.access : undefined,
            expires: matchesFallback ? authFallback?.expires : undefined,
            rateLimitResetTimes: acc.rateLimitResetTimes ?? {},
            lastSwitchReason: acc.lastSwitchReason,
            coolingDownUntil: acc.coolingDownUntil,
            cooldownReason: acc.cooldownReason,
          };
        })
        .filter((a): a is ManagedAccount => a !== null);

      this.cursor = clampNonNegativeInt(stored.activeIndex, 0);
      if (this.accounts.length > 0) {
        this.cursor = this.cursor % this.accounts.length;
        const defaultIndex = this.cursor;
        this.currentAccountIndexByFamily.claude = clampNonNegativeInt(
          stored.activeIndexByFamily?.claude,
          defaultIndex
        ) % this.accounts.length;
        this.currentAccountIndexByFamily.gemini = clampNonNegativeInt(
          stored.activeIndexByFamily?.gemini,
          defaultIndex
        ) % this.accounts.length;
      }

      return;
    }

    if (authFallback) {
      const parts = parseRefreshParts(authFallback.refresh);
      if (parts.refreshToken) {
        const now = nowMs();
        this.accounts = [
          {
            index: 0,
            email: undefined,
            addedAt: now,
            lastUsed: 0,
            parts,
            access: authFallback.access,
            expires: authFallback.expires,
            rateLimitResetTimes: {},
          },
        ];
        this.cursor = 0;
        this.currentAccountIndexByFamily.claude = 0;
        this.currentAccountIndexByFamily.gemini = 0;
      }
    }
  }

  getAccountCount(): number {
    return this.accounts.length;
  }

  getAccountsSnapshot(): ManagedAccount[] {
    return this.accounts.map((a) => ({ ...a, parts: { ...a.parts }, rateLimitResetTimes: { ...a.rateLimitResetTimes } }));
  }

  getCurrentAccountForFamily(family: ModelFamily): ManagedAccount | null {
    const currentIndex = this.currentAccountIndexByFamily[family];
    if (currentIndex >= 0 && currentIndex < this.accounts.length) {
      return this.accounts[currentIndex] ?? null;
    }
    return null;
  }

  markSwitched(account: ManagedAccount, reason: "rate-limit" | "initial" | "rotation", family: ModelFamily): void {
    account.lastSwitchReason = reason;
    this.currentAccountIndexByFamily[family] = account.index;
  }

  shouldShowAccountToast(accountIndex: number, debounceMs = 30000): boolean {
    const now = nowMs();
    if (accountIndex === this.lastToastAccountIndex && now - this.lastToastTime < debounceMs) {
      return false;
    }
    return true;
  }

  markToastShown(accountIndex: number): void {
    this.lastToastAccountIndex = accountIndex;
    this.lastToastTime = nowMs();
  }

  getCurrentOrNextForFamily(family: ModelFamily, model?: string | null): ManagedAccount | null {
    const current = this.getCurrentAccountForFamily(family);
    if (current) {
      clearExpiredRateLimits(current);
      if (!isRateLimitedForFamily(current, family, model) && !this.isAccountCoolingDown(current)) {
        current.lastUsed = nowMs();
        return current;
      }
    }

    const next = this.getNextForFamily(family, model);
    if (next) {
      this.currentAccountIndexByFamily[family] = next.index;
    }
    return next;
  }

  getNextForFamily(family: ModelFamily, model?: string | null): ManagedAccount | null {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a);
      return !isRateLimitedForFamily(a, family, model) && !this.isAccountCoolingDown(a);
    });

    if (available.length === 0) {
      return null;
    }

    const account = available[this.cursor % available.length];
    if (!account) {
      return null;
    }

    this.cursor++;
    account.lastUsed = nowMs();
    return account;
  }

  markRateLimited(
    account: ManagedAccount,
    retryAfterMs: number,
    family: ModelFamily,
    headerStyle: HeaderStyle = "antigravity",
    model?: string | null
  ): void {
    const key = getQuotaKey(family, headerStyle, model);
    account.rateLimitResetTimes[key] = nowMs() + retryAfterMs;
  }

  markAccountCoolingDown(account: ManagedAccount, cooldownMs: number, reason: CooldownReason): void {
    account.coolingDownUntil = nowMs() + cooldownMs;
    account.cooldownReason = reason;
  }

  isAccountCoolingDown(account: ManagedAccount): boolean {
    if (account.coolingDownUntil === undefined) {
      return false;
    }
    if (nowMs() >= account.coolingDownUntil) {
      this.clearAccountCooldown(account);
      return false;
    }
    return true;
  }

  clearAccountCooldown(account: ManagedAccount): void {
    delete account.coolingDownUntil;
    delete account.cooldownReason;
  }

  getAccountCooldownReason(account: ManagedAccount): CooldownReason | undefined {
    return this.isAccountCoolingDown(account) ? account.cooldownReason : undefined;
  }

  isRateLimitedForHeaderStyle(
    account: ManagedAccount,
    family: ModelFamily,
    headerStyle: HeaderStyle,
    model?: string | null
  ): boolean {
    return isRateLimitedForHeaderStyle(account, family, headerStyle, model);
  }

  getAvailableHeaderStyle(account: ManagedAccount, family: ModelFamily, model?: string | null): HeaderStyle | null {
    clearExpiredRateLimits(account);
    if (family === "claude") {
      return isRateLimitedForHeaderStyle(account, family, "antigravity") ? null : "antigravity";
    }
    if (!isRateLimitedForHeaderStyle(account, family, "antigravity", model)) {
      return "antigravity";
    }
    if (!isRateLimitedForHeaderStyle(account, family, "gemini-cli", model)) {
      return "gemini-cli";
    }
    return null;
  }

  removeAccount(account: ManagedAccount): boolean {
    const idx = this.accounts.indexOf(account);
    if (idx < 0) {
      return false;
    }

    this.accounts.splice(idx, 1);
    this.accounts.forEach((acc, index) => {
      acc.index = index;
    });

    if (this.accounts.length === 0) {
      this.cursor = 0;
      this.currentAccountIndexByFamily.claude = -1;
      this.currentAccountIndexByFamily.gemini = -1;
      return true;
    }

    if (this.cursor > idx) {
      this.cursor -= 1;
    }
    this.cursor = this.cursor % this.accounts.length;

    for (const family of ["claude", "gemini"] as ModelFamily[]) {
      if (this.currentAccountIndexByFamily[family] > idx) {
        this.currentAccountIndexByFamily[family] -= 1;
      }
      if (this.currentAccountIndexByFamily[family] >= this.accounts.length) {
        this.currentAccountIndexByFamily[family] = -1;
      }
    }

    return true;
  }

  updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails): void {
    const parts = parseRefreshParts(auth.refresh);
    account.parts = parts;
    account.access = auth.access;
    account.expires = auth.expires;
  }

  toAuthDetails(account: ManagedAccount): OAuthAuthDetails {
    return {
      type: "oauth",
      refresh: formatRefreshParts(account.parts),
      access: account.access,
      expires: account.expires,
    };
  }

  getMinWaitTimeForFamily(family: ModelFamily, model?: string | null): number {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a);
      return !isRateLimitedForFamily(a, family, model);
    });
    if (available.length > 0) {
      return 0;
    }

    const waitTimes: number[] = [];
    for (const a of this.accounts) {
      if (family === "claude") {
        const t = a.rateLimitResetTimes.claude;
        if (t !== undefined) waitTimes.push(Math.max(0, t - nowMs()));
      } else {
        // For Gemini, account becomes available when EITHER pool expires for this model/family
        const antigravityKey = getQuotaKey(family, "antigravity", model);
        const cliKey = getQuotaKey(family, "gemini-cli", model);

        const t1 = a.rateLimitResetTimes[antigravityKey];
        const t2 = a.rateLimitResetTimes[cliKey];
        
        const accountWait = Math.min(
          t1 !== undefined ? Math.max(0, t1 - nowMs()) : Infinity,
          t2 !== undefined ? Math.max(0, t2 - nowMs()) : Infinity
        );
        if (accountWait !== Infinity) waitTimes.push(accountWait);
      }
    }

    return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
  }

  getAccounts(): ManagedAccount[] {
    return [...this.accounts];
  }

  async saveToDisk(): Promise<void> {
    const claudeIndex = Math.max(0, this.currentAccountIndexByFamily.claude);
    const geminiIndex = Math.max(0, this.currentAccountIndexByFamily.gemini);
    
    const storage: AccountStorageV3 = {
      version: 3,
      accounts: this.accounts.map((a) => ({
        email: a.email,
        refreshToken: a.parts.refreshToken,
        projectId: a.parts.projectId,
        managedProjectId: a.parts.managedProjectId,
        addedAt: a.addedAt,
        lastUsed: a.lastUsed,
        lastSwitchReason: a.lastSwitchReason,
        rateLimitResetTimes: Object.keys(a.rateLimitResetTimes).length > 0 ? a.rateLimitResetTimes : undefined,
        coolingDownUntil: a.coolingDownUntil,
        cooldownReason: a.cooldownReason,
      })),
      activeIndex: claudeIndex,
      activeIndexByFamily: {
        claude: claudeIndex,
        gemini: geminiIndex,
      },
    };

    await saveAccounts(storage);
  }
}
