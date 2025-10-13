import express from "express";
import crypto from "node:crypto";
import { describe, it, expect, afterEach, beforeEach } from "vitest";

import SuperTokens, { getUser } from "supertokens-node/lib/build/index";
import Session from "supertokens-node/lib/build/recipe/session/index";
import EmailPassword, { verifyCredentials } from "supertokens-node/lib/build/recipe/emailpassword/index";
import ThirdParty from "supertokens-node/lib/build/recipe/thirdparty/index";
import MultiFactorAuth from "supertokens-node/lib/build/recipe/multifactorauth/index";
import Passwordless from "supertokens-node/lib/build/recipe/passwordless/index";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import TOTP, { createDevice, listDevices } from "supertokens-node/lib/build/recipe/totp/index";

import { middleware, errorHandler } from "supertokens-node/framework/express";
import { verifySession } from "supertokens-node/lib/build/recipe/session/framework/express";

import { ProcessState } from "supertokens-node/lib/build/processState";
import SuperTokensRaw from "supertokens-node/lib/build/supertokens";
import SessionRaw from "supertokens-node/lib/build/recipe/session/recipe";
import UserRolesRaw from "supertokens-node/lib/build/recipe/userroles/recipe";
import EmailPasswordRaw from "supertokens-node/lib/build/recipe/emailpassword/recipe";
import ThirdPartyRaw from "supertokens-node/lib/build/recipe/thirdparty/recipe";
import AccountLinkingRaw from "supertokens-node/lib/build/recipe/accountlinking/recipe";
import MultitenancyRaw from "supertokens-node/lib/build/recipe/multitenancy/recipe";
import UserMetadataRaw from "supertokens-node/lib/build/recipe/usermetadata/recipe";
import MultiFactorAuthRaw from "supertokens-node/lib/build/recipe/multifactorauth/recipe";
import PasswordlessRaw from "supertokens-node/lib/build/recipe/passwordless/recipe";
import TOTPRaw from "supertokens-node/lib/build/recipe/totp/recipe";

import { init } from "./plugin";
import { Implementation } from "./implementation";
import { HANDLE_BASE_PATH } from "./constants";
import { SuperTokensPluginProfileSecurityConfig } from "./types";

const testPORT = parseInt(process.env.PORT || "3000");
const getTestEmail = () => `user+${Math.random() * 1000000}@test.com`;
const testPW = "test";

