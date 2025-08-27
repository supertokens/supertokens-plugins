import { useCallback } from "react";
import { useToast } from "../components/toast";

export const usePrettyAction = <T extends (...args: any[]) => any | Promise<any>>(
  action: T,
  deps: any[] = [],
  options: {
    successMessage?: string | ((...args: Parameters<T>) => string);
    errorMessage?: string | ((e: any, ...args: Parameters<T>) => string);
    setLoading?: (isLoading: boolean) => void;
    onSuccess?: (...args: any[]) => Promise<any>;
    onError?: (e: any) => Promise<any>;
  } = {},
): ReturnType<T> extends Promise<any>
  ? (...args: Parameters<T>) => ReturnType<T>
  : (...args: Parameters<T>) => Promise<ReturnType<T>> => {
  const { addToast } = useToast();

  const handleSuccess = useCallback(
    (...args: Parameters<T>) => {
      const message =
        typeof options.successMessage === "function"
          ? options.successMessage(...args)
          : (options.successMessage ?? "Action completed successfully");

      addToast({
        message,
        variant: "success",
        duration: 3000,
      });
    },
    [addToast, options.successMessage],
  );

  const handleError = useCallback(
    (e: any, ...args: Parameters<T>) => {
      const message =
        typeof options.errorMessage === "function"
          ? options.errorMessage(e, ...args)
          : (options.errorMessage ?? "An error occurred");

      addToast({
        message,
        variant: "danger",
        duration: 3000,
      });
    },
    [addToast, options.errorMessage],
  );

  const handleAction = useCallback(
    async (...args: Parameters<T>) => {
      options.setLoading?.(true);

      try {
        let res = action(...args);
        if (res instanceof Promise) {
          res = (await res) as Awaited<ReturnType<T>>;
        } else {
          res = res as ReturnType<T>;
        }

        if (options.successMessage) {
          handleSuccess(...args);
        }

        if (options.onSuccess) {
          await options.onSuccess();
        }

        return res as ReturnType<T> extends Promise<any> ? Awaited<ReturnType<T>> : ReturnType<T>;
      } catch (e) {
        handleError(e, ...args);

        if (options.onError) {
          await options.onError(e);
        }

        throw e;
      } finally {
        options.setLoading?.(false);
      }
    },
    [handleSuccess, handleError, ...deps],
  );

  // @ts-expect-error should be fixed by using the correct type
  return handleAction;
};
