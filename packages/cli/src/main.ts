#!/usr/bin/env node
// `x402-ycash`: pay x402 routes in YEC and manage payment channels (see `x402-ycash --help`).
import { run } from "./run.js";

process.exitCode = await run(process.argv.slice(2));
