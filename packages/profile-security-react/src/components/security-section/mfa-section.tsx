import { Button, Tag, ToggleInput, usePrettyAction, useToast } from "@shared/ui";
import classNames from "classnames/bind";
import { useCallback, useEffect, useState } from "react";
import {
  getSecondaryFactors,
  resyncSessionAndFetchMFAInfo,
  MultiFactorAuthClaim,
} from "supertokens-auth-react/recipe/multifactorauth/index.js";
import Session from "supertokens-auth-react/recipe/session/index.js";
import { User } from "supertokens-web-js/types";

import { usePluginContext } from "../../plugin";
import { TranslationKeys } from "../../types";

import MfaFactorEmailOtp from "./mfa-factor-email-otp";
import MfaFactorPhoneOtp from "./mfa-factor-phone-otp";
import MfaFactorTotp from "./mfa-factor-totp";
import style from "./security-section.module.css";

const cx = classNames.bind(style);

const manageFactorComponents = {
  "otp-email": MfaFactorEmailOtp,
  "otp-phone": MfaFactorPhoneOtp,
  totp: MfaFactorTotp,
};

export const MfaSection = ({
  user,
  isLoading,
  setIsLoading,
  onSuccess,
}: {
  user: User;
  isLoading: boolean;
  setIsLoading: (isLoading: boolean) => void;
  onSuccess: () => Promise<any>;
}) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [factorBeingSetup, setFactorBeingSetup] = useState<keyof typeof manageFactorComponents>();

  const [secondaryFactors, setSecondaryFactors] = useState<
    {
      id: string;
      name: string;
      description: string;
      setup: boolean;
      required: boolean;
    }[]
  >([]);

  const { api, t } = usePluginContext();
  const { addToast } = useToast();

  const loadMfaInfo = usePrettyAction(
    async () => {
      const mfaInfo = await resyncSessionAndFetchMFAInfo();
      if (mfaInfo.status !== "OK") {
        throw new Error(t("PL_SEC_MFA_ERROR_LOADING_MFA_INFO"));
      }

      const res = await api.getMfaInfo();
      if (res.status !== "OK") {
        throw new Error(res.message);
      }

      const mfaClaimValue = await Session.getClaimValue({
        claim: MultiFactorAuthClaim,
      });

      const secondaryFactors = getSecondaryFactors({})
        .filter(
          (factor) =>
            mfaInfo.factors.alreadySetup.includes(factor.id) || mfaInfo.factors.allowedToSetup.includes(factor.id),
        )
        .map((factor) => ({
          id: factor.id,
          name: factor.name,
          description: factor.description,
          // make sure that the factor is already setup and the claim is set so we don't trigger a redirect to the factor login screen
          setup: mfaInfo.factors.alreadySetup.includes(factor.id) && Boolean(mfaClaimValue?.c[factor.id]),
          required: res.requiredSecondaryFactors.includes(factor.id),
        }));
      setSecondaryFactors(secondaryFactors);

      return {
        requiredSecondaryFactors: res.requiredSecondaryFactors,
        ...mfaInfo,
      };
    },
    [],
    {
      setLoading: setIsLoading,
    },
  );

  const toggleSecondaryFactor = usePrettyAction(
    async (factorId: string) => {
      const required = secondaryFactors.find((f) => f.id === factorId)?.required;
      const payload = required ? undefined : factorId;
      const res = await api.setRequiredSecondaryFactor(payload);

      if (res.status !== "OK") {
        throw new Error(res.message);
      }
    },
    [secondaryFactors, addToast],
    {
      errorMessage: t("PL_SEC_MFA_ERROR_TOGGLE_SECONDARY_FACTOR"),
      successMessage: t("PL_SEC_MFA_SUCCESS_TOGGLE_SECONDARY_FACTOR"),
      setLoading: setIsLoading,
      onSuccess: () => loadMfaInfo(),
    },
  );

  const _onSuccess = useCallback(async () => {
    setFactorBeingSetup(undefined);

    await onSuccess();
    await loadMfaInfo();
  }, [loadMfaInfo, onSuccess]);

  const getManageFactorComponent = useCallback(
    (factor: (typeof secondaryFactors)[number]) => {
      const FactorManageComponent = manageFactorComponents[factor.id as keyof typeof manageFactorComponents] ?? null;
      if (!FactorManageComponent) {
        return null;
      }

      let type: "config" | "setup";
      if (factorBeingSetup === factor.id) {
        type = "setup";
      } else if (!factorBeingSetup && factor.required && factor.setup) {
        type = "config";
      } else {
        return null;
      }

      return type === "config" ? (
        <FactorManageComponent.Config user={user!} onSuccess={_onSuccess} />
      ) : (
        <FactorManageComponent.Setup user={user!} onSuccess={_onSuccess} />
      );
    },
    [user, _onSuccess, factorBeingSetup],
  );

  useEffect(() => {
    if (isLoaded) {
      return;
    }
    loadMfaInfo();
    setIsLoaded(true);
  }, [isLoaded, loadMfaInfo]);

  if (!isLoaded) {
    return null;
  }

  return (
    <div className={cx("supertokens-plugin-profile-security-second-factor")}>
      {secondaryFactors.map((factor) => (
        <div key={factor.id} className={cx("supertokens-plugin-profile-security-second-factor-method")}>
          <div className={cx("supertokens-plugin-profile-security-second-factor-method-header")}>
            <div className={cx("supertokens-plugin-profile-security-second-factor-method-header-content")}>
              <span className={cx("supertokens-plugin-profile-security-second-factor-method-label")}>
                {t(factor.name as TranslationKeys)}
              </span>

              <span className={cx("supertokens-plugin-profile-security-second-factor-method-description")}>
                {t(factor.description as TranslationKeys)}
              </span>
            </div>

            <div className={cx("supertokens-plugin-profile-security-second-factor-method-header-actions")}>
              {factor.setup && (
                <ToggleInput
                  className={cx("supertokens-plugin-profile-security-method-action")}
                  value={factor.required}
                  id={`required-${factor.id}`}
                  label=""
                  placeholder=""
                  size="small"
                  onChange={() => toggleSecondaryFactor(factor.id)}
                />
              )}

              {!factor.setup && factorBeingSetup !== factor.id && (
                <Button
                  appearance="filled"
                  variant="brand"
                  size="small"
                  onClick={() => setFactorBeingSetup(factor.id as keyof typeof manageFactorComponents)}
                  className={cx("supertokens-plugin-profile-security-method-action")}>
                  {t("PL_SEC_MFA_SETUP_BUTTON")}
                </Button>
              )}

              {!factor.setup && factorBeingSetup === factor.id && (
                <Button
                  appearance="plain"
                  size="small"
                  onClick={() => setFactorBeingSetup(undefined)}
                  className={cx("supertokens-plugin-profile-security-method-action")}>
                  {t("PL_SEC_MFA_SETUP_CANCEL_BUTTON")}
                </Button>
              )}
            </div>
          </div>

          {getManageFactorComponent(factor)}
        </div>
      ))}
    </div>
  );
};
