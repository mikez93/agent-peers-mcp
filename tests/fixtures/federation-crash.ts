// Isolated process-crash fixture. Every path is underneath argv[2]; no broker,
// user state, network connection, or real credential is involved.
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FederationService, FEDERATION_HOST_HEADER, FEDERATION_SECRET_HEADER } from "../../shared/federation.ts";
import type { Peer } from "../../shared/types.ts";

const root = process.argv[2]!;
const mode = process.argv[3]!;
const source = mode === "enqueue";
const host = source ? "alpha" : "beta";
const db = new Database(join(root, `${host}.db`));
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
db.exec(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT, to_id TEXT, text TEXT, message_uid TEXT UNIQUE
)`);
const secret = "test-crash-fixture-federation-secret-not-real";
const secretPath = join(root, "federation-secret");
const localSecretPath = join(root, "local-secret");
writeFileSync(secretPath, secret, { mode: 0o600 });
writeFileSync(localSecretPath, "test-crash-fixture-local-secret-not-real", { mode: 0o600 });
const from = "11111111-1111-4111-a111-111111111111";
const to = "22222222-2222-4222-a222-222222222222";
const now = new Date().toISOString();
const target: Peer = { id: to, name: "target", peer_type: "claude", pid: process.pid,
  cwd: "/fixture", git_root: null, tty: null, summary: "", registered_at: now, last_seen: now };
const service = new FederationService({
  db,
  config: { enabled: true, host, hosts: { alpha: "https://alpha.test", beta: "https://beta.test" },
    secretPath, localSecretPath },
  listLocalPeers: () => [target],
  sendLocal: () => { throw new Error("fixture does not invoke local send"); },
  snapshotSender: () => ({ id: from, peer_id: from, name: "author", peer_type: "claude",
    cwd: "/fixture", summary: "", chat: null }),
  deliverLocal: message => {
    const inserted = db.query<{ id: number }, [string, string, string, string]>(
      "INSERT INTO messages (from_id,to_id,text,message_uid) VALUES (?,?,?,?) RETURNING id",
    ).get(message.from_id, to, message.text, message.message_uid)!;
    if (mode === "receive-during-transaction") process.kill(process.pid, "SIGKILL");
    return { ok: true, message_id: inserted.id };
  },
  deliverNotice: () => { throw new Error("fixture does not invoke notices"); },
});
if (source) {
  db.transaction(() => service.enqueue({ db, fromId: from, fromName: "author", host: "beta",
    name: "target", chat: null, text: "crash durable message", fromChat: null, sentAt: now }))();
  process.kill(process.pid, "SIGKILL");
} else {
  const response = await service.handle(new Request("http://127.0.0.1/federation/relay", {
    method: "POST", headers: { [FEDERATION_HOST_HEADER]: "alpha", [FEDERATION_SECRET_HEADER]: secret },
    body: readFileSync(join(root, "envelope.json"), "utf8"),
  }));
  const result = await response!.json();
  if (mode === "receive-after-commit") process.kill(process.pid, "SIGKILL");
  console.log(JSON.stringify(result));
  db.close();
}
