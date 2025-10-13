import { NoAccess } from "../../components/no-access/NoAccess";
import { usePluginContext } from "../../plugin";

export const SignUpBlocked = () => {
  const { t } = usePluginContext();

  return (
    <NoAccess
      headerText={t("PL_TE_JOIN_TENANT_AWAITING_APPROVAL_HEADER")}
      descriptionComponent={
        <div>
          <b>{t("PL_TE_SIGN_UP_BLOCKED_MESSAGE_HIGHLIGHT")}</b> <b>{t("PL_TE_SIGN_UP_BLOCKED_MESSAGE_SUFFIX")}</b>
        </div>
      }
      useDangerAccent
    />
  );
};
