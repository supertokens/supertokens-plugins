export const PLUGIN_ID = "supertokens-plugin-tenant-discovery";
export const PLUGIN_VERSION = "0.0.1";

export const PLUGIN_SDK_VERSION = ["23.0.0", "23.0.1", ">=23.0.1"];

export const HANDLE_BASE_PATH = `/plugin/${PLUGIN_ID}`;

export const PLUGIN_ERROR_NAME = `${PLUGIN_ID}-error`;

// This is a list of popular email domains that we do not allow
// to be used in email domain to tenant ID map.
//
// This list contains the top 20 most used email domains
// from this list:
// https://email-verify.my-addr.com/list-of-most-popular-email-domains.php
export const POPULAR_EMAIL_DOMAINS = [
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "aol.com",
  "hotmail.co.uk",
  "hotmail.fr",
  "msn.com",
  "yahoo.fr",
  "wanadoo.fr",
  "orange.fr",
  "comcast.net",
  "yahoo.co.uk",
  "yahoo.com.br",
  "yahoo.co.in",
  "live.com",
  "rediffmail.com",
  "free.fr",
  "gmx.de",
  "web.de",
  "yandex.ru",
];
