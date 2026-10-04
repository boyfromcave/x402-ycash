// A small tip watcher for channels (specs/scheme_batch_settlement_ycash.md, "Security
// Considerations": the margin and a watcher on tip height are REQUIRED for a server). It warns once
// per channel when the tip reaches t − closeMarginBlocks and hands the channel to `onMargin` (the
// server closes; the client tooling warns, and refunds from t).

export interface WatchedChannel {
  channelId: string;
  refundHeight: number;
  closeMarginBlocks: number;
}

export interface ChannelWatcherOptions {
  tip: () => Promise<number>;
  channels: () => Promise<Iterable<WatchedChannel>>;
  onMargin: (ch: WatchedChannel, tip: number) => Promise<void>;
  /** Also called each tick, after the margin checks (the server's idle sweep). */
  onTick?: (tip: number) => Promise<void>;
  warn?: (msg: string) => void;
  pollMs?: number;
}

export class ChannelWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private readonly warned = new Set<string>();

  constructor(private readonly opts: ChannelWatcherOptions) {}

  /** One pass; returns the channels at or past their margin. */
  async check(): Promise<WatchedChannel[]> {
    const tip = await this.opts.tip();
    const due: WatchedChannel[] = [];
    for (const ch of await this.opts.channels()) {
      if (tip < ch.refundHeight - ch.closeMarginBlocks) continue;
      due.push(ch);
      if (!this.warned.has(ch.channelId)) {
        this.warned.add(ch.channelId);
        (this.opts.warn ?? console.warn)(
          `channel ${ch.channelId}: tip ${tip} reached t − margin = ${ch.refundHeight - ch.closeMarginBlocks} (t = ${ch.refundHeight})`,
        );
      }
      await this.opts.onMargin(ch, tip);
    }
    await this.opts.onTick?.(tip);
    return due;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.running ??= this.check()
        .then(() => undefined)
        .catch((e: unknown) => (this.opts.warn ?? console.warn)(`channel watcher: ${String(e)}`))
        .finally(() => (this.running = undefined));
    }, this.opts.pollMs ?? 15_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
