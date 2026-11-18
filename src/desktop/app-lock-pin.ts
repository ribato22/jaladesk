import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { realFs, type StoreFs } from '../documents/store.js';

const pbkdf2Async = promisify(pbkdf2);

export const APP_LOCK_PBKDF2_ITERATIONS = 120_000;
export const APP_LOCK_SALT_BYTES = 16;
export const APP_LOCK_DERIVED_KEY_BYTES = 32;
export const APP_LOCK_MIN_PIN_LENGTH = 4;
export const APP_LOCK_MAX_PIN_LENGTH = 8;
export const APP_LOCK_COOLDOWN_THRESHOLD = 5;
export const APP_LOCK_BASE_COOLDOWN_SECONDS = 15;
export const APP_LOCK_MAX_COOLDOWN_SECONDS = 300;

export const APP_LOCK_TIMEOUT_PRESETS = [0, 60, 300, 900, -1] as const;
export type AutoLockTimeoutSeconds = (typeof APP_LOCK_TIMEOUT_PRESETS)[number];

export const AUTO_LOCK_PRESET_LABELS: Readonly<Record<AutoLockTimeoutSeconds, string>> = {
  0: 'Immediate',
  60: '1m',
  300: '5m',
  900: '15m',
  [-1]: 'Off',
};

export type AppLockPinErrorCode =
  | 'invalid-pin'
  | 'invalid-timeout'
  | 'pin-not-configured'
  | 'pin-already-configured'
  | 'verification-failed'
  | 'cooldown-active'
  | 'io';

export class AppLockPinError extends Error {
  constructor(
    readonly code: AppLockPinErrorCode,
    message: string,
    readonly details?: { cooldownRemainingMs?: number; cooldownRemainingSeconds?: number; failedAttempts?: number },
  ) {
    super(message);
    this.name = 'AppLockPinError';
  }
}

export interface AppLockPinState {
  isPinConfigured: boolean;
  pinLength: number | null;
  isLocked: boolean;
  autoLockTimeoutSeconds: AutoLockTimeoutSeconds;
  failedAttempts: number;
  cooldownUntilMs: number;
  cooldownRemainingMs: number;
  cooldownRemainingSeconds: number;
  lastActivityAtMs: number;
}

export interface AppLockVerifyResult {
  verified: boolean;
  lockedOut: boolean;
  failedAttempts: number;
  cooldownRemainingMs: number;
  cooldownRemainingSeconds: number;
  state: AppLockPinState;
}

export interface AppLockPinManagerOptions {
  fs?: StoreFs;
  now?: () => number;
  fileName?: string;
  defaultAutoLockSeconds?: AutoLockTimeoutSeconds;
}

interface StoredAppLockRecordV1 {
  version: 1;
  pinHash: string | null;
  pinLength: number | null;
  autoLockTimeoutSeconds: AutoLockTimeoutSeconds;
  failedAttempts: number;
  cooldownUntilMs: number;
  updatedAtMs: number;
}

const PIN_PATTERN = /^\d{4,8}$/;
const MAX_STATE_BYTES = 64 * 1024;

export function isValidAppLockPin(pin: unknown): pin is string {
  return typeof pin === 'string' && PIN_PATTERN.test(pin);
}

export function isValidAutoLockTimeout(value: unknown): value is AutoLockTimeoutSeconds {
  return typeof value === 'number' && (APP_LOCK_TIMEOUT_PRESETS as readonly number[]).includes(value);
}

export function computeExponentialCooldownMs(failedAttempts: number): number {
  if (!Number.isInteger(failedAttempts) || failedAttempts < APP_LOCK_COOLDOWN_THRESHOLD) {
    return 0;
  }
  const exponent = Math.min(10, failedAttempts - APP_LOCK_COOLDOWN_THRESHOLD);
  const seconds = Math.min(
    APP_LOCK_MAX_COOLDOWN_SECONDS,
    APP_LOCK_BASE_COOLDOWN_SECONDS * (2 ** exponent),
  );
  return seconds * 1000;
}

