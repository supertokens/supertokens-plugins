import { ToastContainer, ToastProvider } from "@shared/ui";
import classNames from "classnames/bind";

import { CreationRequests } from "../../components/requests/CreationRequests";
import { TenantTab } from "../../components/tab/TenantTab";
import { usePluginContext } from "../../plugin";

import style from "./styles.module.scss";

const cx = classNames.bind(style);

const TenantCreationRequestsWithoutToast = ({ section }: { section: any }) => {
  const { t } = usePluginContext();

  return (
    <div className={cx("tenantCreationRequestsManagement")}>
      <div className={cx("tenantCreationRequestsManagementHeader")}>
        <div>
          <h3>{section.label}</h3>
        </div>
      </div>
      <div>
        <TenantTab description={t("PL_TB_TENANT_REQUESTS_CREATION_DESCRIPTION")}>
          <CreationRequests />
        </TenantTab>
      </div>
    </div>
  );
};

export const TenantCreationRequests = (props) => {
  return (
    <ToastProvider>
      <TenantCreationRequestsWithoutToast {...props} />
      <ToastContainer />
    </ToastProvider>
  );
};
