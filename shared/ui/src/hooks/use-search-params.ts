import { useCallback } from "react";

export const useSearchParams = () => {
  const get = useCallback((param: string): string | null => {
    const searchParams = new URLSearchParams(window.location.search);
    return searchParams.get(param);
  }, []);

  const set = useCallback((param: string, value: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set(param, value);
    history?.replaceState(null, "", url);
  }, []);

  const remove = useCallback((param: string) => {
    const url = new URL(window.location.href);
    url.searchParams.delete(param);
    history?.replaceState(null, "", url);
  }, []);

  return { get, set, remove };
};

export const useSearchParam = (param: string): string | null => {
  const searchParams = useSearchParams();
  return searchParams.get(param);
};
