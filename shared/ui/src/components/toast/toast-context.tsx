import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect } from "react";
import { FlashToastKey, Toast, ToastContextValue } from "./types";
import { useSearchParams } from "../../hooks";

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }

  return context;
};

interface ToastProviderProps {
  children: ReactNode;
  withFlash?: boolean;
}

export const ToastProvider = ({ children, withFlash = false }: ToastProviderProps) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const searchParams = useSearchParams();
  const toastError = searchParams.get(FlashToastKey.Error);
  const toastSuccess = searchParams.get(FlashToastKey.Success);

  const addToast = useCallback((toast: Omit<Toast, "id">) => {
    const id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const newToast: Toast & { duration: number } = {
      ...toast,
      id,
      duration: toast.duration ?? 5000,
    };

    setToasts((prevToasts) => [...prevToasts, newToast]);

    if (newToast.duration > 0) {
      setTimeout(() => {
        removeToast(id);
      }, newToast.duration);
    }
  }, []);

  const removeToast = useCallback(
    (id: string) => {
      const toast = toasts.find((toast) => toast.id === id);
      if (!toast) return;

      setToasts((prevToasts) => prevToasts.filter(({ id }) => toast.id !== id));

      toast.onClose?.();
    },
    [toasts],
  );

  const clearAllToasts = useCallback(() => {
    setToasts([]);
  }, []);

  useEffect(() => {
    if (!withFlash) return;

    if (toastError) {
      addToast({
        variant: "danger",
        message: toastError,
        onClose: () => {
          searchParams.remove(FlashToastKey.Error);
        },
      });
    }

    if (toastSuccess) {
      addToast({
        variant: "success",
        message: toastSuccess,
        onClose: () => {
          searchParams.remove(FlashToastKey.Success);
        },
      });
    }
  }, []);

  const contextValue: ToastContextValue = {
    toasts,
    addToast,
    removeToast,
    clearAllToasts,
  };

  return <ToastContext.Provider value={contextValue}>{children}</ToastContext.Provider>;
};
