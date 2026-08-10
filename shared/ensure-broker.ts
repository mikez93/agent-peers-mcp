// shared/ensure-broker.ts
// Ensures the broker daemon is running. Separate from createClient() because
// the caller needs the shared secret from ~/.agent-peers-secret AFTER the
// broker has provisioned it — see waitForSharedSecret() in shared/shared-secret.ts.
//
// Ownership contract (2026-08-10, broker-ownership stabilization): launchd is
// the ONLY process that starts the broker in production. Clients never spawn
// it — a client-spawned broker inherits the client's env (AGENT_PEERS_DB,
// PEER_NAME, cwd) and its lifetime, which is how a Hermes gateway ended up
// owning port 7900 while the launchd service crash-looped 122× on EADDRINUSE.
// A client that finds the broker down asks launchd to start it (kickstart is
// a no-op if the service is already running) and then waits.
//
// The legacy self-spawn path survives ONLY behind AGENT_PEERS_SPAWN_BROKER=1
// (tests, broker-less dev boxes) and pins the child env so nothing session-
// specific can leak into a broker that outlives the session.

import { fileURLToPath } from "node:url";

export const BROKER_LAUNCHD_LABEL = "com.mike.agent-peers-broker";

export interface EnsureBrokerOpts {
  /** Total time to wait for the broker to answer, default 15s (launchd cold
   *  start + SQLite migration can exceed the old 6s budget). */
  timeoutMs?: number;
  /** Poll interval, default 250ms. */
  pollMs?: number;
  /** Injectable `launchctl kickstart` runner for tests. Must not throw. */
  kickstart?: () => Promise<void>;
  /** Override for AGENT_PEERS_SPAWN_BROKER (tests). */
  allowSpawn?: boolean;
}

async function defaultKickstart(): Promise<void> {
  try {
    const uid = process.getuid?.() ?? 501;
    const p = Bun.spawn(
      ["launchctl", "kickstart", `gui/${uid}/${BROKER_LAUNCHD_LABEL}`],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    await p.exited;
  } catch {
    // launchctl missing or service not installed (dev box) — the poll loop
    // below will surface the failure with a clear message.
  }
}

export async function ensureBroker(
  isAlive: () => Promise<boolean>,
  brokerScriptUrl: string, // pass `new URL("./broker.ts", import.meta.url).href`
  opts: EnsureBrokerOpts = {},
): Promise<void> {
  if (await isAlive()) return;

  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 250;
  const allowSpawn = opts.allowSpawn ?? process.env.AGENT_PEERS_SPAWN_BROKER === "1";

  if (allowSpawn) {
    // Resolve via fileURLToPath — required because the project path may contain
    // a space or apostrophe; URL.pathname returns URL-encoded (%27, %20) and
    // spawn would ENOENT the encoded form.
    const scriptPath = fileURLToPath(brokerScriptUrl);
    const proc = Bun.spawn(["bun", scriptPath], {
      stdio: ["ignore", "ignore", "inherit"],
      // Pinned env: the broker is machine-global state. Whatever session
      // happens to spawn it first must not define its identity (PEER_NAME,
      // AGENT_PEERS_CWD, etc. are all stripped). PORT/DB/SECRET_PATH forward
      // because they are machine config, not session config — a dev box that
      // sets a custom secret path must not spawn a broker provisioning the
      // default secret while the client waits on the custom one (hang/401).
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...(process.env.AGENT_PEERS_PORT ? { AGENT_PEERS_PORT: process.env.AGENT_PEERS_PORT } : {}),
        ...(process.env.AGENT_PEERS_DB ? { AGENT_PEERS_DB: process.env.AGENT_PEERS_DB } : {}),
        ...(process.env.AGENT_PEERS_SECRET_PATH ? { AGENT_PEERS_SECRET_PATH: process.env.AGENT_PEERS_SECRET_PATH } : {}),
      },
    });
    proc.unref();
  } else {
    await (opts.kickstart ?? defaultKickstart)();
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (await isAlive()) return;
  }
  throw new Error(
    `ensureBroker: broker did not come up within ${Math.round(timeoutMs / 1000)}s. ` +
    `Production brokers are owned by launchd (${BROKER_LAUNCHD_LABEL}); check ` +
    `\`launchctl print gui/$(id -u)/${BROKER_LAUNCHD_LABEL}\` and ` +
    `~/Library/Logs/agent-peers-broker.log. On a box without the LaunchAgent, ` +
    `set AGENT_PEERS_SPAWN_BROKER=1 to allow client self-spawn.`,
  );
}
