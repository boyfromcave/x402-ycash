// Run: RESOURCE_URL=http://127.0.0.1:4021/exact/quote AGENT_DEVNET_JSON=…/devnet.json REQUESTS=10 npm start -w x402-ycash-example-agent-client
// (AGENT_WIF for a local key, AGENT_SHIELDED_FROM for sapling-proof; see the README's quick start).
import { createAgent } from "./agent.js";
import { loadAgentConfig } from "./config.js";

const config = loadAgentConfig();
const agent = createAgent(config);
const who = config.signer.kind === "wif" ? `wif ${config.signer.address}` : `node wallet ${config.node.url}`;
console.log(JSON.stringify({ msg: "agent", url: config.url, requests: config.requests, network: config.network, signer: who, schemes: agent.schemes }));

let paid = 0;
for (let i = 1; i <= config.requests; i++) {
  const r = await agent.call();
  if (r.settlement?.success) paid++;
  console.log(JSON.stringify({ i, status: r.status, ms: r.ms, transaction: r.settlement?.transaction, settlement: r.settlement, body: r.body }));
  if (r.status >= 400) process.exitCode = 1;
}
console.log(JSON.stringify({ msg: "done", requests: config.requests, paid }));
