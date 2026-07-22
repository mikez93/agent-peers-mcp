import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  truncateSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 3;

export class BoundedLog {
  constructor(
    readonly path: string,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
    private readonly keep = DEFAULT_KEEP,
  ) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error("bounded log maxBytes must be positive");
    if (!Number.isInteger(keep) || keep < 0) throw new Error("bounded log keep must be non-negative");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
  }

  append(data: string | Uint8Array): void {
    let bytes = Buffer.from(data);
    if (bytes.byteLength > this.maxBytes) bytes = bytes.subarray(bytes.byteLength - this.maxBytes);

    const currentSize = existsSync(this.path) ? statSync(this.path).size : 0;
    if (currentSize > 0 && currentSize + bytes.byteLength > this.maxBytes) this.rotate();
    appendFileSync(this.path, bytes, { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  private rotate(): void {
    if (this.keep === 0) {
      truncateSync(this.path, 0);
      return;
    }
    for (let index = this.keep - 1; index >= 1; index -= 1) {
      const source = `${this.path}.${index}`;
      if (existsSync(source)) renameSync(source, `${this.path}.${index + 1}`);
    }
    if (existsSync(this.path)) renameSync(this.path, `${this.path}.1`);
  }
}

export function createWakeableAppServerLog(opts: {
  peerName?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): BoundedLog {
  const env = opts.env ?? process.env;
  const stateDir = env.AGENT_PEERS_CODEX_STATE_DIR || join(env.HOME || process.cwd(), ".agent-peers-codex");
  const rawName = opts.peerName || `${basename(opts.cwd)}-codex`;
  const safeName = rawName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "wakeable-codex";
  return new BoundedLog(
    join(stateDir, "logs", `${safeName}-app-server.log`),
    positiveInteger(env.CODEX_PEER_APP_SERVER_LOG_MAX_BYTES, DEFAULT_MAX_BYTES),
    nonNegativeInteger(env.CODEX_PEER_APP_SERVER_LOG_KEEP, DEFAULT_KEEP),
  );
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
