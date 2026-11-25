export function hasProperty<Key extends string>(
  value: unknown,
  key: Key,
): value is Record<Key, unknown> {
  return typeof value === 'object' && value !== null && key in value;
}
