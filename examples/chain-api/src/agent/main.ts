#!/usr/bin/env node
// Copyright (c) 2026 The Ycash developers. MIT License.
//
// `x402-chain-agent <api-url> --wif-file FILE --lwd HOST:PORT`: the reference agent (agent.ts).
import { runAgent } from "./agent.js";

const io = {
  out: (r: Record<string, unknown>): void => void process.stdout.write(JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) + "\n"),
  err: (l: string): void => void process.stderr.write(l + "\n"),
};
process.exitCode = await runAgent(process.argv.slice(2), process.env, io);
