function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function logInfo(message: string): void {
  console.log(`[INFO  ${timestamp()}] ${message}`);
}

export function logWarn(message: string): void {
  console.error(`[WARN  ${timestamp()}] ${message}`);
}

export function logError(message: string): void {
  console.error(`[ERROR ${timestamp()}] ${message}`);
}
