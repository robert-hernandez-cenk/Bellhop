// logWarn (src/lib/log.ts) writes through console.error, not console.warn.
export async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const originalError = console.error;
  const warnings: string[] = [];
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.error = originalError;
  }
}
