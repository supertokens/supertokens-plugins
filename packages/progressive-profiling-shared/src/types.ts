export type FormFieldValue = string | number | boolean | null | undefined | string[];

export type FormField = {
  id: string;
  label: string;
  type:
    | "string"
    | "text"
    | "number"
    | "boolean"
    | "email"
    | "phone"
    | "date"
    | "select"
    | "multiselect"
    | "password"
    | "url"
    | "image-url";
  required: boolean;
  defaultValue?: FormFieldValue;
  placeholder?: string;
  description?: string;
  options?: { value: FormFieldValue; label: string }[];
};

export type FormSection = {
  id: string;
  label: string;
  description?: string;
  fields: FormField[];
  completed: boolean;
};

export type ProfileFormData = { sectionId: string; fieldId: string; value: FormFieldValue }[];
