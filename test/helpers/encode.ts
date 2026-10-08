/**
 * Waits until a fake ffmpeg has started (it signals once its output file is written), which is what
 * a test needs before it cancels or closes. Bounded, and it says why when it can't: the job ended
 * first (with its state and reason), or the encode never began. Polling the disk for the partial
 * file did neither: if the job failed early, or never ran, the test sat silent until the whole
 * test timeout and then reported only that.
 */
export async function encodeStarted(
  started: Promise<unknown>,
  ended?: Promise<{ state: string; reason?: string }>,
  timeoutMs = 10_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      started,
      ended?.then((job) => {
        throw new Error(`the job ended (${job.state}${job.reason ? `: ${job.reason}` : ""}) before ffmpeg started`);
      }) ?? new Promise<never>(() => undefined),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`ffmpeg hadn't started after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
