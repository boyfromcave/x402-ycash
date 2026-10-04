// RFC 8785 JSON Canonicalization Scheme (JCS), for the `sapling-proof` request hash and the
// `offer-and-receipt` JWS payloads (the extension's §10 requires JCS for JWS payloads).
//
// Written here instead of taken as a dependency: the values hashed are flat objects of strings and
// integers, the whole algorithm is the forty lines below, and it is the same construction as the
// upstream Cardano mechanism's `masumi/jcs.ts`. Its three rules:
//   - members sorted by the UTF-16 code units of their names (JavaScript's default sort);
//   - numbers in ECMAScript Number::toString form (what JSON.stringify emits);
//   - strings with JSON escaping and the short forms for \b \t \n \f \r (JSON.stringify again).
// Anything JSON cannot represent (NaN, Infinity, bigint, functions, unpaired surrogates) is refused,
// since a silent coercion would give a hash the counterparty cannot reproduce.

/**
 * A JSON string literal, refusing unpaired surrogates that JSON.stringify would pass through as escapes.
 *
 * @param value - The string.
 * @returns The quoted, escaped string.
 * @throws Error on an unpaired surrogate.
 */
function serializeString(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0xd800 || code > 0xdfff) continue;
    const next = value.charCodeAt(i + 1);
    if (code > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) throw new Error("JCS: unpaired surrogate in string");
    i++;
  }
  return JSON.stringify(value);
}

/**
 * The canonical JSON text of a JSON value. A member whose value is undefined is absent; an undefined
 * array element becomes null.
 *
 * @param value - A JSON value.
 * @returns The RFC 8785 canonical text.
 * @throws Error for a non-finite number, a bigint, function or symbol, or an unpaired surrogate.
 */
export function jcs(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error(`JCS: non-finite number ${value}`);
      return JSON.stringify(value);
    case "string":
      return serializeString(value);
    case "object":
      break;
    default:
      throw new Error(`JCS: cannot serialize a ${typeof value}`);
  }
  if (Array.isArray(value)) return `[${value.map((v) => jcs(v === undefined ? null : v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
    .map((k) => `${serializeString(k)}:${jcs(record[k])}`);
  return `{${members.join(",")}}`;
}

/**
 * UTF-8 bytes of the canonical text, as hashed and signed.
 *
 * @param value - A JSON value.
 * @returns The UTF-8 encoding of {@link jcs}'s output.
 */
export function jcsBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(jcs(value));
}
