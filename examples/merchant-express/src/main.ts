// Run: FACILITATOR_URL=http://127.0.0.1:4022 MERCHANT_PAY_TO=sm… npm start -w x402-ycash-example-merchant-express
// (the README's "Quick start on the devnet" has every variable).
import { createServer } from "node:http";
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
// A YED channel voucher on the hybrid TX_PQCHANNEL carries an ≈ 8 KB SLH-DSA scriptSig, so its
// PAYMENT-SIGNATURE header is ≈ 22 KB of base64 (an open with its funding, ≈ 25 KB): above Node's
// default 16 KB header limit, which answers 431. Every x402 server taking those vouchers raises it.
const MAX_HEADER_BYTES = 64 * 1024;
const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, merchant.app).listen(config.port, config.host, () => {
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
