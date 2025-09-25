export type BaseProfile = Record<string, string | number | boolean | null | undefined | string[]>;

export type BaseField<T extends BaseProfile[string] = BaseProfile[string]> = {
  id: string;
  default?: BaseProfile[string];
};

export type BaseFormField<T extends BaseProfile[string] = BaseProfile[string]> = BaseField<T> & {
  label: string;
  placeholder?: string;
  required?: boolean;
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
    | "image-url"
    | "toggle";
  options?: { label: string; value: T }[];
  order?: number;
};

export type BaseFormSection = {
  id: string;
  label: string;
  description?: string;
  fields: BaseFormField[];
};

export type BaseFormFieldSet = Record<string, Omit<BaseFormField, "id">>;

export type BaseFormFieldPayload<T extends BaseProfile[string] = BaseProfile[string]> = {
  sectionId: string;
  fieldId: string;
  value: T;
};
