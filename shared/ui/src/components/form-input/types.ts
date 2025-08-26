import { HTMLElementProps } from "../types";

export type FormFieldValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | string[];
export type FormFieldType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "toggle"
  | "email"
  | "phone"
  | "date"
  | "select"
  | "multiselect"
  | "password"
  | "url"
  | "image-url";
export type FormFieldOption = { label: string; value: FormFieldValue };

export interface BaseInput<T extends FormFieldValue = FormFieldValue>
  extends HTMLElementProps {
  id: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  default?: FormFieldValue;
  options?: FormFieldOption[];

  value: T;
  onChange: (value: T) => void;
  error?: string;
}
