// Where a lightwalletd server is and how to reach it. lightwalletd serves gRPC over TLS by default
// and plaintext only with --no-tls-very-insecure (lightwalletd-dd/cmd/root.go), which is what a
// devnet or a server on the same host runs; a public server (lite.ycash.xyz) is TLS on 443.

export interface LwdEndpoint {
  /** gRPC target, `host:port`. */
  target: string;
  tls: boolean;
}

/** lightwalletd's default gRPC port (lightwalletd-dd/cmd/root.go `--grpc-bind-addr`). */
export const LWD_DEFAULT_PORT = 9067;

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Parses `grpcs://host[:port]` / `https://…` (TLS), `grpc://host[:port]` / `http://…` (plaintext),
 * or a bare `host[:port]`: TLS unless the host is loopback, since a plaintext server is only ever
 * run beside its client. A missing port is 443 for TLS and 9067 for plaintext.
 */
export function parseLwdUrl(url: string): LwdEndpoint {
  const m = /^(?:(grpcs?|https?):\/\/)?(\[[0-9a-f:]+\]|[^\s:/[\]]+)(?::(\d{1,5}))?\/?$/i.exec(url.trim());
  if (!m) throw new Error(`not a lightwalletd address: ${JSON.stringify(url)} (want host:port, grpc://host:port or grpcs://host:port)`);
  const scheme = m[1]?.toLowerCase();
  const host = m[2] as string;
  const tls = scheme === undefined ? !LOOPBACK.test(host) : scheme === "grpcs" || scheme === "https";
  const port = m[3] === undefined ? (tls ? 443 : LWD_DEFAULT_PORT) : Number(m[3]);
  if (port < 1 || port > 65_535) throw new Error(`lightwalletd port out of range: ${url}`);
  return { target: `${host}:${port}`, tls };
}
