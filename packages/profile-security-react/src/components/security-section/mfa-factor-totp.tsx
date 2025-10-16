import { Button, usePrettyAction, TextInput } from "@shared/ui";
import classNames from "classnames/bind";
import { useState, useEffect, useCallback } from "react";
import QRCode from "react-qr-code";
import {
  listDevices,
  createDevice,
  removeDevice,
  verifyDevice,
  verifyCode,
} from "supertokens-auth-react/recipe/totp/index.js";
import { User } from "supertokens-web-js/types";

import { usePluginContext } from "../../plugin";
import { ListCard, ListCardFooter, ListCardItem, ListCardItemActions } from "../list-card";

import style from "./security-section.module.css";

const cx = classNames.bind(style);

export const MfaFactorTotpList = ({ user, onSuccess }: { user: User; onSuccess: () => Promise<any> }) => {
  const [totpDevices, setTotpDevices] = useState<{ name: string; verified: boolean }[]>([]);
  const [newTotpDevice, setNewTotpDevice] = useState<{
    name: string;
    qrString: string;
  }>();
  const [totpVerificationCode, setTotpVerificationCode] = useState<string>("");
  const [renameName, setRenameName] = useState<string>("");
  const [addName, setAddName] = useState<string>("");
  const [activeTotpDevice, setActiveTotpDevice] = useState<{
    action: "add" | "rename";
    name: string;
    qrCodeString: string;
  }>();

  const { t, api } = usePluginContext();

  const loadTotps = usePrettyAction(async () => {
    const devices = await listDevices();
    if (devices.status !== "OK") {
      throw new Error(t("PL_SEC_MFA_TOTP_ERROR_LOADING_TOTP"));
    }

    setTotpDevices(
      devices.devices
        .map((device) => ({
          name: device.name,
          verified: device.verified,
        }))
        .filter((device) => device.verified),
    );
  }, []);

  const addTotp = usePrettyAction(
    async () => {
      const res = await createDevice({ deviceName: addName || undefined });
      if (res.status !== "OK") {
        throw new Error(t("PL_SEC_MFA_TOTP_ERROR_ADD_TOTP"));
      }

      setAddName("");
      setTotpVerificationCode("");

      loadTotps();

      setNewTotpDevice({ name: res.deviceName, qrString: res.qrCodeString });
    },
    [addName],
    { errorMessage: t("PL_SEC_MFA_TOTP_ERROR_ADD_TOTP") },
  );

  const verifyTotp = usePrettyAction(
    async () => {
      let res: { status: string };
      if (!newTotpDevice) {
        res = await verifyCode({ totp: totpVerificationCode });
      } else {
        res = await verifyDevice({ deviceName: addName || newTotpDevice.name, totp: totpVerificationCode });
      }

      if (res.status !== "OK") {
        throw new Error(t("PL_SEC_MFA_TOTP_ERROR_VERIFY_DEVICE"));
      }

      setNewTotpDevice(undefined);
      setTotpVerificationCode("");

      loadTotps();
    },
    [newTotpDevice, totpVerificationCode, addName],
    {
      onSuccess,
      successMessage: t("PL_SEC_MFA_TOTP_SETUP_SUCCESS_VERIFY_DEVICE"),
      errorMessage: t("PL_SEC_MFA_TOTP_ERROR_VERIFY_DEVICE"),
    },
  );

  const onAddNameChange = useCallback((value: string) => {
    setAddName(value);
  }, []);

  const removeTotp = usePrettyAction(
    async (deviceName: string) => {
      await removeDevice({ deviceName });

      if (activeTotpDevice?.name === deviceName) {
        setActiveTotpDevice(undefined);
      }

      loadTotps();
    },
    [activeTotpDevice],
    {
      successMessage: t("PL_SEC_MFA_TOTP_SUCCESS_REMOVE_TOTP"),
      errorMessage: t("PL_SEC_MFA_TOTP_ERROR_REMOVE_TOTP"),
    },
  );

  const renameTotp = usePrettyAction(async (name: string) => {
    setActiveTotpDevice({ action: "rename", name, qrCodeString: "" });
    setRenameName(name);
  }, []);

  const cancelRename = useCallback(() => {
    setRenameName("");
    setActiveTotpDevice(undefined);
  }, []);

  const updateTotpName = usePrettyAction(
    async () => {
      if (activeTotpDevice?.action !== "rename") {
        throw new Error(t("PL_SEC_MFA_TOTP_ERROR_NO_TOTP_CONFIGURABLE"));
      }

      const res = await api.updateMfaTotpName({
        name: activeTotpDevice.name,
        newName: renameName,
      });
      if (res.status !== "OK") {
        throw new Error(res.message);
      }

      setActiveTotpDevice(undefined);
      setRenameName("");
      loadTotps();
    },
    [activeTotpDevice, renameName],
    {
      successMessage: t("PL_SEC_MFA_TOTP_SUCCESS_UPDATE_NAME"),
      errorMessage: t("PL_SEC_MFA_TOTP_ERROR_UPDATE_NAME"),
    },
  );

  const isRenaming = (totpName: string) => activeTotpDevice?.action === "rename" && activeTotpDevice?.name === totpName;

  useEffect(() => {
    loadTotps();
  }, []);

  return (
    <div className={cx("supertokens-plugin-profile-security-second-factor-manage")}>
      <ListCard
        title={t("PL_SEC_MFA_TOTP_LIST_TITLE")}
        FooterComponent={
          <ListCardFooter>
            {!newTotpDevice && (
              <>
                <div className={cx("supertokens-plugin-profile-security-totp-name-label")}>
                  {t("PL_SEC_MFA_TOTP_SETUP_ADD_DEVICE_NAME_LABEL")}
                </div>

                <TextInput
                  className={cx("supertokens-plugin-profile-security-totp-name")}
                  placeholder={t("PL_SEC_MFA_TOTP_SETUP_ADD_DEVICE_NAME_PLACEHOLDER")}
                  id="name"
                  value={addName}
                  onChange={onAddNameChange}
                />

                <Button
                  className={cx("supertokens-plugin-profile-security-add-totp-button")}
                  onClick={addTotp}
                  disabled={Boolean(newTotpDevice)}
                  size="small"
                  variant="brand"
                  appearance="accent">
                  {t("PL_SEC_MFA_TOTP_SETUP_ADD_DEVICE_BUTTON")}
                </Button>
              </>
            )}

            {newTotpDevice && (
              <>
                <p className={cx("supertokens-plugin-profile-security-totp-verify-description")}>
                  {t("PL_SEC_MFA_TOTP_SETUP_VERIFY_DESCRIPTION")}
                </p>

                {newTotpDevice?.qrString && (
                  <div className={cx("supertokens-plugin-profile-security-totp-verify-qr")}>
                    <QRCode value={newTotpDevice.qrString} />
                  </div>
                )}

                <TextInput
                  className={cx("supertokens-plugin-profile-security-totp-verify-code")}
                  id="verify-code"
                  placeholder={t("PL_SEC_MFA_TOTP_SETUP_VERIFY_CODE_PLACEHOLDER")}
                  value={totpVerificationCode}
                  onChange={(value) => setTotpVerificationCode(value as string)}
                />

                <Button
                  onClick={verifyTotp}
                  disabled={!totpVerificationCode}
                  size="small"
                  variant="brand"
                  appearance="accent">
                  {t("PL_SEC_MFA_TOTP_SETUP_VERIFY_BUTTON")}
                </Button>
              </>
            )}
          </ListCardFooter>
        }>
        {totpDevices.map((totp) => (
          <ListCardItem
            key={totp.name}
            ActionsComponent={
              <ListCardItemActions>
                {isRenaming(totp.name) && (
                  <>
                    <Button onClick={cancelRename} size="small" variant="neutral" appearance="outlined">
                      {t("PL_SEC_MFA_TOTP_CANCEL_RENAME_BUTTON")}
                    </Button>

                    <Button onClick={updateTotpName} size="small" variant="brand" appearance="accent">
                      {t("PL_SEC_MFA_TOTP_RENAME_BUTTON")}
                    </Button>
                  </>
                )}

                {!isRenaming(totp.name) && (
                  <>
                    <Button
                      appearance="plain"
                      size="small"
                      variant="brand"
                      className={cx("plugin-profile-security-manage-item-remove")}
                      onClick={() => renameTotp(totp.name)}
                      disabled={Boolean(activeTotpDevice)}>
                      {t("PL_SEC_MFA_TOTP_RENAME_BUTTON")}
                    </Button>

                    <Button
                      appearance="plain"
                      size="small"
                      variant="danger"
                      className={cx("plugin-profile-security-manage-item-remove")}
                      onClick={() => removeTotp(totp.name)}
                      disabled={totpDevices.length <= 1 || Boolean(activeTotpDevice)}>
                      {t("PL_SEC_MFA_TOTP_REMOVE_BUTTON")}
                    </Button>
                  </>
                )}
              </ListCardItemActions>
            }>
            {!isRenaming(totp.name) && <span>{totp.name}</span>}

            {isRenaming(totp.name) && (
              <>
                <div className={cx("supertokens-plugin-profile-security-totp-name-label")}>
                  {t("PL_SEC_MFA_TOTP_RENAME_DEVICE_NAME_LABEL")}
                </div>

                <TextInput
                  className={cx("supertokens-plugin-profile-security-totp-name")}
                  placeholder={t("PL_SEC_MFA_TOTP_RENAME_DEVICE_NAME_PLACEHOLDER")}
                  required
                  id="name"
                  value={renameName}
                  onChange={(value) => setRenameName(value as string)}
                />
              </>
            )}
          </ListCardItem>
        ))}
      </ListCard>
    </div>
  );
};

export default { Config: MfaFactorTotpList, Setup: MfaFactorTotpList };
