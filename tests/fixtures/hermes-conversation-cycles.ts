// Run in a fresh Bun child so test runner/reviewer allocations cannot pollute
// the measured adapter RSS/FD baseline. No real Hermes host or wake is involved.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { initDb, registerPeer, sendMessage } from "../../broker.ts";
import { HermesConversationAdapter } from "../../shared/hermes-conversation-adapter.ts";
import { HermesConversationBroker, installHermesConversationBrokerSchema } from "../../shared/hermes-conversation-broker.ts";
import { parseHermesConversationContext } from "../../shared/hermes-conversation-context.ts";

const root = process.argv[2]!;
const backend = "77ab3c4a-2e1b-4d4a-a5b4-88009412f721";
const home = "/fixture/profile";
const db = initDb(join(root, "cycles.db"));
installHermesConversationBrokerSchema(db);
let sequence = 0;
const broker = new HermesConversationBroker(db, { profile: "fixture-hermes", adapter_id: "cycles",
  pid: process.pid, cwd: "/fixture", git_root: null, inboxRoot: join(root, "inboxes"),
  evidence: context => ({ context, adapter_id: "cycles", lifecycle_generation: ++sequence, observed_at: Date.now() }),
  releaseEvidence: () => ({ lifecycle_generation: ++sequence, observed_at: Date.now() }),
});
const sender = registerPeer(db, { peer_type: "claude", name: "cycle-sender", pid: process.pid,
  cwd: "/fixture", git_root: null, tty: null, summary: "" });
const adapter = new HermesConversationAdapter({ home, backend_id: backend, inboxRoot: join(root, "inboxes"), broker });
adapter.start();
function metadata(id: string) {
  return { "hermes/home": home, "hermes/conversation_id": id, "hermes/session_id": id,
    "hermes/platform": "desktop", "hermes/backend_id": backend };
}
function measure(cycle: number) {
  Bun.gc(true);
  return { cycle, rss: process.memoryUsage().rss, fd: readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length,
    ...adapter.resources(),
    peers: db.query<{ n: number }, []>("SELECT COUNT(*) n FROM peers WHERE peer_type='hermes'").get()!.n,
    bindings: broker.bindings.status() };
}
const baseline = measure(0);
const measurements = [];
let peakIdentities = 0;
let maxCleanupMs = 0;
for (let cycle = 1; cycle <= 50; cycle++) {
  const ids = Array.from({ length: 5 }, (_, i) => `cycle-${cycle}-chat-${i}`);
  await Promise.all(ids.map(async id => {
    const owner = await broker.bind(parseHermesConversationContext(metadata(id), { home, backend_id: backend }));
    const result = sendMessage(db, { from_id: sender.id, session_token: sender.session_token,
      to_id_or_name: owner.peer_id, text: `UNREAD-${id}` });
    if (!result.ok) throw new Error(result.error);
    await adapter.call({ name: "check_messages", _meta: metadata(id) });
  }));
  peakIdentities = Math.max(peakIdentities, adapter.resources().identities);
  const releaseStart = performance.now();
  await Promise.all(ids.map(id => adapter.release(metadata(id), cycle <= 25 ? "closed" : "reaped")));
  maxCleanupMs = Math.max(maxCleanupMs, performance.now() - releaseStart);
  measurements.push(measure(cycle));
}
const unread = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM messages WHERE acked=0").get()!.n;
const leases = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM hermes_conversations WHERE owner_lease_until!=0").get()!.n;
const tokens = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM hermes_conversation_tokens").get()!.n;
const files = readdirSync(join(root, "inboxes"));
const bodies = files.filter(path => path.endsWith(".json") && !path.endsWith(".metadata.json"));
const metadataFiles = files.filter(path => path.endsWith(".metadata.json"));
let contentsMatch = true;
const persistedIds = bodies.flatMap(path => {
  const data = JSON.parse(readFileSync(join(root, "inboxes", path), "utf8")) as { unread: { id: number; text: string; to_id: string }[] };
  const sidecar = JSON.parse(readFileSync(join(root, "inboxes", path.replace(/\.json$/, ".metadata.json")), "utf8")) as
    { unread: { id: number; to_id: string }[] };
  const peerId = decodeURIComponent(path.slice(0, -5));
  for (const message of data.unread) {
    const persisted = db.query<{ text: string; to_id: string }, [number]>("SELECT text,to_id FROM messages WHERE id=?").get(message.id);
    contentsMatch &&= message.to_id === peerId && persisted?.to_id === peerId && persisted.text === message.text;
  }
  contentsMatch &&= JSON.stringify(sidecar.unread.map(m => [m.id, m.to_id]))
    === JSON.stringify(data.unread.map(m => [m.id, m.to_id]));
  return data.unread.map(m => m.id);
}).sort((a, b) => a - b);
const brokerIds = db.query<{ id: number }, []>("SELECT id FROM messages WHERE acked=0 ORDER BY id").all().map(m => m.id);
await adapter.stop();
const stopped = measure(51);
console.log(JSON.stringify({ baseline, measurements, stopped, peakIdentities, unread, leases, tokens, maxCleanupMs,
  bodyFiles: bodies.length, metadataFiles: metadataFiles.length, contentsMatch, persistedIds, brokerIds }));
db.close();