/**
 * Derives a PBKDF2-HMAC-SHA256 (`120000` iterations, 16-byte CSPRNG salt, 32-byte key) PIN hash record.
 */
export async function hashAppLockPin(
  pin: string,
  iterations: number = APP_LOCK_PBKDF2_ITERATIONS,
): Promise<string> {
  if (!isValidAppLockPin(pin)) {
    throw new AppLockPinError('invalid-pin', 'App Lock PIN must be 4 to 8 numeric digits');
  }
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 2_000_000) {
    throw new AppLockPinError('invalid-pin', 'Invalid PBKDF2 iteration count');
  }
  const salt = randomBytes(APP_LOCK_SALT_BYTES);
  const derived = await pbkdf2Async(pin, salt, iterations, APP_LOCK_DERIVED_KEY_BYTES, 'sha256');
  try {
    return `pbkdf2-sha256:${iterations}:${salt.toString('base64')}:${derived.toString('base64')}`;
  } finally {
    salt.fill(0);
    derived.fill(0);
  }
}

/**
 * Verifies a candidate PIN in constant time using `crypto.timingSafeEqual`.
 * Supports both `'pbkdf2-sha256:<iters>:<saltB64>:<hashB64>'` and Mobile `'pbkdf2:<iters>:<saltB64>:<hashB64>'`.
 */
export async function verifyAppLockPin(pin: string, storedRecord: string): Promise<boolean> {
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin) || typeof storedRecord !== 'string') {
    return false;
  }
  const parts = storedRecord.split(':');
  if (parts.length !== 4 || (parts[0] !== 'pbkdf2-sha256' && parts[0] !== 'pbkdf2')) {
    return false;
  }
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 2_000_000) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[2]!, 'base64');
    expected = Buffer.from(parts[3]!, 'base64');
  } catch {
    return false;
  }
  if (salt.length < 8 || expected.length !== APP_LOCK_DERIVED_KEY_BYTES) {
    salt.fill(0);
    expected.fill(0);
    return false;
  }
  const actual = await pbkdf2Async(pin, salt, iterations, expected.length, 'sha256');
  try {
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } finally {
    salt.fill(0);
    expected.fill(0);
    actual.fill(0);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function atomicWriteJson(fs: StoreFs, filePath: string, payload: StoredAppLockRecordV1): Promise<void> {
  const tmpPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  const data = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  try {
    await fs.mkdir(dirname(filePath));
    const handle = await fs.open(tmpPath, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmpPath, filePath);
        break;
      } catch (error) {
        if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as { code?: string }).code ?? '')) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20 * (3 ** attempt)));
      }
    }
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw new AppLockPinError('io', 'Failed to persist App Lock PIN state');
  }
  await fs.syncDir(dirname(filePath)).catch(() => undefined);
}

function parseStoredRecord(
  rawText: string,
  defaultTimeout: AutoLockTimeoutSeconds,
): StoredAppLockRecordV1 | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || parsed.version !== 1) return undefined;
  const pinHash = typeof parsed.pinHash === 'string' && parsed.pinHash.startsWith('pbkdf2')
    ? parsed.pinHash
    : null;
  const rawLen = typeof parsed.pinLength === 'number' ? Math.floor(parsed.pinLength) : null;
  const pinLength = pinHash && rawLen !== null && rawLen >= APP_LOCK_MIN_PIN_LENGTH && rawLen <= APP_LOCK_MAX_PIN_LENGTH
    ? rawLen
    : pinHash
      ? 6
      : null;
  const autoLockTimeoutSeconds = isValidAutoLockTimeout(parsed.autoLockTimeoutSeconds)
    ? parsed.autoLockTimeoutSeconds
    : defaultTimeout;
  const failedAttempts = typeof parsed.failedAttempts === 'number' && Number.isInteger(parsed.failedAttempts) && parsed.failedAttempts >= 0
    ? parsed.failedAttempts
    : 0;
  const cooldownUntilMs = typeof parsed.cooldownUntilMs === 'number' && Number.isFinite(parsed.cooldownUntilMs) && parsed.cooldownUntilMs >= 0
    ? Math.floor(parsed.cooldownUntilMs)
    : 0;
  const updatedAtMs = typeof parsed.updatedAtMs === 'number' && Number.isFinite(parsed.updatedAtMs) && parsed.updatedAtMs >= 0
    ? Math.floor(parsed.updatedAtMs)
    : 0;

  return {
    version: 1,
    pinHash,
    pinLength,
    autoLockTimeoutSeconds,
    failedAttempts: pinHash ? failedAttempts : 0,
    cooldownUntilMs: pinHash ? cooldownUntilMs : 0,
    updatedAtMs,
  };
}

