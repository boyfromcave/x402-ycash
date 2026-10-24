#!/usr/bin/env node
// npm audit gate for secops.yml: reads `npm audit --omit=dev --json` on stdin and fails on any high or
// critical advisory that contrib/secops/npm-audit-exceptions.json does not accept (by GHSA id and
// package), or accepts past its `until` date. npm audit itself has no per-advisory ignore.
import { readFileSync } from "node:fs";

const exceptionsPath = process.argv[2] ?? "contrib/secops/npm-audit-exceptions.json";
const { exceptions } = JSON.parse(readFileSync(exceptionsPath, "utf8"));
const report = JSON.parse(readFileSync(0, "utf8"));
const today = new Date().toISOString().slice(0, 10);
const ghsa = (url) => /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/.exec(url ?? "")?.[0];

let failed = 0;
const seen = new Set();
for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of v.via) {
    if (typeof via !== "object" || !["high", "critical"].includes(via.severity)) continue;
    const id = ghsa(via.url);
    const key = `${via.name} ${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const e = exceptions.find((x) => x.id === id && x.package === via.name);
    if (e && e.until >= today) {
      console.log(`accepted until ${e.until}: ${via.name} ${id} (${via.severity}) via ${pkg}: ${e.reason}`);
    } else {
      failed++;
      console.log(`${e ? "EXPIRED" : "FAIL"}: ${via.name} ${id ?? via.url} (${via.severity}) ${via.title}`);
    }
  }
}
for (const e of exceptions) {
  if (![...seen].some((k) => k === `${e.package} ${e.id}`)) console.log(`note: exception ${e.package} ${e.id} matches no advisory; remove it`);
}
process.exit(failed ? 1 : 0);
