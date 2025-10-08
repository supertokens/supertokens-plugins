import { Button, Tag, usePrettyAction, TextInput } from "@shared/ui";
import classNames from "classnames/bind";
import { useState, useEffect, useMemo } from "react";
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

import style from "./security-section.module.css";

const cx = classNames.bind(style);

export const MfaFactorTotpConfig = ({ user, onSuccess }: { user: User; onSuccess: () => Promise<any> }) => {
  const [totpDevices, setTotpDevices] = useState<{ name: string; verified: boolean }[]>([]);
  const [activeTotp, setActiveTotp] = useState<{
    action: "add" | "rename";
    name: string;
    qrCodeString: string;
  }>();
  const [verifyCode, setVerifyCode] = useState<string>("");
  const [name, setName] = useState<string>("");

  const { t, api } = usePluginContext();

  const loadTotps = usePrettyAction(async () => {
    const devices = await listDevices();
    if (devices.status !== "OK") {
      throw new Error(t("PL_SEC_MFA_TOTP_ERROR_LOADING_TOTP"));
    }

    setTotpDevices(
      devices.devices.map((device) => ({
        name: device.name,
        verified: device.verified,
      })),
    );
  }, []);

  const removeTotp = usePrettyAction(
    async (deviceName: string) => {
      await removeDevice({ deviceName });

      if (activeTotp?.name === deviceName) {
        setActiveTotp(undefined);
      }

      loadTotps();
    },
    [activeTotp],
    {
      successMessage: t("PL_SEC_MFA_TOTP_SUCCESS_REMOVE_TOTP"),
      errorMessage: t("PL_SEC_MFA_TOTP_ERROR_REMOVE_TOTP"),
    },
  );

  const addTotp = usePrettyAction(
    async () => {
      const res = await createDevice({ deviceName: name || undefined });
      if (res.status !== "OK") {
        throw new Error(t("PL_SEC_MFA_TOTP_ERROR_ADD_TOTP"));
      }
      setName("");
      setVerifyCode("");

      loadTotps();

      setActiveTotp({
        action: "add",
        name: res.deviceName,
        qrCodeString: res.qrCodeString,
      });
    },
    [name],
    {
      successMessage: t("PL_SEC_MFA_TOTP_SUCCESS_ADD_TOTP"),
      errorMessage: t("PL_SEC_MFA_TOTP_ERROR_ADD_TOTP"),
    },
  );

  const verifyTotp = usePrettyAction(
    async () => {
      if (!activeTotp) {
        throw new Error(t("PL_SEC_MFA_TOTP_ERROR_NO_TOTP_CONFIGURABLE"));
      }
      if (activeTotp.action !== "add") {
        throw new Error(t("PL_SEC_MFA_TOTP_ERROR_NO_TOTP_CONFIGURABLE"));
      }

      if (!verifyCode) {
        throw new Error(t("PL_SEC_MFA_TOTP_ERROR_NO_CODE"));
      }

      const res = await verifyDevice({
        deviceName: name || activeTotp.name,
        totp: verifyCode,
      });
      if (res.status !== "OK") {
        throw new Error(t("PL_SEC_MFA_TOTP_ERROR_VERIFY_DEVICE"));
      }

      setActiveTotp(undefined);
      setVerifyCode("");

      loadTotps();
    },
    [activeTotp, verifyCode, name],
    {
      successMessage: t("PL_SEC_MFA_TOTP_SUCCESS_VERIFY_DEVICE"),
      errorMessage: t("PL_SEC_MFA_TOTP_ERROR_VERIFY_DEVICE"),
    },
  );

  const renameTotp = usePrettyAction(async (name: string) => {
    setActiveTotp({ action: "rename", name, qrCodeString: "" });
  }, []);

  const updateTotpName = usePrettyAction(
    async () => {
      if (activeTotp?.action !== "rename") {
        throw new Error(t("PL_SEC_MFA_TOTP_ERROR_NO_TOTP_CONFIGURABLE"));
      }

      const res = await api.updateMfaTotpName({
        name: activeTotp.name,
        newName: name,
      });
      if (res.status !== "OK") {
        throw new Error(res.message);
      }

      setActiveTotp(undefined);
      setName("");
      loadTotps();
    },
    [activeTotp, name],
    {
      successMessage: t("PL_SEC_MFA_TOTP_SUCCESS_UPDATE_NAME"),
      errorMessage: t("PL_SEC_MFA_TOTP_ERROR_UPDATE_NAME"),
    },
  );

  useEffect(() => {
    loadTotps();
  }, []);

  const isAdding = !activeTotp || activeTotp.action === "add";
  const isRenaming = Boolean(activeTotp) && activeTotp?.action === "rename";

  return (
    <div className={cx(".plugin-profile-security-manage")}>
      {totpDevices.map((totp) => (
        <div key={totp.name} className={cx("plugin-profile-security-manage-item")}>
          <span>{totp.name}</span>
          {totp.verified ? (
            <Tag variant="success" size="small">
              {t("PL_SEC_MFA_TOTP_VERIFIED")}
            </Tag>
          ) : (
            <Tag variant="danger" size="small">
              {t("PL_SEC_MFA_TOTP_UNVERIFIED")}
            </Tag>
          )}

          <div className={cx("plugin-profile-security-manage-item-actions")}>
            <Button
              appearance="plain"
              size="small"
              className={cx("plugin-profile-security-manage-item-remove")}
              onClick={() => renameTotp(totp.name)}
              disabled={Boolean(activeTotp)}>
              {t("PL_SEC_MFA_TOTP_RENAME_BUTTON")}
            </Button>

            <Button
              appearance="plain"
              size="small"
              className={cx("plugin-profile-security-manage-item-remove")}
              onClick={() => removeTotp(totp.name)}
              disabled={totpDevices.length <= 1 || Boolean(activeTotp)}>
              {t("PL_SEC_MFA_TOTP_REMOVE_BUTTON")}
            </Button>
          </div>
        </div>
      ))}

      {isRenaming && (
        <div className={cx("plugin-profile-security-manage-container")}>
          <h4>{t("PL_SEC_MFA_TOTP_RENAME_DEVICE")}</h4>

          <p className={cx("plugin-profile-security-item-description")}>
            {t("PL_SEC_MFA_TOTP_RENAME_DEVICE_DESCRIPTION")}
          </p>
          <br />
          <TextInput
            label={t("PL_SEC_MFA_TOTP_RENAME_DEVICE_NAME_LABEL")}
            placeholder={t("PL_SEC_MFA_TOTP_RENAME_DEVICE_NAME_PLACEHOLDER")}
            required
            id="name"
            value={name}
            onChange={(value) => setName(value as string)}
          />
          <br />
          <Button onClick={updateTotpName} size="small" variant="brand" appearance="accent">
            {t("PL_SEC_MFA_TOTP_RENAME_BUTTON")}
          </Button>
        </div>
      )}

      {isAdding && (
        <div className={cx("plugin-profile-security-manage-container")}>
          <h4>{t("PL_SEC_MFA_TOTP_ADD_DEVICE")}</h4>

          {!activeTotp && (
            <>
              <p className={cx("plugin-profile-security-item-description")}>
                {t("PL_SEC_MFA_TOTP_ADD_DEVICE_DESCRIPTION")}
              </p>
              <br />
              <div className={cx("plugin-profile-security-second-factor-manage-totp-add")}>
                <TextInput
                  label={t("PL_SEC_MFA_TOTP_ADD_DEVICE_NAME_LABEL")}
                  placeholder={t("PL_SEC_MFA_TOTP_ADD_DEVICE_NAME_PLACEHOLDER")}
                  id="name"
                  value={name}
                  onChange={(value) => setName(value as string)}
                />
                <br />
                <Button
                  onClick={addTotp}
                  disabled={Boolean(activeTotp)}
                  size="small"
                  variant="brand"
                  appearance="accent">
                  {t("PL_SEC_MFA_TOTP_ADD_BUTTON")}
                </Button>
              </div>
            </>
          )}

          {activeTotp && (
            <>
              <p className={cx("plugin-profile-security-second-factor-manage-totp-add-description")}>
                {t("PL_SEC_MFA_TOTP_VERIFY_DESCRIPTION")}
              </p>

              <br />

              <div className={cx("plugin-profile-security-second-factor-manage-totp-verify-qr")}>
                <QRCode value={activeTotp.qrCodeString} />
              </div>

              <br />

              <div className={cx("plugin-profile-security-second-factor-manage-totp-verify-code")}>
                <TextInput
                  label={t("PL_SEC_MFA_TOTP_VERIFY_CODE_LABEL")}
                  id="verify-code"
                  placeholder={t("PL_SEC_MFA_TOTP_VERIFY_CODE_PLACEHOLDER")}
                  value={verifyCode}
                  onChange={(value) => setVerifyCode(value as string)}
                />
                <br />
                <Button onClick={verifyTotp} disabled={!verifyCode} size="small" variant="brand" appearance="accent">
                  {t("PL_SEC_MFA_TOTP_VERIFY_BUTTON")}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export const MfaFactorTotpSetup = ({ user, onSuccess }: { user: User; onSuccess: () => Promise<any> }) => {
  const [totpDevices, setTotpDevices] = useState<{ name: string; verified: boolean }[]>();
  const [totpDevice, setTotpDevice] = useState<{
    name: string;
    qrString: string;
  }>();
  const [totp, setTotp] = useState<string>("");
  const [name, setName] = useState<string>("");

  const { t } = usePluginContext();

  const loadTotps = usePrettyAction(async () => {
    const devices = await listDevices();
    if (devices.status !== "OK") {
      throw new Error(t("PL_SEC_MFA_TOTP_ERROR_LOADING_TOTP"));
    }

    setTotpDevices(
      devices.devices.map((device) => ({
        name: device.name,
        verified: device.verified,
      })),
    );
  }, []);

  const hasTotpSetup = useMemo(() => {
    if (!totpDevices) {
      return true;
    }
    return totpDevices.filter((device) => device.verified).length > 0;
  }, [totpDevices]);

  const addTotp = usePrettyAction(
    async () => {
      const res = await createDevice({ deviceName: name || undefined });
      if (res.status !== "OK") {
        throw new Error(t("PL_SEC_MFA_TOTP_ERROR_ADD_TOTP"));
      }
      setName("");
      setTotp("");

      loadTotps();

      setTotpDevice({ name: res.deviceName, qrString: res.qrCodeString });
    },
    [name],
    { errorMessage: t("PL_SEC_MFA_TOTP_ERROR_ADD_TOTP") },
  );

  const verifyTotp = usePrettyAction(
    async () => {
      let res: { status: string };
      if (!totpDevice) {
        res = await verifyCode({ totp });
      } else {
        res = await verifyDevice({ deviceName: name || totpDevice.name, totp });
      }

      if (res.status !== "OK") {
        throw new Error(t("PL_SEC_MFA_TOTP_ERROR_VERIFY_DEVICE"));
      }

      setTotpDevice(undefined);
      setTotp("");

      loadTotps();
    },
    [totpDevice, totp, name],
    {
      onSuccess,
      successMessage: t("PL_SEC_MFA_TOTP_SETUP_SUCCESS_VERIFY_DEVICE"),
      errorMessage: t("PL_SEC_MFA_TOTP_ERROR_VERIFY_DEVICE"),
    },
  );

  useEffect(() => {
    loadTotps();
  }, []);

  return (
    <div className={cx("plugin-profile-security-manage-container")}>
      {hasTotpSetup ? (
        <>
          <h4>{t("PL_SEC_MFA_TOTP_SETUP_CONFIRM_DEVICE")}</h4>

          <br />
          <div className={cx("plugin-profile-security-second-factor-manage-totp-verify-code")}>
            <TextInput
              label={t("PL_SEC_MFA_TOTP_SETUP_VERIFY_CODE_LABEL")}
              id="verify-code"
              placeholder={t("PL_SEC_MFA_TOTP_SETUP_VERIFY_CODE_PLACEHOLDER")}
              value={totp}
              onChange={(value) => setTotp(value as string)}
            />
            <br />
            <Button onClick={verifyTotp} disabled={!totp} size="small" variant="brand" appearance="accent">
              {t("PL_SEC_MFA_TOTP_SETUP_VERIFY_BUTTON")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <h4>{t("PL_SEC_MFA_TOTP_SETUP_ADD_DEVICE")}</h4>

          {!totpDevice && (
            <>
              <p className={cx("plugin-profile-security-item-description")}>
                {t("PL_SEC_MFA_TOTP_SETUP_ADD_DEVICE_DESCRIPTION")}
              </p>
              <br />
              <div className={cx("plugin-profile-security-second-factor-manage-totp-add")}>
                <TextInput
                  label={t("PL_SEC_MFA_TOTP_SETUP_ADD_DEVICE_NAME_LABEL")}
                  placeholder={t("PL_SEC_MFA_TOTP_SETUP_ADD_DEVICE_NAME_PLACEHOLDER")}
                  id="name"
                  value={name}
                  onChange={(value) => setName(value as string)}
                />
                <br />
                <Button
                  onClick={addTotp}
                  disabled={Boolean(totpDevice)}
                  size="small"
                  variant="brand"
                  appearance="accent">
                  {t("PL_SEC_MFA_TOTP_SETUP_ADD_DEVICE_BUTTON")}
                </Button>
              </div>
            </>
          )}

          {totpDevice && (
            <>
              <p className={cx("plugin-profile-security-second-factor-manage-totp-add-description")}>
                {t("PL_SEC_MFA_TOTP_SETUP_VERIFY_DESCRIPTION")}
              </p>

              {totpDevice?.qrString && (
                <>
                  <br />
                  <div className={cx("plugin-profile-security-second-factor-manage-totp-verify-qr")}>
                    <QRCode value={totpDevice.qrString} />
                  </div>
                </>
              )}

              <br />
              <div className={cx("plugin-profile-security-second-factor-manage-totp-verify-code")}>
                <TextInput
                  label={t("PL_SEC_MFA_TOTP_SETUP_VERIFY_CODE_LABEL")}
                  id="verify-code"
                  placeholder={t("PL_SEC_MFA_TOTP_SETUP_VERIFY_CODE_PLACEHOLDER")}
                  value={totp}
                  onChange={(value) => setTotp(value as string)}
                />
                <br />
                <Button onClick={verifyTotp} disabled={!totp} size="small" variant="brand" appearance="accent">
                  {t("PL_SEC_MFA_TOTP_SETUP_VERIFY_BUTTON")}
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
};

export default { Config: MfaFactorTotpConfig, Setup: MfaFactorTotpSetup };
