/** Invalidating requests happens immediately; only duplicate UI notifications are coalesced. */
export function accountEventNotifier(emit: (epoch: string) => void, delay = 100): (epoch: string) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return epoch => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; emit(epoch); }, delay);
  };
}
