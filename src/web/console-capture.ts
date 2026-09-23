let chain: Promise<unknown> = Promise.resolve();

export function withCapturedConsole<T>(
  fn: () => Promise<T>,
  onLine?: (line: string) => void
): Promise<{ text: string; result: T }> {
  const run = async (): Promise<{ text: string; result: T }> => {
    const lines: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    const capture = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      lines.push(line);
      onLine?.(line);
    };
    console.log = capture;
    console.error = capture;
    try {
      const result = await fn();
      return { text: lines.join('\n'), result };
    } finally {
      console.log = origLog;
      console.error = origError;
    }
  };
  const scheduled = chain.then(run, run);
  chain = scheduled.then(
    () => undefined,
    () => undefined
  );
  return scheduled;
}
