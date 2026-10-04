// Child process for the cross-process claim race: claims `key` `n` times in a loop on its own
// FileSettlementStore and prints how many claims it won. No top-level await, so it also runs as
// CommonJS (the upstream x402 package layout).
import { FileSettlementStore } from "../../../src/store/index.js";

async function main(): Promise<void> {
  const [path, key, n] = process.argv.slice(2) as [string, string, string];
  const store = new FileSettlementStore(path);
  let won = 0;
  for (let i = 0; i < Number(n); i++) if (await store.claim(key, 1)) won++;
  process.stdout.write(`${won}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
