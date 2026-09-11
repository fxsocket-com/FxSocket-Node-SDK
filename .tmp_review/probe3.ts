function isAccountRef(value: unknown): boolean {
  if (typeof value === 'string') return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    !('accountId' in (value as object))
  );
}
console.log('a', isAccountRef({ id: 'acc_9' }));
console.log('b', isAccountRef({ id: 'acc_9', nickname: 'n', platform: 'mt5' }));
