export type RowndSchemaField = {
  display_name: string;
  type: string;
  data_category: string;
  owned_by: string;
  required: boolean;
  unique: boolean;
  user_visible: boolean;
};

export type RowndSchema = Record<string, RowndSchemaField>;

export const DEFAULT_ROWND_SCHEMA: RowndSchema = {
  email: {
    display_name: "Email",
    type: "string",
    data_category: "pii_basic",
    owned_by: "user",
    required: false,
    unique: false,
    user_visible: true,
  },
  zip_code: {
    display_name: "Zip code",
    type: "string",
    data_category: "pii_basic",
    owned_by: "user",
    required: false,
    unique: false,
    user_visible: true,
  },
  google_id: {
    display_name: "Google ID",
    type: "string",
    data_category: "custom",
    owned_by: "app",
    required: false,
    unique: false,
    user_visible: false,
  },
  last_name: {
    display_name: "Last name",
    type: "string",
    data_category: "pii_basic",
    owned_by: "user",
    required: false,
    unique: false,
    user_visible: true,
  },
  nick_name: {
    display_name: "Nick name",
    type: "string",
    data_category: "pii_basic",
    owned_by: "user",
    required: false,
    unique: false,
    user_visible: true,
  },
  first_name: {
    display_name: "First name",
    type: "string",
    data_category: "pii_basic",
    owned_by: "user",
    required: false,
    unique: false,
    user_visible: true,
  },
  phone_number: {
    display_name: "Phone number",
    type: "string",
    data_category: "pii_basic",
    owned_by: "user",
    required: false,
    unique: false,
    user_visible: true,
  },
};
