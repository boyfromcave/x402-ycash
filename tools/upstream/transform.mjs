#!/usr/bin/env node
// Rewrites a staged copy of packages/ycash and specs/ into the x402 Foundation's layout and style
// (called by stage.sh; see docs/upstream.md). It edits files in place under the fork and prints
// what it could not rewrite, so a refresh after a future change shows what needs a human look.
//
//   node transform.mjs code  <dir>        TypeScript under <dir>: imports, paths, comments
//   node transform.mjs spec  <file> <kind> one binding spec (kind: exact | batch)
//
// Rules for code:
//   - relative imports lose their ".js" suffix (upstream uses moduleResolution "bundler");
//   - the batch module is "batch-settlement" upstream (the evm and svm directory name);
//   - test vectors move from the repository root to the package's test/vectors;
//   - spec paths become upstream's specs/schemes/<scheme>/ paths;
//   - references to this repository's plan (plan §5.7, X-F14, plan X4a) are dropped; node
//     behaviour ids (R-1, S-5, Y-9, …) stay, since they are the specs' Appendix A rows;
//   - node trees are named by release ("Ycash 4.5.0", "Ycash 6.21.0") instead of by checkout.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, target, kind] = process.argv.slice(2);
const leftovers = [];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

// A reference to this repository's plan inside a parenthetical: a section (§5.7, with its quoted
// title), a phase (X1, X4a), a decision (X-7) or a finding (X-F14). Node ids (Y-9) are not.
const PLAN_REF = String.raw`(?:plan(?:\s|\/\/|\*)+)?(?:§[\d.]+(?:\s+X\d+[a-z]?)?(?:,?(?:\s|\/\/|\*)*"[^"]*")?|X-F\d+|X-\d+\b|\bX\d+[a-z]?\b(?:\s+hook)?)`;
// A separator between items, which may wrap onto the next comment line.
const SEP = String.raw`\s*[,;]\s*(?:(?:\/\/|\*)\s?)?`;
const LEADING = new RegExp(String.raw`^((?:\s|\/\/|\*)*)${PLAN_REF}(?:${SEP})?`);
const INNER = new RegExp(String.raw`${SEP}${PLAN_REF}`, "g");

// Drops plan references from one parenthetical's inner text, in place, so everything else keeps
// its wording and line breaks. Returns "" when nothing but comment markup is left.
function cleanParen(inner) {
  // a removed span that crossed a line keeps the line break and its comment marker
  const keepBreak = (m) => (m.includes("\n") ? m.slice(m.indexOf("\n")).match(/^\n\s*(?:\/\/|\*)\s?/)?.[0] ?? "" : "");
  let t = inner.replace(/\bplan\s+([RSYZGC]-\d+a?)\b/g, "$1");
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(LEADING, (m, lead) => lead + keepBreak(m.slice(lead.length)));
    t = t.replace(INNER, keepBreak);
  }
  return t.replace(/\n\s*(?:\/\/|\*)\s?/g, "").trim() === "" ? "" : t;
}

// Every parenthetical that names the plan, on one line or wrapping onto comment lines.
function rewriteParens(text) {
  text = text.replace(/(?:\n\s*\/\/)?\s*\(docs\/plans\/[^()]*\)/g, "");
  return text.replace(/(\s?)\(([^()]*)\)/g, (m, sp, inner) => {
    if (!/\bplan\b|X-F\d/.test(inner)) return m;
    const lines = inner.split("\n");
    if (!lines.slice(1).every((l) => /^\s*(\*|\/\/)/.test(l))) return m;
    const r = cleanParen(inner);
    if (!r) return "";
    // "(" left alone at the end of a line moves down to the text it opens
    const brk = r.match(/^\n\s*(?:\/\/|\*)\s?/);
    return brk ? `${brk[0]}(${r.slice(brk[0].length)})` : `${sp}(${r})`;
  });
}

// Splits a line into code and comment: a whole-line comment, or code followed by " // …".
function splitComment(line) {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return ["", line];
  for (let i = line.indexOf(" //"); i !== -1; i = line.indexOf(" //", i + 1)) {
    const before = line.slice(0, i);
    // outside every string literal: an even count of each quote character before it
    if ([`"`, `'`, "`"].every((q) => (before.split(q).length - 1) % 2 === 0)) return [before, line.slice(i)];
  }
  return [line, ""];
}

