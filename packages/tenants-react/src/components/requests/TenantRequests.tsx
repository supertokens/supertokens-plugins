import { TabGroup, Tab, TabPanel } from "@shared/ui";
import classNames from "classnames/bind";

import { usePluginContext } from "../../plugin";
import { TenantTab } from "../tab/TenantTab";

import { CreationRequests } from "./CreationRequests";
import { OnboardingRequests } from "./OnboardingRequests";
import style from "./requests.module.scss";

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
            <OnboardingRequests />
          </TenantTab>
        </TabPanel>
        <TabPanel name="creation">
          <TenantTab description={t("PL_TB_TENANT_REQUESTS_CREATION_DESCRIPTION")}>
            <CreationRequests />
          </TenantTab>
        </TabPanel>
      </TabGroup>
    </div>
  );
};
