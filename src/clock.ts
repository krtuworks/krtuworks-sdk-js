import { uuidV7 } from './ids.js';

/**
 * Time as the server reads it: each record carries the device's wall clock, this launch's
 * id, the time since the launch (monotonic, immune to clock changes) and, once the server has answered,
 * how far the device clock is from the server's. The server takes the age from the monotonic time within
 * a launch and from the offset across launches; a record is never refused for its time.
 */
export class Clock {
  readonly launchId = uuidV7();
  private readonly started = performance.now();
  private offset: number | null = null;

  /** Milliseconds since this launch began. */
  monotonicMs(): number {
    return Math.max(0, Math.round(performance.now() - this.started));
  }

  /** Server time minus device time, once known. */
  get serverOffsetMs(): number | null {
    return this.offset;
  }

  /** The server's clock now, as well as it is known. */
  serverNow(): number {
    return Date.now() + (this.offset ?? 0);
  }

  /** Learns the offset from a server timestamp (`serverTime` in an answer or the `Date` header). */
  noteServerTime(value: string | null | undefined): void {
    if (!value) return;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) this.offset = ms - Date.now();
  }
}
