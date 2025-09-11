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
export const StringFieldComponent = ({ value, onChange, error, className, ...field }: BaseInput<string>) => (
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
export const TextFieldComponent = ({ value, onChange, error, className, ...field }: BaseInput<string>) => (
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
export const NumberFieldComponent = ({ value, onChange, error, className, ...field }: BaseInput<number | "">) => (
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
export const BooleanFieldComponent = ({ value, onChange, error, className, ...field }: BaseInput<boolean>) => (
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
export const EmailFieldComponent = ({ value, onChange, error, className, ...field }: BaseInput<string>) => (
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
export const PhoneFieldComponent = ({ value, onChange, error, className, ...field }: BaseInput<string>) => (
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
export const DateFieldComponent = ({ value, onChange, error, className, ...field }: BaseInput<string>) => (
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
export const SelectFieldComponent = ({ value, onChange, error, className, ...field }: BaseInput<string>) => (
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
export const MultiselectFieldComponent = ({ value, onChange, error, className, ...field }: BaseInput<string[]>) => (
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

export const PasswordFieldComponent = ({ value, onChange, error, className, ...field }: BaseInput<string>) => {
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
export const UrlFieldComponent = ({ value, onChange, error, className, ...field }: BaseInput<string>) => (
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
export const ImageUrlFieldComponent = ({ value, onChange, error, className, ...field }: BaseInput<string>) => (
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
