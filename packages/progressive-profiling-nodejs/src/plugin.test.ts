import { init } from "./plugin";
import SuperTokens from "supertokens-node";
import SuperTokensRaw from "supertokens-node/lib/build/supertokens";
import Session from "supertokens-node/recipe/session";
import UserRoles from "supertokens-node/recipe/userroles";
import SessionRaw from "supertokens-node/lib/build/recipe/session/recipe";
import UserRolesRaw from "supertokens-node/lib/build/recipe/userroles/recipe";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { middleware, errorHandler } from "supertokens-node/framework/express";
import { verifySession } from "supertokens-node/recipe/session/framework/express";
import EmailPassword from "supertokens-node/recipe/emailpassword";
import EmailPasswordRaw from "supertokens-node/lib/build/recipe/emailpassword/recipe";
import { FormSection, SuperTokensPluginProfileProgressiveProfilingConfig } from "./types";
import AccountLinkingRaw from "supertokens-node/lib/build/recipe/accountlinking/recipe";
import MultitenancyRaw from "supertokens-node/lib/build/recipe/multitenancy/recipe";
import UserMetadataRaw from "supertokens-node/lib/build/recipe/usermetadata/recipe";
import Multitenancy from "supertokens-node/recipe/multitenancy";
import { registerSections } from "./index";
import crypto from "node:crypto";
import { HANDLE_BASE_PATH } from "./constants";
import { DEFAULT_BANNED_USER_ROLE } from "../../user-banning-nodejs/src/constants";

const testPORT = process.env.PORT || 3000;
const testEmail = "user@test.com";
const testPW = "test";

describe("progressive-profiling-nodejs", () => {
  describe("[API]", () => {
    afterEach(() => {
      resetST();
    });

    beforeEach(() => {
      resetST();
    });

    it("should get the default configured sections", async () => {
      const sections = [
        {
          id: "test",
          label: "Test",
          fields: [
            {
              id: "test",
              label: "Test",
              type: "text",
              required: false,
              defaultValue: "test",
              description: "Test",
              placeholder: "Test",
            },
          ],
        },
      ];
      const { user } = await setup({
        sections: sections as FormSection[],
      });

      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(user.id)
      );

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/sections`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
      });

      expect(response.status).toBe(200);

      const result = await response.json();

      expect(result.status).toBe("OK");
      expect(result.sections).toEqual(sections.map((section) => ({ ...section, completed: false })));
    });

    it("should get the registered sections", async () => {
      const { user } = await setup();

      const sections = [
        {
          id: "test",
          label: "Test",
          fields: [
            {
              id: "test",
              label: "Test",
              type: "text",
              required: false,
              defaultValue: "test",
              description: "Test",
              placeholder: "Test",
            },
          ],
        },
      ];

      registerSections({
        get: async () => [],
        set: async () => {},
        registratorId: "test",
        sections: sections as FormSection[],
      });

      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(user.id)
      );

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/sections`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
      });

      expect(response.status).toBe(200);

      const result = await response.json();

      expect(result.status).toBe("OK");
      expect(result.sections).toEqual(sections.map((section) => ({ ...section, completed: false })));
    });

    it("should fail claim validation if the profile is not completed", async () => {});
    it("should allow api calls even if the claim is not valid", async () => {});
    it("should not allow api calls to get profile if session is not valid", async () => {});
    it("should not allow api calls to set profile if session is not valid", async () => {});
    it("should return the profile details for every sections and fields", async () => {});
    it("should set the profile details using the default registrator", async () => {});
    it("should set the profile details using a custom registrator", async () => {});
    it("should set the profile details partially", async () => {});
    it("should validate the profile details", async () => {});
    it("should check if the profile is completed", async () => {});
  });
});

function resetST() {
  SuperTokensRaw.reset();
  SessionRaw.reset();
  UserRolesRaw.reset();
  EmailPasswordRaw.reset();
  AccountLinkingRaw.reset();
  MultitenancyRaw.reset();
  UserMetadataRaw.reset();
}

async function setup(pluginConfig?: SuperTokensPluginProfileProgressiveProfilingConfig, appId?: string) {
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
    const createAppResp = await fetch(`${coreBaseURL}/recipe/multitenancy/app/v2`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        appId,
        coreConfig: {},
      }),
    });
  }

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
    recipeList: [Session.init({}), EmailPassword.init({})],
    experimental: {
      plugins: [init(pluginConfig)],
    },
  });
  const app = express();
  // This exposes all the APIs from SuperTokens to the client.
  app.use(middleware());
  app.get("/check-session", verifySession(), (req, res) => {
    res.json({
      status: "OK",
    });
  });
  app.use(errorHandler());

  await new Promise((resolve) => app.listen(testPORT, resolve));

  let user;
  if (isNewApp) {
    const signupResponse = await EmailPassword.signUp("public", testEmail, testPW);
    if (signupResponse.status !== "OK") {
      console.log(signupResponse);
      throw new Error("Failed to set up test user");
    }
    user = signupResponse.user;
  } else {
    const userResponse = await SuperTokens.listUsersByAccountInfo("public", {
      email: testEmail,
    });
    user = userResponse[0];
  }

  return {
    user,
    appId,
  };
}
