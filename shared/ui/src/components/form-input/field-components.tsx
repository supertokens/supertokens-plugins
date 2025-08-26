import React from "react";
import { TextInput } from "./text-input";
import { TextareaInput } from "./textarea-input";
import { SelectInput } from "./select-input";
import { CheckboxInput } from "./checkbox-input";
import { MultiSelectInput } from "./multiselect-input";
import { NumberInput } from "./number-input";
import { DateInput } from "./date-input";
import { ImageUrlInput } from "./image-url-input";
import { BaseInput } from "./types";
import { PasswordInput } from "./password-input";

// String field component
export const StringFieldComponent = ({
  value,
  onChange,
  error,
  className,
  ...field
}: BaseInput<string>) => (
  <TextInput
    id={field.id}
    label={field.label}
    type="text"
    value={value}
    onChange={onChange}
    placeholder={field.placeholder}
    required={field.required}
    error={error}
    className={className}
  />
);

// Text field component (textarea)
export const TextFieldComponent: React.FC<BaseInput<string>> = ({
  value,
  onChange,
  error,
  className,
  ...field
}) => (
  <TextareaInput
    id={field.id}
    label={field.label}
    value={value}
    onChange={onChange}
    placeholder={field.placeholder}
    required={field.required}
    error={error}
    className={className}
  />
);

// Number field component
export const NumberFieldComponent: React.FC<BaseInput<number | "">> = ({
  value,
  onChange,
  error,
  className,
  ...field
}) => (
  <NumberInput
    id={field.id}
    label={field.label}
    value={value}
    onChange={onChange}
    placeholder={field.placeholder}
    required={field.required}
    error={error}
    className={className}
  />
);

// Boolean field component
export const BooleanFieldComponent: React.FC<BaseInput<boolean>> = ({
  value,
  onChange,
  error,
  className,
  ...field
}) => (
  <CheckboxInput
    id={field.id}
    label={field.label}
    value={value}
    onChange={onChange}
    error={error}
    className={className}
  />
);

// Email field component
export const EmailFieldComponent: React.FC<BaseInput<string>> = ({
  value,
  onChange,
  error,
  className,
  ...field
}) => (
  <TextInput
    id={field.id}
    label={field.label}
    type="email"
    value={value}
    onChange={onChange}
    placeholder={field.placeholder}
    required={field.required}
    error={error}
    className={className}
  />
);

// Phone field component
export const PhoneFieldComponent: React.FC<BaseInput<string>> = ({
  value,
  onChange,
  error,
  className,
  ...field
}) => (
  <TextInput
    id={field.id}
    label={field.label}
    type="tel"
    value={value}
    onChange={onChange}
    placeholder={field.placeholder}
    required={field.required}
    error={error}
    className={className}
  />
);

// Date field component
export const DateFieldComponent: React.FC<BaseInput<string>> = ({
  value,
  onChange,
  error,
  className,
  ...field
}) => (
  <DateInput
    id={field.id}
    label={field.label}
    value={value}
    onChange={onChange}
    required={field.required}
    error={error}
    className={className}
  />
);

// Select field component
export const SelectFieldComponent: React.FC<BaseInput<string>> = ({
  value,
  onChange,
  error,
  className,
  ...field
}) => (
  <SelectInput
    id={field.id}
    label={field.label}
    value={value}
    onChange={onChange}
    options={
      field.options?.map((option) => ({
        label: option.label,
        value: option.value?.toString() || "",
      })) || []
    }
    placeholder={field.placeholder || "Select an option"}
    required={field.required}
    error={error}
    className={className}
  />
);

// Multiselect field component
export const MultiselectFieldComponent: React.FC<BaseInput<string[]>> = ({
  value,
  onChange,
  error,
  className,
  ...field
}) => (
  <MultiSelectInput
    id={field.id}
    label={field.label}
    value={value}
    onChange={onChange}
    options={
      field.options?.map((option) => ({
        label: option.label,
        value: option.value?.toString() || "",
      })) || []
    }
    required={field.required}
    error={error}
    className={className}
  />
);

export const PasswordFieldComponent: React.FC<BaseInput<string>> = ({
  value,
  onChange,
  error,
  className,
  ...field
}) => {
  return (
    <PasswordInput
      id={field.id}
      label={field.label}
      value={value}
      onChange={onChange}
      placeholder={field.placeholder}
      required={field.required}
      error={error}
      className={className}
    />
  );
};

// URL field component
export const UrlFieldComponent: React.FC<BaseInput<string>> = ({
  value,
  onChange,
  error,
  className,
  ...field
}) => (
  <TextInput
    id={field.id}
    label={field.label}
    type="url"
    value={value}
    onChange={onChange}
    placeholder={field.placeholder}
    required={field.required}
    error={error}
    className={className}
  />
);

// Image URL field component
export const ImageUrlFieldComponent: React.FC<BaseInput<string>> = ({
  value,
  onChange,
  error,
  className,
  ...field
}) => (
  <ImageUrlInput
    id={field.id}
    label={field.label}
    value={value}
    onChange={onChange}
    placeholder={field.placeholder}
    required={field.required}
    error={error}
    className={className}
  />
);
