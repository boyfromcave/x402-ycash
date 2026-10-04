// Child process for the cross-process claim race: claims `key` `n` times in a loop on its own
// FileSettlementStore and prints how many claims it won.
import { FileSettlementStore } from "../../../src/store/index.js";

const [path, key, n] = process.argv.slice(2) as [string, string, string];
const store = new FileSettlementStore(path);
let won = 0;
for (let i = 0; i < Number(n); i++) if (await store.claim(key, 1)) won++;
process.stdout.write(`${won}\n`);
