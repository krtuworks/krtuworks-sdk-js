const tails = new Map<string, Promise<void>>();

/**
 * Runs `fn` while holding `name`: across the origin's tabs with the Web Locks API, otherwise inside this
 * process. Token refreshes and queue writes go through here, so two tabs never spend one refresh token
 * or freeze the same events twice.
 */
export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (locks) return locks.request(name, fn) as Promise<T>;
  const previous = tails.get(name) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(name, tail);
  void tail.then(() => {
    if (tails.get(name) === tail) tails.delete(name);
  });
  return run;
}
