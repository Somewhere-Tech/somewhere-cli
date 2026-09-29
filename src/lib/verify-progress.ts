/** Human progress is separate from the result and never retries the operation. */
export async function withVerifyProgress<T>(run: () => Promise<T>, human: boolean): Promise<T> {
  const timer = human ? setTimeout(() => {
    process.stderr.write('Verification is still running after 60 seconds. Waiting for its result; do not restart the actions.\n');
  }, 60_000) : undefined;
  timer?.unref();
  try {
    return await run();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
