// Run: FACILITATOR_URL=http://127.0.0.1:4022 MERCHANT_PAY_TO=sm… npm start -w x402-ycash-example-merchant-express
// (the README's "Quick start on the devnet" has every variable).
import { createMerchant, facilitatorClientOf } from "./app.js";
import { describeConfig, loadMerchantConfig } from "./config.js";
import { probeYed } from "./yed.js";

const log = (msg: string, fields?: Record<string, unknown>): void => console.log(JSON.stringify({ msg, ...fields }));
const config = loadMerchantConfig();
const facilitator = facilitatorClientOf(config);
// The YED routes are served only while the facilitator lists YED: probed at startup, then every
// minute and on a request to a YED route that is off (a facilitator started after the merchant).
const yedConfig = config.yed;
const yedProbe = yedConfig ? (f: typeof facilitator) => probeYed(yedConfig, f, config.network, config.wallet, log) : undefined;
const yed = yedProbe ? await yedProbe(facilitator) : undefined;
const merchant = createMerchant(config, { facilitator, ...(yed ? { yed } : {}), ...(yedProbe ? { yedProbe } : {}) });
const server = merchant.app.listen(config.port, config.host, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;
  console.log(JSON.stringify({ msg: "merchant listening", url: `http://${config.host}:${port}`, modes: merchant.modes, config: describeConfig(config) }));
});
const stop = (): void => {
  void merchant.close().finally(() => server.close(() => process.exit(0)));
  server.closeIdleConnections();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
