export const indexBy = <T>(array: T[], index: keyof T | ((item: T) => string)): Record<string, T> => {
  return array.reduce(
    (acc, item) => {
      const key = typeof index === "function" ? index(item) : (item[index] as string);
      acc[key] = item;
      return acc;
    },
    {} as Record<string, T>,
  );
};