/**
 * Desktop Full-Screen App Lock PIN Manager:
 * - 4–8 numeric digits with PBKDF2-HMAC-SHA256 (`120000` iterations, 16-byte CSPRNG salt, `timingSafeEqual`)
 * - Brute-force exponential cooldown persisted across restarts
 * - Auto-Lock timeout presets (`0` Immediate, `60` 1m, `300` 5m, `900` 15m, `-1` Off) + inactivity evaluation
 * - Atomic JSON persistence inside `userData`
 */
export class AppLockPinManager {
  readonly #fs: StoreFs;
  readonly #now: () => number;
  readonly #filePath: string;
  #pinHash: string | null;
  #pinLength: number | null;
  #isLocked: boolean;
  #autoLockTimeoutSeconds: AutoLockTimeoutSeconds;
  #failedAttempts: number;
  #cooldownUntilMs: number;
  #lastActivityAtMs: number;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #listeners = new Set<(state: AppLockPinState) => void>();

  private constructor(
    fs: StoreFs,
    now: () => number,
    filePath: string,
    record: StoredAppLockRecordV1,
  ) {
    this.#fs = fs;
    this.#now = now;
    this.#filePath = filePath;
    this.#pinHash = record.pinHash;
    this.#pinLength = record.pinLength;
    this.#isLocked = record.pinHash !== null;
    this.#autoLockTimeoutSeconds = record.autoLockTimeoutSeconds;
    this.#failedAttempts = record.failedAttempts;
    this.#cooldownUntilMs = record.cooldownUntilMs;
    this.#lastActivityAtMs = now();
  }

  static async open(userDataDir: string, options: AppLockPinManagerOptions = {}): Promise<AppLockPinManager> {
    const fs = options.fs ?? realFs;
    const now = options.now ?? Date.now;
    const defaultTimeout = options.defaultAutoLockSeconds ?? 300;
    if (!isValidAutoLockTimeout(defaultTimeout)) {
      throw new AppLockPinError('invalid-timeout', 'Invalid default auto-lock timeout preset');
    }
    const filePath = join(userDataDir, options.fileName ?? 'jaladesk-app-lock-pin.v1.json');
    let record: StoredAppLockRecordV1 = {
      version: 1,
      pinHash: null,
      pinLength: null,
      autoLockTimeoutSeconds: defaultTimeout,
      failedAttempts: 0,
      cooldownUntilMs: 0,
      updatedAtMs: 0,
    };

    try {
      const stat = await fs.stat(filePath);
      if (stat.size === undefined || stat.size <= MAX_STATE_BYTES) {
        const bytes = await fs.readFile(filePath);
        if (bytes.length <= MAX_STATE_BYTES) {
          const parsed = parseStoredRecord(bytes.toString('utf8'), defaultTimeout);
          if (parsed) record = parsed;
        }
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        throw new AppLockPinError('io', 'Cannot read App Lock PIN state');
      }
    }

    return new AppLockPinManager(fs, now, filePath, record);
  }

