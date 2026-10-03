// Smoke-test the built worker: module loads, manifest shape, HMAC verify.
import { createHmac } from "node:crypto";

async function main() {
  const manifestMod = await import("./dist/manifest.js");
  const manifest = manifestMod.default;
  if (!manifest || manifest.id !== "paperclip.gitea") {
    throw new Error("manifest shape wrong: " + JSON.stringify(manifest).slice(0, 200));
  }
  console.log("manifest OK:", manifest.id, "v" + manifest.version, "| capabilities:", manifest.capabilities.length, "| webhooks:", manifest.webhooks.map(w => w.endpointKey).join(","));

  const workerMod = await import("./dist/worker.js");
  const plugin = workerMod.default;
  if (!plugin || typeof plugin !== "object") throw new Error("worker default export missing");

  // HMAC verification unit test via the client class
  const { GiteaClient } = await import("./dist/gitea-client.js");
  const secret = "s3cret";
  const body = JSON.stringify({ hello: "world" });
  const good = createHmac("sha256", secret).update(body).digest("hex");
  const bad = createHmac("sha256", "wrong").update(body).digest("hex");
  if (!GiteaClient.verifySignature(body, good, secret)) throw new Error("HMAC verify failed on valid signature");
  if (GiteaClient.verifySignature(body, bad, secret)) throw new Error("HMAC verify passed an INVALID signature");
  if (GiteaClient.verifySignature(body, undefined, secret)) throw new Error("HMAC verify passed missing header");
  console.log("HMAC verify OK (accept valid, reject invalid/missing)");

  console.log("SMOKE_OK");
}

main().catch((e) => { console.error("SMOKE_FAIL", e); process.exit(1); });
