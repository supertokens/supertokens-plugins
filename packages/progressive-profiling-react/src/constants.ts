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

export const PLUGIN_ID = "supertokens-plugin-progressive-profiling";
export const PLUGIN_VERSION = "0.0.1";

export const API_PATH = `plugin/${PLUGIN_ID}`;

export const DEFAULT_FIELD_TYPE_COMPONENT_MAP: FormInputComponentMap = {
  string: StringFieldComponent,
  text: TextFieldComponent,
  number: NumberFieldComponent,
  boolean: BooleanFieldComponent,
  toggle: ToggleInput,
  email: EmailFieldComponent,
  phone: PhoneFieldComponent,
  date: DateFieldComponent,
  select: SelectFieldComponent,
  multiselect: MultiselectFieldComponent,
  password: PasswordFieldComponent,
  url: UrlFieldComponent,
  "image-url": ImageUrlFieldComponent,
} as const;

export const DEFAULT_REQUIRE_SETUP = true;
export const DEFAULT_SETUP_PAGE_PATH = "/user/setup";
export const DEFAULT_ON_SUCCESS = async () => {
  window.location.href = "/";
};