  getState(atMs: number = this.#now()): AppLockPinState {
    const isPinConfigured = this.#pinHash !== null;
    const cooldownRemainingMs = isPinConfigured && this.#cooldownUntilMs > atMs
      ? Math.max(0, this.#cooldownUntilMs - atMs)
      : 0;
    const cooldownRemainingSeconds = cooldownRemainingMs > 0
      ? Math.ceil(cooldownRemainingMs / 1000)
      : 0;
    return {
      isPinConfigured,
      pinLength: isPinConfigured ? this.#pinLength : null,
      isLocked: isPinConfigured ? this.#isLocked : false,
      autoLockTimeoutSeconds: this.#autoLockTimeoutSeconds,
      failedAttempts: isPinConfigured ? this.#failedAttempts : 0,
      cooldownUntilMs: isPinConfigured ? this.#cooldownUntilMs : 0,
      cooldownRemainingMs,
      cooldownRemainingSeconds,
      lastActivityAtMs: this.#lastActivityAtMs,
    };
  }

  subscribe(listener: (state: AppLockPinState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Configures a new 4–8 digit PIN. If a PIN is already active, `currentPin` is required
   * to prevent unauthorized replacement.
   */
  async setPin(newPin: string, currentPin?: string): Promise<AppLockPinState> {
    if (!isValidAppLockPin(newPin)) {
      throw new AppLockPinError('invalid-pin', 'App Lock PIN must be 4 to 8 numeric digits');
    }
    return this.#queued(async () => {
      if (this.#pinHash !== null) {
        if (currentPin === undefined) {
          throw new AppLockPinError('pin-already-configured', 'Current PIN is required to replace an active App Lock PIN');
        }
        await this.#requireVerifiedCurrentPinUnlocked(currentPin);
      }
      const nextHash = await hashAppLockPin(newPin, APP_LOCK_PBKDF2_ITERATIONS);
      const nowMs = this.#now();
      await this.#persist({
        version: 1,
        pinHash: nextHash,
        pinLength: newPin.length,
        autoLockTimeoutSeconds: this.#autoLockTimeoutSeconds,
        failedAttempts: 0,
        cooldownUntilMs: 0,
        updatedAtMs: nowMs,
      });
      this.#pinHash = nextHash;
      this.#pinLength = newPin.length;
      this.#failedAttempts = 0;
      this.#cooldownUntilMs = 0;
      this.#isLocked = false;
      this.#lastActivityAtMs = nowMs;
      return this.#notify();
    });
  }

  /**
   * Verifies `pin` (and unlocks the app if locked), enforcing brute-force exponential cooldown.
   */
  async verifyPin(pin: string): Promise<AppLockVerifyResult> {
    return this.#queued(async () => this.#verifyInternal(pin));
  }

  async unlock(pin: string): Promise<AppLockVerifyResult> {
    return this.verifyPin(pin);
  }

  async changePin(currentPin: string, newPin: string): Promise<AppLockPinState> {
    if (!isValidAppLockPin(newPin)) {
      throw new AppLockPinError('invalid-pin', 'New App Lock PIN must be 4 to 8 numeric digits');
    }
    return this.#queued(async () => {
      if (this.#pinHash === null) {
        throw new AppLockPinError('pin-not-configured', 'App Lock PIN is not configured');
      }
      await this.#requireVerifiedCurrentPinUnlocked(currentPin);
      const nextHash = await hashAppLockPin(newPin, APP_LOCK_PBKDF2_ITERATIONS);
      const nowMs = this.#now();
      await this.#persist({
        version: 1,
        pinHash: nextHash,
        pinLength: newPin.length,
        autoLockTimeoutSeconds: this.#autoLockTimeoutSeconds,
        failedAttempts: 0,
        cooldownUntilMs: 0,
        updatedAtMs: nowMs,
      });
      this.#pinHash = nextHash;
      this.#pinLength = newPin.length;
      this.#failedAttempts = 0;
      this.#cooldownUntilMs = 0;
      this.#isLocked = false;
      this.#lastActivityAtMs = nowMs;
      return this.#notify();
    });
  }

  async removePin(currentPin: string): Promise<AppLockPinState> {
    return this.#queued(async () => {
      if (this.#pinHash === null) {
        throw new AppLockPinError('pin-not-configured', 'App Lock PIN is not configured');
      }
      await this.#requireVerifiedCurrentPinUnlocked(currentPin);
      const nowMs = this.#now();
      await this.#persist({
        version: 1,
        pinHash: null,
        pinLength: null,
        autoLockTimeoutSeconds: this.#autoLockTimeoutSeconds,
        failedAttempts: 0,
        cooldownUntilMs: 0,
        updatedAtMs: nowMs,
      });
      this.#pinHash = null;
      this.#pinLength = null;
      this.#failedAttempts = 0;
      this.#cooldownUntilMs = 0;
      this.#isLocked = false;
      this.#lastActivityAtMs = nowMs;
      return this.#notify();
    });
  }

  async setAutoLockTimeout(timeoutSeconds: AutoLockTimeoutSeconds): Promise<AppLockPinState> {
    if (!isValidAutoLockTimeout(timeoutSeconds)) {
      throw new AppLockPinError('invalid-timeout', 'Auto-Lock timeout must be 0, 60, 300, 900, or -1');
    }
    return this.#queued(async () => {
      const nowMs = this.#now();
      await this.#persist({
        version: 1,
        pinHash: this.#pinHash,
        pinLength: this.#pinLength,
        autoLockTimeoutSeconds: timeoutSeconds,
        failedAttempts: this.#failedAttempts,
        cooldownUntilMs: this.#cooldownUntilMs,
        updatedAtMs: nowMs,
      });
      this.#autoLockTimeoutSeconds = timeoutSeconds;
      this.#lastActivityAtMs = nowMs;
      return this.#notify();
    });
  }

  lockNow(): AppLockPinState {
    if (this.#pinHash === null) {
      return this.getState();
    }
    if (!this.#isLocked) {
      this.#isLocked = true;
      return this.#notify();
    }
    return this.getState();
  }

  recordActivity(atMs: number = this.#now()): AppLockPinState {
    if (Number.isFinite(atMs) && atMs >= 0 && !this.#isLocked) {
      this.#lastActivityAtMs = Math.floor(atMs);
    }
    return this.getState(atMs);
  }

  /**
   * Evaluates whether the app should lock due to inactivity or window backgrounding/minimization.
   * - `-1` (`Off`): never auto-locks from inactivity or backgrounding
   * - `0` (`Immediate`): locks immediately when `backgrounded` or when `atMs >= lastActivityAtMs` on idle check
   * - `60 | 300 | 900`: locks when `atMs - lastActivityAtMs >= timeout * 1000`
   */
  evaluateInactivity(
    atMs: number = this.#now(),
    options: { backgrounded?: boolean } = {},
  ): AppLockPinState {
    if (this.#pinHash === null || this.#isLocked) {
      return this.getState(atMs);
    }
    const timeout = this.#autoLockTimeoutSeconds;
    if (timeout === -1) {
      return this.getState(atMs);
    }
    if (timeout === 0) {
      if (options.backgrounded || atMs >= this.#lastActivityAtMs) {
        this.#isLocked = true;
        return this.#notify(atMs);
      }
      return this.getState(atMs);
    }
    const elapsedMs = atMs - this.#lastActivityAtMs;
    if (elapsedMs >= timeout * 1000) {
      this.#isLocked = true;
      return this.#notify(atMs);
    }
    return this.getState(atMs);
  }

  /**
   * Starts an optional periodic inactivity check timer (returns cleanup function).
   */
  startInactivityWatcher(intervalMs: number = 5_000): () => void {
    const ms = Math.max(250, Math.floor(intervalMs));
    const timer = setInterval(() => {
      if (this.#autoLockTimeoutSeconds > 0 && !this.#isLocked && this.#pinHash !== null) {
        this.evaluateInactivity();
      }
    }, ms);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async #requireVerifiedCurrentPinUnlocked(currentPin: string): Promise<void> {
    const result = await this.#verifyInternal(currentPin);
    if (result.lockedOut) {
      throw new AppLockPinError(
        'cooldown-active',
        `Too many failed attempts. Try again in ${result.cooldownRemainingSeconds}s`,
        {
          cooldownRemainingMs: result.cooldownRemainingMs,
          cooldownRemainingSeconds: result.cooldownRemainingSeconds,
          failedAttempts: result.failedAttempts,
        },
      );
    }
    if (!result.verified) {
      throw new AppLockPinError(
        'verification-failed',
        'Incorrect current App Lock PIN',
        {
          cooldownRemainingMs: result.cooldownRemainingMs,
          cooldownRemainingSeconds: result.cooldownRemainingSeconds,
          failedAttempts: result.failedAttempts,
        },
      );
    }
  }

  async #verifyInternal(pin: string): Promise<AppLockVerifyResult> {
    const nowMs = this.#now();
    if (this.#pinHash === null) {
      const state = this.getState(nowMs);
      return {
        verified: true,
        lockedOut: false,
        failedAttempts: 0,
        cooldownRemainingMs: 0,
        cooldownRemainingSeconds: 0,
        state,
      };
    }

    if (this.#cooldownUntilMs > nowMs) {
      const state = this.getState(nowMs);
      return {
        verified: false,
        lockedOut: true,
        failedAttempts: this.#failedAttempts,
        cooldownRemainingMs: state.cooldownRemainingMs,
        cooldownRemainingSeconds: state.cooldownRemainingSeconds,
        state,
      };
    }

    const matched = await verifyAppLockPin(pin, this.#pinHash);
    const afterMs = this.#now();

    if (matched) {
      const hadFailures = this.#failedAttempts !== 0 || this.#cooldownUntilMs !== 0;
      this.#failedAttempts = 0;
      this.#cooldownUntilMs = 0;
      this.#isLocked = false;
      this.#lastActivityAtMs = afterMs;
      if (hadFailures) {
        await this.#persist({
          version: 1,
          pinHash: this.#pinHash,
          pinLength: this.#pinLength,
          autoLockTimeoutSeconds: this.#autoLockTimeoutSeconds,
          failedAttempts: 0,
          cooldownUntilMs: 0,
          updatedAtMs: afterMs,
        });
      }
      const state = this.#notify(afterMs);
      return {
        verified: true,
        lockedOut: false,
        failedAttempts: 0,
        cooldownRemainingMs: 0,
        cooldownRemainingSeconds: 0,
        state,
      };
    }

    const nextFailures = this.#failedAttempts + 1;
    const cooldownMs = computeExponentialCooldownMs(nextFailures);
    const nextCooldownUntil = cooldownMs > 0 ? afterMs + cooldownMs : 0;
    await this.#persist({
      version: 1,
      pinHash: this.#pinHash,
      pinLength: this.#pinLength,
      autoLockTimeoutSeconds: this.#autoLockTimeoutSeconds,
      failedAttempts: nextFailures,
      cooldownUntilMs: nextCooldownUntil,
      updatedAtMs: afterMs,
    });
    this.#failedAttempts = nextFailures;
    this.#cooldownUntilMs = nextCooldownUntil;
    const state = this.#notify(afterMs);
    return {
      verified: false,
      lockedOut: state.cooldownRemainingMs > 0,
      failedAttempts: nextFailures,
      cooldownRemainingMs: state.cooldownRemainingMs,
      cooldownRemainingSeconds: state.cooldownRemainingSeconds,
      state,
    };
  }

  #queued<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #persist(record: StoredAppLockRecordV1): Promise<void> {
    await atomicWriteJson(this.#fs, this.#filePath, record);
  }

  #notify(atMs: number = this.#now()): AppLockPinState {
    const snapshot = this.getState(atMs);
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Isolate subscriber exceptions so PIN state transitions never fail.
      }
    }
    return snapshot;
  }
}
