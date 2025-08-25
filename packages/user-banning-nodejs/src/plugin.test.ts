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
import { SuperTokensPluginUserBanningPluginConfig } from "./types";
import { DEFAULT_BANNED_USER_ROLE } from "./constants";
import AccountLinkingRaw from "supertokens-node/lib/build/recipe/accountlinking/recipe";
import MultitenancyRaw from "supertokens-node/lib/build/recipe/multitenancy/recipe";
import UserMetadataRaw from "supertokens-node/lib/build/recipe/usermetadata/recipe";
import Multitenancy from "supertokens-node/recipe/multitenancy";

const testPORT = process.env.PORT || 3000;
const testEmail = "user@test.com";
const testPW = "test";

describe("user-banning-nodejs", () => {
  afterEach(() => {
    resetST();
  });

  describe("plugin", () => {
    it("should ban user by setting a role", async () => {
      const { user } = await setup();

      await UserRoles.createNewRoleOrAddPermissions(DEFAULT_BANNED_USER_ROLE, []);
      await UserRoles.addRoleToUser("public", user.id, DEFAULT_BANNED_USER_ROLE);

      const response = await fetch(`http://localhost:${testPORT}/auth/signin`, {
        method: "POST",
        body: JSON.stringify({
          formFields: [
            {
              id: "password",
              value: "test",
            },
            {
              id: "email",
              value: "user@test.com",
            },
          ],
        }),
      });

      expect(response.status).toBeLessThan(500);
      expect(await response.json()).toStrictEqual({
        status: "GENERAL_ERROR",
        message: "User banned",
      });
    });

    it("should unban user by setting a role", async () => {
      const { user } = await setup();

      await UserRoles.createNewRoleOrAddPermissions(DEFAULT_BANNED_USER_ROLE, []);
      await UserRoles.addRoleToUser("public", user.id, DEFAULT_BANNED_USER_ROLE);
      await UserRoles.removeUserRole("public", user.id, DEFAULT_BANNED_USER_ROLE);

      const response = await fetch(`http://localhost:${testPORT}/auth/signin`, {
        method: "POST",
        body: JSON.stringify({
          formFields: [
            {
              id: "password",
              value: "test",
            },
            {
              id: "email",
              value: "user@test.com",
            },
          ],
        }),
      });
      const json = await response.json();

      expect(json).toHaveProperty("status", "OK");
    });

    it("should keep users banned after a server restart", async () => {
      const { user, appId } = await setup();

      await UserRoles.createNewRoleOrAddPermissions(DEFAULT_BANNED_USER_ROLE, []);
      await UserRoles.addRoleToUser("public", user.id, DEFAULT_BANNED_USER_ROLE);

      resetST();
      await setup({}, appId);

      const response = await fetch(`http://localhost:${testPORT}/auth/signin`, {
        method: "POST",
        body: JSON.stringify({
          formFields: [
            {
              id: "password",
              value: "test",
            },
            {
              id: "email",
              value: "user@test.com",
            },
          ],
        }),
      });

      expect(response.status).toBeLessThan(500);
      expect(await response.json()).toStrictEqual({
        status: "GENERAL_ERROR",
        message: "User banned",
      });
    });

    it("should ban sessions by setting a role", async () => {
      const { user, appId } = await setup();

      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(user.id),
      );

      await UserRoles.createNewRoleOrAddPermissions(DEFAULT_BANNED_USER_ROLE, []);
      await UserRoles.addRoleToUser("public", user.id, DEFAULT_BANNED_USER_ROLE);

      const response = await fetch(`http://localhost:${testPORT}/check-session`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toStrictEqual({
        message: "unauthorised",
      });
      expect(response.headers.get("front-token")).toStrictEqual("remove");
    });

    it("should keep sessions banned after a server restart", async () => {
      const { user, appId } = await setup();

      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(user.id),
      );

      await UserRoles.createNewRoleOrAddPermissions(DEFAULT_BANNED_USER_ROLE, []);
      await UserRoles.addRoleToUser("public", user.id, DEFAULT_BANNED_USER_ROLE);

      resetST();
      await setup({}, appId);

      const response = await fetch(`http://localhost:${testPORT}/check-session`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toStrictEqual({
        message: "unauthorised",
      });
      expect(response.headers.get("front-token")).toStrictEqual("remove");
    });

    it("should ban sessions across tenants by setting a role", async () => {
      const { user, appId } = await setup();

      await Multitenancy.createOrUpdateTenant("tenant1");
      await Multitenancy.associateUserToTenant("tenant1", SuperTokens.convertToRecipeUserId(user.id));

      const sessionOnAnotherTenant = await Session.createNewSessionWithoutRequestResponse(
        "tenant1",
        SuperTokens.convertToRecipeUserId(user.id),
      );

      await UserRoles.createNewRoleOrAddPermissions(DEFAULT_BANNED_USER_ROLE, []);
      await UserRoles.addRoleToUser("public", user.id, DEFAULT_BANNED_USER_ROLE);

      const response = await fetch(`http://localhost:${testPORT}/check-session`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${sessionOnAnotherTenant.getAccessToken()}`,
        },
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toStrictEqual({
        message: "unauthorised",
      });
      expect(response.headers.get("front-token")).toStrictEqual("remove");
    });

    it("should ban user by setting a role on a different tenant", async () => {
      const { user } = await setup();

      await Multitenancy.createOrUpdateTenant("tenant1", { firstFactors: null });
      await Multitenancy.associateUserToTenant("tenant1", SuperTokens.convertToRecipeUserId(user.id));

      await UserRoles.createNewRoleOrAddPermissions(DEFAULT_BANNED_USER_ROLE, []);
      await UserRoles.addRoleToUser("public", user.id, DEFAULT_BANNED_USER_ROLE);

      const response = await fetch(`http://localhost:${testPORT}/auth/tenant1/signin`, {
        method: "POST",
        body: JSON.stringify({
          formFields: [
            {
              id: "password",
              value: "test",
            },
            {
              id: "email",
              value: "user@test.com",
            },
          ],
        }),
      });

      expect(response.status).toBeLessThan(500);
      expect(await response.json()).toStrictEqual({
        status: "GENERAL_ERROR",
        message: "User banned",
      });
    });
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

async function setup(pluginConfig?: SuperTokensPluginUserBanningPluginConfig, appId?: string) {
  let isNewApp = false;
  if (appId === undefined) {
    isNewApp = true;
    appId = crypto.randomUUID();
    const createAppResp = await fetch(`http://localhost:3567/recipe/multitenancy/app/v2`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        appId,
        coreConfig: {},
      }),
    });
  }

  SuperTokens.init({
    supertokens: {
      connectionURI: `http://localhost:3567/appid-${appId}`,
    },
    appInfo: {
      appName: "Test App",
      apiDomain: `http://localhost:${testPORT}`,
      websiteDomain: `http://localhost:${testPORT + 1}`,
    },
    recipeList: [Session.init({}), UserRoles.init({}), EmailPassword.init({})],
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
