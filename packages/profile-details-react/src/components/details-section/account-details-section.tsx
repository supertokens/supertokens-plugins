import { usePrettyAction, Button } from "@shared/ui";
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
    timeJoined: 0,
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
        timeJoined: details.user.timeJoined,
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

      <section className={cx("supertokens-plugin-profile-details-group")}>
        <div className={cx("supertokens-plugin-profile-details-item")}>
          <span className={cx("supertokens-plugin-profile-details-label")}>{t("PL_CD_SECTION_ACCOUNT_EMAILS")}</span>
          <span className={cx("supertokens-plugin-profile-details-value")}>
            {accountDetails.emails.length === 0 && (
              <span className={cx("supertokens-plugin-profile-details-empty")}>
                {t("PL_CD_SECTION_ACCOUNT_EMAIL_NO_EMAILS")}
              </span>
            )}
            {accountDetails.emails.map((email, index) => (
              <>
                {email}
                {index < accountDetails.emails.length - 1 && <br />}
              </>
            ))}
          </span>
        </div>
        <div className={cx("supertokens-plugin-profile-details-item")}>
          <span className={cx("supertokens-plugin-profile-details-label")}>
            {t("PL_CD_SECTION_ACCOUNT_PHONE_NUMBERS")}
          </span>
          <span className={cx("supertokens-plugin-profile-details-value")}>
            {accountDetails.phoneNumbers.length === 0 && (
              <span className={cx("supertokens-plugin-profile-details-empty")}>
                {t("PL_CD_SECTION_ACCOUNT_PHONE_NUMBERS_NO_PHONE_NUMBERS")}
              </span>
            )}
            {accountDetails.phoneNumbers.map((phoneNumber, index) => (
              <>
                {phoneNumber}
                {index < accountDetails.phoneNumbers.length - 1 && <br />}
              </>
            ))}
          </span>
        </div>

        <div className={cx("supertokens-plugin-profile-details-item")}>
          <span className={cx("supertokens-plugin-profile-details-label")}>
            {t("PL_CD_SECTION_ACCOUNT_TIME_JOINED")}
          </span>
          <span className={cx("supertokens-plugin-profile-details-value")}>
            {!accountDetails.timeJoined && (
              <span className={cx("supertokens-plugin-profile-details-empty")}>
                {t("PL_CD_SECTION_ACCOUNT_TIME_JOINED_NO_TIME_JOINED")}
              </span>
            )}
            {Boolean(accountDetails.timeJoined) && new Date(accountDetails.timeJoined).toLocaleDateString()}
          </span>
        </div>
      </section>
    </div>
  );
};
