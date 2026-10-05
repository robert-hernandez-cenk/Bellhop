// A test-controlled gate (constitution Principle III): a test forces an
// ordering by awaiting `promise` on one side and calling `open()` on the
// other, never by a wall-clock wait.
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
