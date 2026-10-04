// Run: FACILITATOR_URL=http://127.0.0.1:4022 MERCHANT_PAY_TO=sm… npm start -w x402-ycash-example-merchant-express
import { createMerchant } from "./app.js";
import { loadMerchantConfig } from "./config.js";

const config = loadMerchantConfig();
const { app, modes } = createMerchant(config);
const server = app.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ msg: "merchant listening", url: `http://${config.host}:${config.port}`, network: config.network, facilitator: config.facilitatorUrl, modes }));
});
const stop = (): void => {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
