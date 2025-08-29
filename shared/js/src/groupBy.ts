export const groupBy = <T>(array: T[], key: keyof T | ((item: T) => string)): Record<string, T[]> => {
  return array.reduce(
    (acc, item) => {
      const _key = typeof key === "function" ? key(item) : (item[key] as string);
      acc[_key] = [...(acc[_key] ?? []), item];
      return acc;
    },
    {} as Record<string, T[]>,
  );
};
