import { RowndSchema } from "./types";

export const PLUGIN_ID = "supertokens-plugin-rownd";

export const PLUGIN_SDK_VERSION = ["23.0.0", "23.0.1", ">=23.0.1"];
export const HANDLE_BASE_PATH = "/plugin/rownd";
export const PUBLIC_TENANT_ID = "public";

export const DEFAULT_ROWND_SCHEMA: RowndSchema = {
  zip_code: {
    display_name: "Zip code",
    type: "string",
    user_visible: true,
  },
  last_name: {
    display_name: "Last name",
    type: "string",
    user_visible: true,
  },
  nick_name: {
    display_name: "Nick name",
    type: "string",
    user_visible: true,
  },
  first_name: {
    display_name: "First name",
    type: "string",
    user_visible: true,
  },
};
