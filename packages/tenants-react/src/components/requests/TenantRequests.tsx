import { TabGroup, Tab, TabPanel } from "@shared/ui";
import classNames from "classnames/bind";

import { usePluginContext } from "../../plugin";

import style from "./requests.module.scss";
import { TenantTab } from "../tab/TenantTab";

const cx = classNames.bind(style);

export const TenantRequests = () => {
  const { t } = usePluginContext();

  return (
    <div className={cx("tenantRequestsWrapper")}>
      <TabGroup>
        <Tab panel="onboarding">{t("PL_TB_TENANT_REQUESTS_ONBOARDING_TAB_LABEL")}</Tab>
        <Tab panel="creation">{t("PL_TB_TENANT_REQUESTS_CREATION_TAB_LABEL")}</Tab>

        {/* Tab Content */}
        <TabPanel name="onboarding">
          <TenantTab description={t("PL_TB_TENANT_REQUESTS_ONBOARDING_DESCRIPTION")}>
            <div></div>
          </TenantTab>
        </TabPanel>
        <TabPanel name="creation">
          <TenantTab description={t("PL_TB_TENANT_REQUESTS_CREATION_DESCRIPTION")}>
            <div></div>
          </TenantTab>
        </TabPanel>
      </TabGroup>
    </div>
  );
};
