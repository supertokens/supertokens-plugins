import { BaseWaVariant } from "../types";

export enum FlashToastKey {
  Error = "em",
  Success = "sm",
}

export interface Toast {
  id: string;
  variant?: "success" | "warning" | "danger";
  message: string;
  duration?: number;
  onClose?: () => void;
}

export interface ToastContextValue {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
  clearAllToasts: () => void;
}
