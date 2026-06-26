import type { LeasedMessage } from "./types.ts";

export interface WaitForFreshPeerMessagesOptions {
  timeoutMs: number;
  pollIntervalMs: number;
  poll: () => Promise<void>;
  readUnread: () => Promise<LeasedMessage[]>;
  isFresh: (message: LeasedMessage) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onError?: (message: string) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type WaitForPeerMessagesPlan =
  | { kind: "skip-wakeable"; timeoutMs: number }
  | { kind: "wait"; timeoutMs: number };

/**
 * Decide what `wait_for_peer_messages` should do for one call.
 *
 * Validates/normalizes the caller's `timeout_ms`, then chooses between actually
 * blocking ("wait") and returning immediately ("skip-wakeable"). Wakeable
 * sessions are woken on demand by the daemon, so blocking there only pins the
 * turn "working" for up to the timeout and makes the session look hung — we skip
 * the wait entirely (pending mail is surfaced by the broker poll that already
 * ran). Extracted as a pure function so the short-circuit is unit-testable
 * without standing up the whole MCP. Throws on a non-finite explicit timeout.
 */
export function planWaitForPeerMessages(input: {
  isWakeable: boolean;
  rawTimeout: unknown;
  defaultMs: number;
  maxMs: number;
}): WaitForPeerMessagesPlan {
  const { rawTimeout } = input;
  if (rawTimeout !== undefined && (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout))) {
    throw new Error("timeout_ms must be a finite number");
  }
  const timeoutMs = rawTimeout === undefined
    ? input.defaultMs
    : Math.max(0, Math.min(input.maxMs, Math.floor(rawTimeout as number)));
  return input.isWakeable
    ? { kind: "skip-wakeable", timeoutMs }
    : { kind: "wait", timeoutMs };
}

export function hasFreshUnread(
  queued: LeasedMessage[],
  isFresh: (message: LeasedMessage) => boolean,
): boolean {
  return queued.some(isFresh);
}

export async function waitForFreshPeerMessages(opts: WaitForFreshPeerMessagesOptions): Promise<boolean> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = now() + opts.timeoutMs;

  while (true) {
    try {
      await opts.poll();
    } catch (e) {
      opts.onError?.(`poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      if (hasFreshUnread(await opts.readUnread(), opts.isFresh)) return true;
    } catch (e) {
      opts.onError?.(`inbox read failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(opts.pollIntervalMs, remaining));
  }
}
