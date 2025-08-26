import { useMemo } from "react";
import { getQuerier } from "@shared/react";

export const useQuerier = (basePath: string) => {
  const querier = useMemo(() => getQuerier(basePath), [basePath]);
  return querier;
};
