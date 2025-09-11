export const mapBy = <T, R>(
  array: T[],
  key: keyof T | ((item: T) => string | undefined),
  mapper: (item: T) => R,
): Record<string, R> => {
  return array.reduce(
    (acc, item) => {
      const _key = typeof key === "function" ? key(item) : (item[key] as string);
      if (!_key) {
        return acc;
      }

      acc[_key] = mapper(item);
      return acc;
    },
    {} as Record<string, R>,
  );
};
