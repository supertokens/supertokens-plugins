export type RowndSchemaField = {
  display_name: string;
  type: string;
  data_category: string;
  owned_by: string;
  required: boolean;
  unique: boolean;
  user_visible: boolean;
  read_only?: boolean;
  show_empty?: boolean;
  revoke_after?: string;
  required_retention?: string;
  collection_justification?: string;
  opt_out_warning?: string;
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
    revoke_after: "",
    required_retention: "",
    collection_justification: "",
    opt_out_warning: "",
  },
  zip_code: {
    display_name: "Zip code",
    type: "string",
    data_category: "pii_basic",
    owned_by: "user",
    required: false,
    unique: false,
    user_visible: true,
    revoke_after: "",
    required_retention: "",
    collection_justification: "",
    opt_out_warning: "",
  },
  google_id: {
    display_name: "Google ID",
    type: "string",
    data_category: "custom",
    owned_by: "app",
    required: false,
    unique: false,
    user_visible: false,
    read_only: true,
    revoke_after: "",
    required_retention: "",
    collection_justification: "",
    opt_out_warning: "",
  },
  last_name: {
    display_name: "Last name",
    type: "string",
    data_category: "pii_basic",
    owned_by: "user",
    required: false,
    unique: false,
    user_visible: true,
    revoke_after: "",
    required_retention: "",
    collection_justification: "",
    opt_out_warning: "",
  },
  nick_name: {
    display_name: "Nick name",
    type: "string",
    data_category: "pii_basic",
    owned_by: "user",
    required: false,
    unique: false,
    user_visible: true,
    revoke_after: "",
    required_retention: "",
    collection_justification: "",
    opt_out_warning: "",
  },
  first_name: {
    display_name: "First name",
    type: "string",
    data_category: "pii_basic",
    owned_by: "user",
    required: false,
    unique: false,
    user_visible: true,
    revoke_after: "",
    required_retention: "",
    collection_justification: "",
    opt_out_warning: "",
  },
  phone_number: {
    display_name: "Phone number",
    type: "string",
    data_category: "pii_basic",
    owned_by: "user",
    required: false,
    unique: false,
    user_visible: true,
    revoke_after: "",
    required_retention: "",
    collection_justification: "",
    opt_out_warning: "",
  },
};
