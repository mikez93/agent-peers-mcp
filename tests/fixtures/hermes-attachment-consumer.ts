// Invoked only by the isolated Python-host pairing harness, never discovery.
import { existsSync } from "node:fs";
import { createHermesAttachmentBridge } from "../../shared/hermes-runtime-attachment.ts";
import type { WakeRequest } from "../../shared/hermes-conversation-wake.ts";

try {
  const path = process.env.AGENT_PEERS_HERMES_ATTACHMENT!;
  const scope = { home: process.env.AGENT_PEERS_HERMES_HOME!, backend_id: process.env.AGENT_PEERS_HERMES_BACKEND_ID! };
  const bridge = await createHermesAttachmentBridge(path, scope, AbortSignal.timeout(5_000));
  try {
    const wake = process.env.AGENT_PEERS_HERMES_PAIR_WAKE
      ? JSON.parse(process.env.AGENT_PEERS_HERMES_PAIR_WAKE) as WakeRequest : undefined;
    const inventory = await bridge.inventory(wake ? [wake.context.conversation_id] : [], AbortSignal.timeout(5_000));
    if (!inventory.inventory_complete || inventory.home !== scope.home || inventory.backend_id !== scope.backend_id) {
      throw new Error("pairing_inventory_unavailable");
    }
    if (wake) {
      const observation = await bridge.observe(wake.context, AbortSignal.timeout(5_000));
      if (!observation || observation.state !== (wake.resume ? "terminal" : "live")) {
        throw new Error("pairing_observation_unavailable");
      }
      const admitted = await bridge.admit(wake, AbortSignal.timeout(5_000));
      if (admitted.state !== (process.env.AGENT_PEERS_HERMES_PAIR_ADMIT_STATE ?? "accepted")) {
        throw new Error("pairing_admission_unavailable");
      }
      const receipt = await bridge.reconcile(wake, AbortSignal.timeout(5_000));
      if (receipt.state !== (process.env.AGENT_PEERS_HERMES_PAIR_RECEIPT_STATE ?? "started")) {
        throw new Error("pairing_receipt_unavailable");
      }
    }
  } finally { await bridge.close(); await bridge.close(); }
  if (!existsSync(path)) throw new Error("pairing_reference_deleted");
  console.log(process.env.AGENT_PEERS_HERMES_PAIR_WAKE
    ? "attachment-factory-wake-ok" : "attachment-factory-scope-ok");
} catch {
  // The Python parent receives only a non-secret success marker or failure.
  process.exitCode = 1;
}
