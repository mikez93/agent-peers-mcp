// Invoked only by the isolated Python-host pairing harness, never discovery.
import { existsSync } from "node:fs";
import { createHermesAttachmentBridge } from "../../shared/hermes-runtime-attachment.ts";

try {
  const path = process.env.AGENT_PEERS_HERMES_ATTACHMENT!;
  const scope = { home: process.env.AGENT_PEERS_HERMES_HOME!, backend_id: process.env.AGENT_PEERS_HERMES_BACKEND_ID! };
  const bridge = await createHermesAttachmentBridge(path, scope, AbortSignal.timeout(5_000));
  try {
    const inventory = await bridge.inventory([], AbortSignal.timeout(5_000));
    if (!inventory.inventory_complete || inventory.home !== scope.home || inventory.backend_id !== scope.backend_id) {
      throw new Error("pairing_inventory_unavailable");
    }
  } finally { await bridge.close(); await bridge.close(); }
  if (!existsSync(path)) throw new Error("pairing_reference_deleted");
  console.log("attachment-factory-scope-ok");
} catch {
  // The Python parent receives only a non-secret success marker or failure.
  process.exitCode = 1;
}
