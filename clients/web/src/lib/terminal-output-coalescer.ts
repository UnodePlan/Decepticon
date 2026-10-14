/**
 * Terminal output coalescing for xterm.
 *
 * A chatty agent frame emits hundreds of small WebSocket messages per second
 * (each Ink repaint arrives as many ~300-char fragments). Passing every
 * fragment straight to `term.write()` makes xterm run its write/render
 * bookkeeping once per fragment: measured in headless Chromium at 180 frames ×
 * 8 fragments, the visible terminal received 8142 DOM mutations from 1440
 * `write()` calls. Joining the fragments of one frame into a single write kept
 * the bytes and their order identical (same buffer digest, 377508 chars) while
 * dropping that to 180 calls / 1409 mutations, and the two hidden mode panes
 * from 1440 calls each to 180.
 *
 * Order is preserved by appending in arrival order. Every batch is bounded by
 * both a byte cap and a wall-clock deadline, so a throttled background tab
 * (where `requestAnimationFrame` may not fire) can never hold output.
 */

/** A batch is flushed as soon as it reaches this size, even mid-frame. */
const WRITE_FLUSH_MAX_BYTES = 256 * 1024;

/** A batch is flushed at the latest this long after its first fragment. */
const WRITE_FLUSH_MAX_DELAY_MS = 50;

/**
 * A scheduled timer as the host reports it: a number in browsers, an object in
 * the Node test harness. Consumers of this module store handles for their own
 * `clearTimeout` calls, so the name is exported rather than re-derived.
 */
export type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Batches terminal output fragments into single writes, frame-aligned when the
 * host has `requestAnimationFrame` and time-bounded otherwise.
 *
 * `scheduleFrame` is null in environments without rAF (jsdom without
 * `pretendToBeVisual`): `push()` then writes straight through, so behaviour
 * there is byte-identical to a plain `term.write()` per message. The deadline
 * timer is the backstop for a throttled background tab, where a scheduled frame
 * may not arrive for a long time.
 */
export class TerminalWriteCoalescer {
  private chunks: string[] = [];
  private chunkBytes = 0;
  private frame: number | null = null;
  private timer: TimerHandle | null = null;

  constructor(
    private readonly write: (data: string) => void,
    private readonly scheduleFrame: ((callback: () => void) => number) | null,
    private readonly cancelFrame: ((handle: number) => void) | null,
  ) {}

  push(data: string): void {
    if (!data) return;
    if (!this.scheduleFrame) {
      this.write(data);
      return;
    }
    this.chunks.push(data);
    this.chunkBytes += data.length;
    if (this.chunkBytes >= WRITE_FLUSH_MAX_BYTES) {
      this.flush();
      return;
    }
    this.schedule();
  }

  /** Writes everything buffered, in arrival order. */
  flush(): void {
    this.cancelScheduled();
    if (this.chunkBytes === 0) return;
    const data = this.chunks.join("");
    this.chunks = [];
    this.chunkBytes = 0;
    this.write(data);
  }

  /** Discards buffered output (teardown, or a reset that invalidates it). */
  drop(): void {
    this.cancelScheduled();
    this.chunks = [];
    this.chunkBytes = 0;
  }

  private schedule(): void {
    if (this.frame !== null || this.timer !== null) return;
    this.frame = this.scheduleFrame?.(() => {
      this.frame = null;
      this.flush();
    }) ?? null;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, WRITE_FLUSH_MAX_DELAY_MS);
  }

  private cancelScheduled(): void {
    if (this.frame !== null) {
      this.cancelFrame?.(this.frame);
      this.frame = null;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
