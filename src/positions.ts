/**
 * The game reports where the player is as often as it likes (every frame is fine); this turns those
 * reports into one `position_sample` per interval, carrying the active seconds since the one before. The
 * "where players linger" heat map sums those seconds per cell. Time the game did not report (it stopped
 * sampling for a while, or the app was in the background) belongs to no position and is not told.
 */
export class PositionSampler {
  private since: number | null = null;

  constructor(private readonly everySeconds: number) {}

  /** The seconds a sample told now carries, or null when none is due; `active` is the launch's active seconds. */
  due(active: number): number | null {
    if (this.since === null || active < this.since) {
      this.since = active;
      return null;
    }
    const elapsed = active - this.since;
    if (elapsed > this.everySeconds * 3) {
      this.since = active;
      return null;
    }
    if (elapsed < this.everySeconds) return null;
    this.since = active;
    return Math.min(600, Math.max(1, Math.round(elapsed)));
  }

  /** Starts over: the next report only starts the clock (another player, a new launch). */
  reset(): void {
    this.since = null;
  }
}

/** The interval the game asked for, checked: whole seconds, 1-600; 10 when not given. */
export function sampleInterval(value: number | undefined): number {
  if (value === undefined) return 10;
  if (!Number.isInteger(value) || value < 1 || value > 600) throw new TypeError('positionSampleSeconds is a whole number of seconds, 1-600');
  return value;
}
