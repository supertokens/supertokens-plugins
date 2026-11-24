import {
  PASSWORDLESS_BYPASS_DEVICE_CONFIRMATION_PARAM,
  PUBLIC_TENANT_ID,
} from "./constants";

const aliases: Record<string, [string, Record<string, string>?]> = {
  appVariantId: ["v"],
  displayContext: ["d", { mobile_app: "m", customer_web_view: "w" }],
  clientDomain: ["c"],
  redirectToPath: ["r"],
  oauthLoginChallenge: ["o"],
  passwordlessFlowType: [
    "f",
    {
      USER_INPUT_CODE: "c",
      MAGIC_LINK: "l",
      USER_INPUT_CODE_AND_MAGIC_LINK: "cl",
    },
  ],
  rowndAuthIntent: ["i", { sign_in: "i", sign_up: "u" }],
  rowndReauthenticate: ["ra", { true: "1" }],
  [PASSWORDLESS_BYPASS_DEVICE_CONFIRMATION_PARAM]: ["bd", { true: "1" }],
};

export function compactMagicLinkParams(params: URLSearchParams) {
  params.delete("appKey");
  params.delete("apiDomain");
  params.delete("apiBasePath");
  if (params.get("tenantId") === PUBLIC_TENANT_ID) {
    params.delete("tenantId");
  }

  for (const [name, [alias, values]] of Object.entries(aliases)) {
    const value = params.get(name);
    if (value === null) continue;
    params.delete(name);
    if (!values) {
      params.set(alias, value);
    } else if (Object.prototype.hasOwnProperty.call(values, value)) {
      params.set(alias, values[value]!);
    } else {
      params.delete(alias);
    }
  }
}
