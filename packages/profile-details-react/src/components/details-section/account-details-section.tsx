import { usePrettyAction } from "@shared/ui";
import classNames from "classnames/bind";
import { useEffect, useState } from "react";
import { User } from "supertokens-web-js/types";

import { usePluginContext } from "../../plugin";
import { AccountDetails } from "../../types";

import style from "./details-section.module.css";

const cx = classNames.bind(style);

export const AccountDetailsSection = ({
  onFetch,
}: {
  onFetch: () => Promise<{ profile: Record<string, any>; user: User }>;
}) => {
  const { t } = usePluginContext();

  const [accountDetails, setAccountDetails] = useState<AccountDetails>({
    emails: [],
    phoneNumbers: [],
    connectedAccounts: [],
  });

  const loadDetails = usePrettyAction(
    async () => {
      const details = await onFetch();

      setAccountDetails({
        emails: details.user.emails,
        phoneNumbers: details.user.phoneNumbers,
        connectedAccounts: details.user.loginMethods
          .filter((method) => method.thirdParty)
          .map((method) => ({
            provider: method.thirdParty!.id,
            email: method.email!,
          })),
      });
    },
    [onFetch],
    { errorMessage: t("PL_CD_SECTION_ACCOUNT_ERROR_FETCHING_DETAILS") },
  );

  useEffect(() => {
    loadDetails();
  }, []);

  return (
    <div className={cx("supertokens-plugin-profile-details-section")}>
      <div className={cx("supertokens-plugin-profile-details-header")}>
        <h3>{t("PL_CD_SECTION_ACCOUNT_LABEL")}</h3>
        {t("PL_CD_SECTION_ACCOUNT_DESCRIPTION")}
      </div>

      <div>
        <section className={cx("supertokens-plugin-profile-details-group")}>
          <h3>{t("PL_CD_SECTION_ACCOUNT_EMAILS")}</h3>
          {accountDetails.emails.length === 0 && (
            <span className={cx("supertokens-plugin-profile-details-value")}>
              {t("PL_CD_SECTION_ACCOUNT_EMAIL_NO_EMAILS")}
            </span>
          )}
          {accountDetails.emails.map((email, index) => (
            <span key={email} className={cx("supertokens-plugin-profile-details-value")}>
              {email}
            </span>
          ))}
        </section>

        <section className={cx("supertokens-plugin-profile-details-group")}>
          <h3>{t("PL_CD_SECTION_ACCOUNT_PHONE_NUMBERS")}</h3>
          {accountDetails.phoneNumbers.length === 0 && (
            <span className={cx("supertokens-plugin-profile-details-value")}>
              {t("PL_CD_SECTION_ACCOUNT_PHONE_NUMBERS_NO_PHONE_NUMBERS")}
            </span>
          )}
          {accountDetails.phoneNumbers.map((phoneNumber, index) => (
            <span key={phoneNumber} className={cx("supertokens-plugin-profile-details-value")}>
              {phoneNumber}
            </span>
          ))}
        </section>
      </div>
    </div>
  );
};
