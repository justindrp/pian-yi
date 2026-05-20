export function calcTypingDelay(
  responseLength: number,
  baseSeconds: number,
  perCharSeconds: number,
  maxSeconds: number,
): number {
  return (
    Math.min(baseSeconds + responseLength * perCharSeconds, maxSeconds) * 1000
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
