import {
  StringFieldComponent,
  TextFieldComponent,
  NumberFieldComponent,
  BooleanFieldComponent,
  EmailFieldComponent,
  PhoneFieldComponent,
  DateFieldComponent,
  SelectFieldComponent,
  MultiselectFieldComponent,
  PasswordFieldComponent,
  UrlFieldComponent,
  ImageUrlFieldComponent,
  ToggleInput,
} from "@shared/ui";

import { FormInputComponentMap } from "./types";

export const PLUGIN_ID = "supertokens-plugin-profile-details";
export const PLUGIN_VERSION = "0.0.1";

export const API_PATH = `plugin/${PLUGIN_ID}`;

export const FIELD_TYPE_COMPONENT_MAP: FormInputComponentMap = {
  string: StringFieldComponent,
  // @ts-expect-error - will be fixed with merge of progressive-profiling
  text: TextFieldComponent,
  // @ts-expect-error - will be fixed with merge of progressive-profiling
  number: NumberFieldComponent,
  // @ts-expect-error - will be fixed with merge of progressive-profiling
  boolean: BooleanFieldComponent,
  toggle: ToggleInput,
  // @ts-expect-error - will be fixed with merge of progressive-profiling
  email: EmailFieldComponent,
  // @ts-expect-error - will be fixed with merge of progressive-profiling
  phone: PhoneFieldComponent,
  // @ts-expect-error - will be fixed with merge of progressive-profiling
  date: DateFieldComponent,
  // @ts-expect-error - will be fixed with merge of progressive-profiling
  select: SelectFieldComponent,
  // @ts-expect-error - will be fixed with merge of progressive-profiling
  multiselect: MultiselectFieldComponent,
  // @ts-expect-error - will be fixed with merge of progressive-profiling
  password: PasswordFieldComponent,
  // @ts-expect-error - will be fixed with merge of progressive-profiling
  url: UrlFieldComponent,
  // @ts-expect-error - will be fixed with merge of progressive-profiling
  "image-url": ImageUrlFieldComponent,
} as const;
