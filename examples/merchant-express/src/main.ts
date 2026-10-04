// Run: FACILITATOR_URL=http://127.0.0.1:4022 MERCHANT_PAY_TO=sm… npm start -w x402-ycash-example-merchant-express
// (the README's "Quick start on the devnet" has every variable).
import { createMerchant } from "./app.js";
import { describeConfig, loadMerchantConfig } from "./config.js";

const config = loadMerchantConfig();
const merchant = createMerchant(config);
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
