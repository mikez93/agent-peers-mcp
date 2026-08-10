// shared/async-lock.ts
// Minimal promise-chain mutex. JS is single-threaded, so awaiting the
// previous holder's release is sufficient mutual exclusion for async critical
// sections (piggyback draw, inbox store writes). FIFO by construction.

export function createAsyncLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<void> = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = chain;
    let release!: () => void;
    chain = new Promise<void>((r) => { release = r; });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
