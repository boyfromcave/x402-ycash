// Whether the merchant may sell its YED routes. A facilitator lists YED in /supported only when its
// node runs the Yellowback overlay (spec "/supported"); the channel route also needs the merchant's
// own node to run it, since the server checks each voucher with yed_validaterawtransaction.
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { ASSET_YED, type YcashNetwork } from "x402-ycash-mechanism";
import type { YedConfig } from "./config.js";
import type { YedModes } from "./schemes.js";

/** The parts of the merchant's node the probe reads. */
export interface YedNode {
  capabilities(): Promise<{ yellowback: boolean }>;
}

export type Log = (msg: string, fields?: Record<string, unknown>) => void;

/** True when the facilitator's `exact` kind on `network` lists YED among its assets. */
export async function facilitatorListsYed(facilitator: FacilitatorClient, network: YcashNetwork): Promise<boolean> {
  const supported = await facilitator.getSupported();
  return supported.kinds.some((k) => {
    const assets = k.extra?.assets;
    return k.scheme === "exact" && k.network === network && Array.isArray(assets) && assets.includes(ASSET_YED);
  });
}

/**
 * The YED modes to serve. Each failure turns YED off with a log line rather than stopping the
 * merchant: its YEC routes do not depend on the overlay.
 */
export async function probeYed(yed: YedConfig, facilitator: FacilitatorClient, network: YcashNetwork, node: YedNode | undefined, log: Log): Promise<YedModes> {
  const off: YedModes = { exact: false, channel: false, maxDepositCents: yed.maxDepositCents };
  let listed: boolean;
  try {
    listed = await facilitatorListsYed(facilitator, network);
  } catch (e) {
    log("YED routes off", { reason: `the facilitator's /supported failed: ${(e as Error).message}` });
    return off;
  }
  if (!listed) {
    log("YED routes off", { reason: "the facilitator does not list YED (its node does not run -yellowback)" });
    return off;
  }
  let channel = false;
  try {
    channel = node !== undefined && (await node.capabilities()).yellowback;
  } catch (e) {
    log("YED channel route off", { reason: `the merchant's node: ${(e as Error).message}` });
  }
  if (!channel && node !== undefined) log("YED channel route off", { reason: "the merchant's node does not run -yellowback" });
  return { exact: true, channel, maxDepositCents: yed.maxDepositCents };
}

export interface YedGateOptions {
  /** Re-probe this often (default 60 s), so YED comes on when the facilitator starts after the merchant. */
  intervalMs?: number;
  /** A request to an off YED route re-probes at most this often (default 5 s). */
  minGapMs?: number;
  log?: Log;
}

/**
 * The YED modes as last probed, re-probed periodically and on demand (a request to a YED route
 * that is off), so a facilitator or node that comes up after the merchant turns YED on without a
 * restart, and one that goes away turns it off.
 */
export class YedGate {
  private current: YedModes;
  private inflight: Promise<YedModes> | undefined;
  private last = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly intervalMs: number;
  private readonly minGapMs: number;

  constructor(
    initial: YedModes,
    private readonly probe: () => Promise<YedModes>,
    private readonly opts: YedGateOptions & {
      /** Called after a probe that changed the modes (the merchant reloads its facilitator kinds). */
      onChange?: (modes: YedModes) => Promise<void>;
    } = {},
  ) {
    this.current = initial;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.minGapMs = opts.minGapMs ?? 5_000;
  }

  get modes(): YedModes {
    return this.current;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(true), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Probes again (one probe at a time; on demand at most every minGapMs unless forced). */
  async refresh(force = false): Promise<YedModes> {
    if (this.inflight) return this.inflight;
    if (!force && Date.now() - this.last < this.minGapMs) return this.current;
    this.last = Date.now();
    this.inflight = this.probe()
      .then(async (m) => {
        const changed = m.exact !== this.current.exact || m.channel !== this.current.channel;
        if (changed) {
          this.opts.log?.("YED routes changed", { exact: m.exact, channel: m.channel });
          await this.opts.onChange?.(m);
        }
        this.current = m;
        return m;
      })
      .catch(() => this.current) // probeYed logs and returns "off"; anything else keeps the last view
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
}

/**
 * The merchant's facilitator client, remembering the last `/supported` it fetched. The resource
 * server reads the facilitator's kinds (and so its YED asset list) once, at initialize; when a
 * re-probe sees them change, `reload` re-initializes it from the response the probe just fetched,
 * so no request can run between the old kinds being cleared and the new ones loaded.
 */
export class SupportedCache implements FacilitatorClient {
  private last: SupportedResponse | undefined;
  private serveLast = false;

  constructor(private readonly inner: FacilitatorClient) {}

  async getSupported(): Promise<SupportedResponse> {
    if (this.serveLast && this.last) {
      this.serveLast = false;
      return this.last;
    }
    this.last = await this.inner.getSupported();
    return this.last;
  }

  verify: FacilitatorClient["verify"] = (...a) => this.inner.verify(...a);
  settle: FacilitatorClient["settle"] = (...a) => this.inner.settle(...a);

  /** Runs `initialize` with the last fetched `/supported` served without a network round trip. */
  async reload(initialize: () => Promise<void>): Promise<void> {
    this.serveLast = this.last !== undefined;
    try {
      await initialize();
    } finally {
      this.serveLast = false;
    }
  }
}