// Prose only: test titles and comments. Code and data (file names, asserted strings) stay as they are.
function rewriteProse(text) {
  let s = text;
  // "the channel scriptSigs of plan §5.7" → "the channel scriptSigs"
  s = s.replace(/\s+(?:of|in)\s+(?:the\s+)?plan\s+§[\d.]+/g, "");
  // the plan's node ids outside parentheses ("plan Y-8" → "Y-8")
  s = s.replace(/\bplan ([RSYZGC]-\d+a?)\b/g, "$1");
  // "the plan's node assumptions" and similar
  s = s.replace(/\bthe plan's\b/g, "the binding's");
  // node checkouts → releases
  s = s.replace(/\bycash-dd\/(?=(src|qa)\/)/g, "Ycash 4.5.0 ");
  s = s.replace(/\bycash6\/(?=(src|qa)\/)/g, "Ycash 6.21.0 ");
  // findings named inline: "(X-F8: valid …)", "the wallet race of X-F13", a trailing "// X-F13"
  s = s.replace(/\bX-F\d+:\s*/g, "");
  s = s.replace(/\s+(?:of|in|see)\s+X-F\d+\b/g, "");
  s = s.replace(/\s*\/\/\s*X-F\d+\s*$/, "");
  // module headers name this repository
  s = s.replace(/^(\s*\/\/\s*)x402-ycash: /, "$1");
  s = s.replace(/\bycash-dd\b(?![-.\w/])/g, "Ycash 4.5.0");
  s = s.replace(/\bycash6\b(?![-.\w/])/g, "Ycash 6.21.0");
  // spec paths
  s = s.replace(/\bspecs\/scheme_exact_ycash\.md/g, "specs/schemes/exact/scheme_exact_ycash.md");
  s = s.replace(/\bspecs\/scheme_batch_settlement_ycash\.md/g, "specs/schemes/batch-settlement/scheme_batch_settlement_ycash.md");
  return s;
}

function rewriteLine(line) {
  // a test title is prose: the first string literal of it(…) / describe(…)
  const title = line.match(/^(\s*(?:it|describe|describeDevnet|test)(?:\.\w+)?\(\s*)(["'`])((?:\\.|(?!\2).)*)\2(.*)$/);
  if (title) {
    const [, head, q, body, rest] = title;
    const [code, comment] = splitComment(rest);
    return `${head}${q}${rewriteProse(body)}${q}${code}${rewriteProse(comment)}`;
  }
  const [code, comment] = splitComment(line);
  return code + rewriteProse(comment);
}

function transformCode(dir) {
  for (const file of walk(dir)) {
    const before = readFileSync(file, "utf8");
    let s = before;
    // relative imports and re-exports: drop ".js"; batch → batch-settlement
    s = s.replace(/(from\s+|import\s*\(\s*)"(\.{1,2}\/[^"]*)"/g, (_m, kw, path) => {
      let p = path.replace(/\.js$/, "");
      p = p.replace(/(^|\/)batch(?=\/|$)/g, "$1batch-settlement");
      return `${kw}"${p}"`;
    });
    // vectors: <repo>/vectors/… → <package>/test/vectors/… (tests sit in test/unit/)
    s = s.replace(/"(?:\.\.\/){4}vectors\//g, '"../vectors/');
    // the cross-process store test spawns tsx: pnpm puts it in the package's own node_modules
    s = s.replace('"../../../../../node_modules/.bin/tsx"', '"../../../node_modules/.bin/tsx"');
    s = rewriteParens(s);
    s = s.split("\n").map(rewriteLine).join("\n");
    if (s !== before) writeFileSync(file, s);
    s.split("\n").forEach((l, i) => {
      if (/\bplan\b\s*[§X]|X-F\d|docs\/plans|ycash-dd(?![-.\w])|\bycash6\b(?![-.\w])|yellowback-workspace|BRIEFING/.test(l)) leftovers.push(`${file}:${i + 1}: ${l.trim()}`);
    });
  }
}

// Exact replacements in a spec; each must match once, or the source changed and this script needs
// a look (the run fails rather than staging a half-rewritten spec).
function replaceOnce(s, from, to, file) {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`${file}: expected one occurrence of ${JSON.stringify(from.slice(0, 60))}, found ${n}`);
  return s.replace(from, to);
}

const NODE_TREES = [
  "Line numbers are taken at two public trees of the Ycash node, each the stock node plus the",
  "Yellowback overlay that YED needs:",
  "",
  "- **Ycash 4.5.0**: [`boyfromcave/ycash-dd`](https://github.com/boyfromcave/ycash-dd) at commit",
  "  `795f29b1eee4b5cc6f9308f3cb801f825479276a`, on",
  "  [`ycashfoundation/ycash`](https://github.com/ycashfoundation/ycash) tag `v4.5.0`.",
  "- **Ycash 6.21.0**: [`boyfromcave/ycash6`](https://github.com/boyfromcave/ycash6) at commit",
  "  `e6c49d743849930089e9c04b2aad04e192e873ea` (6.21.0-rc1), on",
  "  [`miodragpop/ycash`](https://github.com/miodragpop/ycash) `dev-rebase-6.20.0` (`040894344b`).",
  "",
  "Rows R, S, Z and G describe the stock node and hold without the overlay; rows Y are the",
  "overlay's and matter only for YED. \"Same\" means the same code at the same line.",
].join("\n");

function transformSpec(file, which) {
  let s = readFileSync(file, "utf8");
  const header = "| # | Behaviour | `ycash-dd` (4.5.0) | `ycash6` (6.21.0) |";
  s = replaceOnce(s, header, "| # | Behaviour | Ycash 4.5.0 | Ycash 6.21.0 |", file);
  if (which === "exact") {
    s = replaceOnce(s, "(`sapling`, plan X4b)", "(`sapling`)", file);
    s = replaceOnce(s, "It uses stock RPCs on both node lines. This is plan X4a.", "It uses stock RPCs on both node lines.", file);
    s = replaceOnce(s, "`sapling` (plan X4b): a facilitator-submitted", "`sapling`: a facilitator-submitted", file);
    s = replaceOnce(s, "](./scheme_batch_settlement_ycash.md)", "](../batch-settlement/scheme_batch_settlement_ycash.md)", file);
    s = s.replace(
      /Checked on (\d{4}-\d{2}-\d{2}) against `ycash-dd`[\s\S]*?§3\)\.\n/,
      (_m, date) => `Checked on ${date}. ${NODE_TREES}\n`,
    );
  } else {
    s = replaceOnce(s, "(https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md)", "(./scheme_batch_settlement.md)", file);
    s = s.replaceAll("](./scheme_exact_ycash.md", "](../exact/scheme_exact_ycash.md");
    s = replaceOnce(s, "in zatoshis (plan X2).", "in zatoshis.", file);
    s = replaceOnce(s, "in cents (plan X3).", "in cents.", file);
    s = replaceOnce(
      s,
      "The split, the floor and their vectors are in the SDK's `yed` module\n(`yedChannelSplit`, `isValidYedVoucherCumulative`) and `vectors/yed/dollar_floor.json`.",
      "The reference implementation carries the split and the floor (`yedChannelSplit`,\n`isValidYedVoucherCumulative`) with test vectors (`test/vectors/yed/dollar_floor.json`).",
      file,
    );
    s = s.replace(
      /Checked on (\d{4}-\d{2}-\d{2}) against `ycash-dd`[\s\S]*?\(Ycash 6\.21\.0-rc1\)\. "Same" means the same code at the same line\. /,
      (_m, date) => `Checked on ${date}. ${NODE_TREES}\n\n`,
    );
  }
  const internal = /(?<!boyfromcave\/)ycash-dd(?!`\])|`ycash6`|\bplan\b\s*[§X]|X-F\d|docs\/plans/;
  s.split("\n").forEach((l, i) => {
    if (internal.test(l)) leftovers.push(`${file}:${i + 1}: ${l.trim()}`);
  });
  writeFileSync(file, s);
}

if (mode === "code") transformCode(target);
else if (mode === "spec") transformSpec(target, kind);
else {
  console.error("usage: transform.mjs code <dir> | spec <file> exact|batch");
  process.exit(2);
}
if (leftovers.length) {
  console.log(`transform: ${leftovers.length} line(s) still name this repository's plan or node checkouts:`);
  for (const l of leftovers) console.log(`  ${l}`);
}
