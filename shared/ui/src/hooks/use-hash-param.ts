import { useCallback } from "react";

export const useHashParam = () => {
  const get = useCallback((): string | null => {
    const hash = window.location.hash;
    const selectedParam = hash.split("#")[1];
    return selectedParam ?? null;
  }, []);

  const set = useCallback((value: string) => {
    const url = new URL(window.location.href);
    url.hash = `#${value}`;
    window.history.replaceState(null, "", url);
  }, []);

  const remove = useCallback(() => {
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(null, "", url);
  }, []);

  return {
    get,
    set,
    remove,
  };
};
