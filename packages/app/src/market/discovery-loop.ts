import { MarketIndexer } from "./indexer.js";

/** Serial ingestion; drain the active job before closing the database. */
export class MarketDiscoveryLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private stopped = true;
  constructor(private readonly indexer: Pick<MarketIndexer, "runOnce">, private readonly intervalMs = 10000) {}
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.tick();
  }
  private tick() {
    this.pending = this.indexer.runOnce().then(() => {}, () => {
      console.warn("[market] discovery pass failed; will retry");
    }).finally(() => {
      this.pending = undefined;
      if (!this.stopped) {
        this.timer = setTimeout(() => this.tick(), this.intervalMs);
        this.timer.unref?.();
      }
    });
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
  }
}
