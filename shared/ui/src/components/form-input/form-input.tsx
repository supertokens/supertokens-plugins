import React, { useMemo } from "react";
import { BaseInput, FormFieldValue } from "./types";
import { StringFieldComponent } from "./field-components";

export type FormInputComponentMap<T extends FormFieldValue> = Record<
  string,
  React.FC<BaseInput<T>>
>;

type FormInputProps<
  K extends FormFieldValue,
  T extends FormInputComponentMap<K>
> = BaseInput<K> & {
  userContext?: any;
  value: any;
  onChange: (value: K) => void;
  componentMap: T;
  type: keyof T;
};

export const FormInput = ({
  value,
  onChange,
  userContext,
  componentMap,
  className,
  ...field
}: FormInputProps<FormFieldValue, FormInputComponentMap<FormFieldValue>>) => {
  const FieldComponent = useMemo(
    () => componentMap[field.type] || StringFieldComponent,
    [componentMap, field.type]
  );

  return (
    <FieldComponent
      {...field}
      value={value}
      onChange={onChange}
      className={className}
    />
  );
};