describe("profile-security-nodejs", () => {
  describe("API Endpoints", () => {
    afterEach(() => {
      resetST();
      Implementation.reset();
    });

    beforeEach(() => {
      resetST();
      Implementation.reset();
    });

    it("should get config successfully", async () => {
      const { session } = await setup();

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/config`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
      });

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result).toHaveProperty("status", "OK");
      expect(result).toHaveProperty("config");
      expect(result.config).toHaveProperty("enableSettingPassword");
      expect(result.config).toHaveProperty("enableThirdPartyLinkning");
      expect(result.config).toHaveProperty("enableMfaConfiguration");
    });

    it("should fail to get config without authentication", async () => {
      await setup();

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/config`, {
        method: "GET",
      });

      const result = await response.json();

      expect(response.status).toBe(401);
      expect(result).toHaveProperty("message", "unauthorised");
    });

    it("should get user successfully", async () => {
      const { user, session } = await setup();

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/user`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
      });

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result).toHaveProperty("status", "OK");
      expect(result).toHaveProperty("user");
      expect(result.user).toHaveProperty("id", user.id);
    });

    it("should fail to get user without authentication", async () => {
      await setup();

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/user`, {
        method: "GET",
      });

      const result = await response.json();

      expect(response.status).toBe(401);
      expect(result).toHaveProperty("message", "unauthorised");
    });

    it("should set password successfully for user without existing password", async () => {
      await setup({
        recipeList: [
          Session.init({}),
          EmailPassword.init({}),
          AccountLinking.init({
            shouldDoAutomaticAccountLinking: async () => {
              return {
                shouldAutomaticallyLink: true,
                shouldRequireVerification: false,
              };
            },
          }),
          ThirdParty.init({
            signInAndUpFeature: {
              providers: [
                {
                  config: {
                    thirdPartyId: "google",
                    clients: [
                      {
                        clientId: "test",
                        clientSecret: "test",
                      },
                    ],
                  },
                },
              ],
            },
          }),
        ],
      });

      const testEmail = getTestEmail();

      const thirdPartyUser = await ThirdParty.manuallyCreateOrUpdateUser(
        "public",
        "google",
        "test-user-id",
        testEmail,
        false,
      );

      if (thirdPartyUser.status !== "OK") {
        throw new Error("Failed to create third party user");
      }

      const thirdPartySession = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(thirdPartyUser.user.id),
      );

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/password/set`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${thirdPartySession.getAccessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: testEmail,
          newPassword: "newPassword123",
        }),
      });

      const result = await response.json();

      expect(result).toHaveProperty("status", "OK");

      const verifyCredentialsResponse = await verifyCredentials("public", testEmail, "newPassword123");
      expect(verifyCredentialsResponse.status).toBe("OK");
    });

    it("should fail to set password for user with existing password", async () => {
      const { user, session } = await setup();
      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/password/set`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: user.emails[0],
          newPassword: "newPassword123",
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result).toHaveProperty("status", "ERROR");
      expect(result.message).toContain("already has a password set");
    });

    it("should fail to set password without authentication", async () => {
      const { user } = await setup();
      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/password/set`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: user.emails[0],
          newPassword: "newPassword123",
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(401);
      expect(result).toHaveProperty("message", "unauthorised");
    });

    it("should change password successfully", async () => {
      const { user, session } = await setup();
      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/password/change`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: testPW,
          newPassword: "newPassword123",
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result).toHaveProperty("status", "OK");

      const verifyCredentialsResponse = await verifyCredentials("public", user.emails[0], "newPassword123");
      expect(verifyCredentialsResponse.status).toBe("OK");
    });

    it("should fail to change password with wrong current password", async () => {
      const { session } = await setup();

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/password/change`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: "wrongPassword",
          newPassword: "newPassword123",
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result).toHaveProperty("status", "ERROR");
    });

    it("should fail to change password without authentication", async () => {
      await setup();

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/password/change`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: testPW,
          newPassword: "newPassword123",
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(401);
      expect(result).toHaveProperty("message", "unauthorised");
    });

    it("should get MFA factors successfully", async () => {
      const { session, user } = await setup({
        recipeList: [
          Session.init({
            override: {
              functions: (oI) => {
                return {
                  ...oI,
                  getGlobalClaimValidators: () => [],
                };
              },
            },
          }),
          EmailPassword.init({}),
          MultiFactorAuth.init({
            firstFactors: ["emailpassword"],
          }),
        ],
      });

      await MultiFactorAuth.addToRequiredSecondaryFactorsForUser(user.id, "otp-phone");
      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/mfa`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
      });

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result).toHaveProperty("status", "OK");
      expect(result.requiredSecondaryFactors).toHaveLength(1);
      expect(result.requiredSecondaryFactors).toContain("otp-phone");
    });

    it("should fail to get MFA factors without authentication", async () => {
      await setup();

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/mfa`, {
        method: "GET",
      });

      const result = await response.json();

      expect(response.status).toBe(401);
      expect(result).toHaveProperty("message", "unauthorised");
    });

    it("should set MFA factor as required successfully", async () => {
      const { user, session } = await setup({
        recipeList: [
          Session.init({}),
          EmailPassword.init({}),
          MultiFactorAuth.init({
            firstFactors: ["emailpassword"],
          }),
        ],
      });

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/mfa/set-required`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          factorId: "otp-phone",
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result).toHaveProperty("status", "OK");

      const requiredSecondaryFactors = await MultiFactorAuth.getRequiredSecondaryFactorsForUser(user.id);
      expect(requiredSecondaryFactors).toContain("otp-phone");
    });

    it("should fail to set MFA factor without authentication", async () => {
      await setup();

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/mfa/set-required`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          factorId: "emailpassword",
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(401);
      expect(result).toHaveProperty("message", "unauthorised");
    });

    it("should update OTP email successfully", async () => {
      const { user, session } = await setup({
        recipeList: [
          Session.init({}),
          EmailPassword.init({}),
          AccountLinking.init({
            shouldDoAutomaticAccountLinking: async () => {
              return {
                shouldAutomaticallyLink: true,
                shouldRequireVerification: false,
              };
            },
          }),
          MultiFactorAuth.init({
            firstFactors: ["emailpassword"],
          }),
          Passwordless.init({
            contactMethod: "EMAIL",
            flowType: "USER_INPUT_CODE",
          }),
        ],
      });

      const signInUpResponse = await Passwordless.signInUp({
        email: "otheremail@test.com",
        tenantId: "public",
        session,
      });
      expect(signInUpResponse.status).toBe("OK");
      expect((await getUser(user.id))?.emails).toContain("otheremail@test.com");

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/mfa/update-otp-email`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: "newemail@test.com",
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result).toHaveProperty("status");
      expect((await getUser(user.id))?.emails).toContain("newemail@test.com");
    });

    it("should fail to update OTP email without authentication", async () => {
      await setup();

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/mfa/update-otp-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: "newemail@test.com",
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(401);
      expect(result).toHaveProperty("message", "unauthorised");
    });

    it("should update TOTP device name successfully", async () => {
      const { session, user } = await setup({
        recipeList: [
          Session.init({}),
          EmailPassword.init({}),
          MultiFactorAuth.init({
            firstFactors: ["emailpassword"],
          }),
          TOTP.init(),
        ],
      });

      const oldDevice = await createDevice(user.id, "", "old-device-name");
      expect(oldDevice.status).toBe("OK");

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/mfa/update-totp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "old-device-name",
          newName: "new-device-name",
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result).toHaveProperty("status", "OK");

      const devices = await listDevices(user.id);
      expect(devices.status).toBe("OK");
      expect(devices.devices).toHaveLength(1);
      expect(devices.devices[0].name).toBe("new-device-name");
    });

    it("should fail to update TOTP device name without authentication", async () => {
      await setup();

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/mfa/update-totp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "old-device-name",
          newName: "new-device-name",
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(401);
      expect(result).toHaveProperty("message", "unauthorised");
    });
  });

  describe("exports", () => {
    afterEach(() => {
      resetST();
      Implementation.reset();
    });

    beforeEach(() => {
      resetST();
      Implementation.reset();
    });

    it("should export init function", () => {
      expect(init).toBeDefined();
      expect(typeof init).toBe("function");
    });

    it("should initialize plugin with default config", async () => {
      const { session } = await setup();
      const impl = Implementation.getInstanceOrThrow();

      const config = await impl.getConfigForClient({
        session,
        userContext: {},
      });

      expect(config.status).toBe("OK");
      if (config.status === "OK") {
        expect(config.config.enableSettingPassword).toBe(true);
        expect(config.config.enableThirdPartyLinkning).toBe(true);
        expect(config.config.enableMfaConfiguration).toBe(true);
      }
    });

    it("should initialize plugin with custom config", async () => {
      const { session } = await setup({
        pluginConfig: {
          enableSettingPassword: false,
          enableThirdPartyLinkning: false,
          enableMfaConfiguration: false,
        },
      });
      const impl = Implementation.getInstanceOrThrow();

      const config = await impl.getConfigForClient({
        session,
        userContext: {},
      });

      expect(config.status).toBe("OK");
      if (config.status === "OK") {
        expect(config.config.enableSettingPassword).toBe(false);
        expect(config.config.enableThirdPartyLinkning).toBe(false);
        expect(config.config.enableMfaConfiguration).toBe(false);
      }
    });
  });
});

function resetST() {
  ProcessState.getInstance().reset();
  SessionRaw.reset();
  UserRolesRaw.reset();
  EmailPasswordRaw.reset();
  ThirdPartyRaw.reset();
  AccountLinkingRaw.reset();
  MultitenancyRaw.reset();
  UserMetadataRaw.reset();
  MultiFactorAuthRaw.reset();
  PasswordlessRaw.reset();
  TOTPRaw.reset();
  SuperTokensRaw.reset();
}

async function setup(options?: { pluginConfig?: SuperTokensPluginProfileSecurityConfig; recipeList?: any[] }) {
  let appId;
  let isNewApp = false;
  const coreBaseURL = process.env.CORE_BASE_URL || `http://localhost:3567`;
  if (appId === undefined) {
    isNewApp = true;
    appId = crypto.randomUUID();
    const headers = {
      "Content-Type": "application/json",
    };
    if (process.env.CORE_API_KEY) {
      headers["api-key"] = process.env.CORE_API_KEY;
    }
    await fetch(`${coreBaseURL}/recipe/multitenancy/app/v2`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        appId: appId,
        coreConfig: {},
      }),
    });
  }

  const defaultRecipeList = [Session.init({}), EmailPassword.init({})];
  const recipeList = options?.recipeList || defaultRecipeList;

  SuperTokens.init({
    supertokens: {
      connectionURI: `${coreBaseURL}/appid-${appId}`,
      apiKey: process.env.CORE_API_KEY,
    },
    appInfo: {
      appName: "Test App",
      apiDomain: `http://localhost:${testPORT}`,
      websiteDomain: `http://localhost:${testPORT + 1}`,
    },
    recipeList,
    experimental: {
      plugins: [init(options?.pluginConfig)],
    },
  });

  const app = express();
  app.use(middleware());
  app.get("/check-session", verifySession(), (req, res) => {
    res.json({
      status: "OK",
    });
  });
  app.use(errorHandler());

  await new Promise<void>((resolve) => {
    app.listen(testPORT, () => resolve());
  });

  const testEmail = getTestEmail();
  let user;
  let session;
  if (isNewApp) {
    const signupResponse = await EmailPassword.signUp("public", testEmail, testPW);
    if (signupResponse.status !== "OK") {
      throw new Error("Failed to set up test user");
    }
    user = signupResponse.user;
    session = await Session.createNewSessionWithoutRequestResponse(
      "public",
      SuperTokens.convertToRecipeUserId(user.id),
    );
  } else {
    const userResponse = await SuperTokens.listUsersByAccountInfo("public", {
      email: testEmail,
    });
    user = userResponse[0];
    session = await Session.createNewSessionWithoutRequestResponse(
      "public",
      SuperTokens.convertToRecipeUserId(user.id),
    );
  }

  return {
    user,
    session,
    appId: appId,
  };
}
