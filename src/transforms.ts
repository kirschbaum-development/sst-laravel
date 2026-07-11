/**
 * The two shapes SST accepts for a `transform` entry: a partial args object
 * that is shallow-merged over the defaults, or a callback that mutates the
 * args in place.
 */
export type TransformValue<T> =
  | Partial<T>
  | ((args: T, opts: unknown, name: string) => void);

function applyTransformValue<T extends object>(
  transformValue: TransformValue<T>,
  args: T,
  opts: unknown,
  name: string,
): void {
  if (typeof transformValue === 'function') {
    transformValue(args, opts, name);
    return;
  }

  Object.assign(args, transformValue);
}

/**
 * Chains two transform entries into one. The first transform runs before the
 * second, so the second (typically the user-provided one) can observe and
 * override whatever the first set.
 */
export function chainTransforms<T extends object>(
  first: TransformValue<T> | undefined,
  second: TransformValue<T> | undefined,
): TransformValue<T> | undefined {
  if (first === undefined) {
    return second;
  }

  if (second === undefined) {
    return first;
  }

  return (args, opts, name) => {
    applyTransformValue(first, args, opts, name);
    applyTransformValue(second, args, opts, name);
  };
}

/**
 * Merges two service `transform` maps key by key. Keys present in both are
 * chained (base first, then overrides), so package-generated transforms
 * compose with user-provided ones instead of clobbering them.
 */
export function mergeServiceTransforms<
  T extends Record<string, TransformValue<any> | undefined>,
>(base: T | undefined, overrides: T | undefined): T {
  const keys = new Set([
    ...Object.keys(base ?? {}),
    ...Object.keys(overrides ?? {}),
  ]);
  const merged: Record<string, TransformValue<any> | undefined> = {};

  for (const key of keys) {
    merged[key] = chainTransforms(base?.[key], overrides?.[key]);
  }

  return merged as T;
}
