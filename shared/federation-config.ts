import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface FederationConfig {
  enabled: boolean;
  host: string;
  /** Stable host alias -> Tailscale Serve base URL (without /federation). */
  hosts: Record<string, string>;
  secretPath: string;
  localSecretPath: string;
  aliases?: string[];
  discoveryTimeoutMs?: number;
  relayTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  workerIntervalMs?: number;
}

export function validHost(host: unknown): host is string {
  return typeof host === "string" && /^[a-z0-9][a-z0-9.-]{0,127}$/.test(host);
}

export function validateFederationConfig(config: FederationConfig): void {
  if (!validHost(config.host)) throw new Error("invalid federation host alias");
  if (resolve(config.secretPath) === resolve(config.localSecretPath)) {
    throw new Error("federation must use a separate secret file");
  }
  if (!config.hosts || typeof config.hosts !== "object" || Array.isArray(config.hosts)) {
    throw new Error("federation hosts must be an alias-to-URL map");
  }
  for (const [host, base] of Object.entries(config.hosts)) {
    if (!validHost(host) || typeof base !== "string") throw new Error("invalid federation host entry");
    const url = new URL(base);
    // HTTP is useful only for isolated loopback tests. Real relays use HTTPS
    // over Tailscale Serve; never follow redirects with the fleet credential.
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || url.username || url.password || url.search || url.hash) {
      throw new Error(`invalid federation URL for ${host}`);
    }
  }
  for (const alias of config.aliases ?? []) {
    if (!validHost(alias)) throw new Error("invalid local federation alias");
  }
  for (const value of [config.discoveryTimeoutMs, config.relayTimeoutMs,
    config.retryBaseMs, config.retryMaxMs, config.workerIntervalMs]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error("federation timeouts and retry delays must be positive integers");
    }
  }
}

/** Disabled means no config/secret reads and no changes to local behavior. */
export function loadFederationConfig(env: NodeJS.ProcessEnv = process.env): FederationConfig | null {
  if (env.AGENT_PEERS_FEDERATION !== "1") return null;
  const home = env.HOME ?? homedir();
  const config: FederationConfig = {
    enabled: true,
    host: readFileSync(join(home, ".agent-peers-host"), "utf8").trim(),
    hosts: JSON.parse(readFileSync(join(home, ".agent-peers-fleet.json"), "utf8")),
    secretPath: join(home, ".agent-peers-federation-secret"),
    localSecretPath: env.AGENT_PEERS_SECRET_PATH ?? join(home, ".agent-peers-secret"),
  };
  validateFederationConfig(config);
  return config;
}
