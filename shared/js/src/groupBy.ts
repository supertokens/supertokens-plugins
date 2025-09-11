export const groupBy = <T>(array: T[], key: keyof T | ((item: T) => string | undefined)): Record<string, T[]> => {
  return array.reduce(
    (acc, item) => {
      const _key = typeof key === "function" ? key(item) : (item[key] as string);
      if (!_key) {
        return acc;
      }

      acc[_key] = [...(acc[_key] ?? []), item];
      return acc;
    },
    {} as Record<string, T[]>,
  );
};
