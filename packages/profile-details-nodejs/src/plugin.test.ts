import express from "express";
import crypto from "node:crypto";
import { Server } from "http";
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";

import SuperTokens from "supertokens-node/lib/build/index";
import Session from "supertokens-node/lib/build/recipe/session/index";
import EmailPassword from "supertokens-node/lib/build/recipe/emailpassword/index";
import ThirdParty from "supertokens-node/lib/build/recipe/thirdparty/index";

import { middleware, errorHandler } from "supertokens-node/framework/express";
import { verifySession } from "supertokens-node/lib/build/recipe/session/framework/express";
import { Implementation } from "./implementation";
import { ProcessState } from "supertokens-node/lib/build/processState";
import SuperTokensRaw from "supertokens-node/lib/build/supertokens";
import SessionRaw from "supertokens-node/lib/build/recipe/session/recipe";
import UserRolesRaw from "supertokens-node/lib/build/recipe/userroles/recipe";
import EmailPasswordRaw from "supertokens-node/lib/build/recipe/emailpassword/recipe";
import ThirdPartyRaw from "supertokens-node/lib/build/recipe/thirdparty/recipe";
import AccountLinkingRaw from "supertokens-node/lib/build/recipe/accountlinking/recipe";
import MultitenancyRaw from "supertokens-node/lib/build/recipe/multitenancy/recipe";
import UserMetadataRaw from "supertokens-node/lib/build/recipe/usermetadata/recipe";

import { init } from "./plugin";
import { getProfile, getSections, updateProfile } from "./";
import { HANDLE_BASE_PATH } from "./constants";
import { SuperTokensPluginProfileDetailsConfig } from "./types";
import { BASE_FORM_SECTIONS } from "@supertokens-plugins/profile-details-shared";

const testPORT = parseInt(process.env.PORT || "3000");
const testEmail = "user@test.com";
const testPW = "test";
let server: Server | undefined;
let container: StartedTestContainer;
let coreConnectionURI: string;

describe("profile-details-nodejs", () => {
  beforeAll(async () => {
    container = await new GenericContainer("supertokens/supertokens-postgresql")
      .withExposedPorts(3567)
      .withWaitStrategy(Wait.forHttp("/hello", 3567))
      .start();

    const mappedPort = container.getMappedPort(3567);
    coreConnectionURI = `http://${container.getHost()}:${mappedPort}`;
  }, 120000);

  afterAll(async () => {
    if (server) {
      await closeServer();
    }
    if (container) {
      await container.stop();
    }
  });

  afterEach(async () => {
    if (server) {
      await closeServer();
    }
  });

  describe("API Endpoints", () => {
    afterEach(() => {
      resetST();
      Implementation.reset();
    });

    beforeEach(() => {
      resetST();
      Implementation.reset();
    });

    it("should get sections successfully", async () => {
      const { session } = await setup();

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/sections`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toHaveProperty("status", "OK");
      expect(result).toHaveProperty("sections");
      expect(Array.isArray(result.sections)).toBe(true);
      expect(result.sections).toHaveLength(BASE_FORM_SECTIONS.length);
    });

    it("should fail to get sections without authentication", async () => {
      await setup();

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/sections`, {
        method: "GET",
      });

      expect(response.status).toBe(401);
      const result = await response.json();
      expect(result).toHaveProperty("message", "unauthorised");
    });

    it("should get profile successfully", async () => {
      const { user, session } = await setup();

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/profile`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toHaveProperty("status", "OK");
      expect(result).toHaveProperty("profile");
      expect(result).toHaveProperty("user");
      expect(result.user).toHaveProperty("id", user.id);
    });

    it("should fail to get profile without authentication", async () => {
      await setup();

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/profile`, {
        method: "GET",
      });

      expect(response.status).toBe(401);
      const result = await response.json();
      expect(result).toHaveProperty("message", "unauthorised");
    });

    it("should update profile successfully", async () => {
      const { user, session } = await setup();

      const profileData = [
        {
          sectionId: "personal-details",
          fieldId: "firstName",
          value: "John",
        },
        {
          sectionId: "personal-details",
          fieldId: "lastName",
          value: "Doe",
        },
        {
          sectionId: "public-details",
          fieldId: "public-name",
          value: "johndoe",
        },
      ];

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/profile`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: profileData,
        }),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toHaveProperty("status", "OK");

      const profile = await getProfile(user.id, session, {});

      expect(profile).toHaveProperty("firstName", "John");
      expect(profile).toHaveProperty("lastName", "Doe");
    });

    it("should update profile with only the configured fields", async () => {
      const { user, session } = await setup();

      const profileData = [
        {
          sectionId: "personal-details",
          fieldId: "firstName",
          value: "John",
        },
        {
          sectionId: "personal-details",
          fieldId: "unknown",
          value: "Doe",
        },
      ];

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/profile`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: profileData,
        }),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toHaveProperty("status", "OK");

      const profile = await getProfile(user.id, session, {});

      expect(profile).toHaveProperty("firstName", "John");
      expect(profile).not.toHaveProperty("unknown");
    });

    it("should fail to update profile without authentication", async () => {
      await setup();

      const profileData = [
        {
          sectionId: "personal-details",
          fieldId: "firstName",
          value: "John",
        },
      ];

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/profile`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: profileData,
        }),
      });

      expect(response.status).toBe(401);
      const result = await response.json();
      expect(result).toHaveProperty("message", "unauthorised");
    });

    it("should handle empty profile update", async () => {
      const { user, session } = await setup();

      await updateProfile(
        user.id,
        [
          {
            sectionId: "personal-details",
            fieldId: "firstName",
            value: "John",
          },
        ],
        session,
      );

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/profile`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: [],
        }),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toHaveProperty("status", "OK");

      const profile = await getProfile(user.id, session, {});
      expect(profile).toHaveProperty("firstName", "John");
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

    it("should update and get the profile details", async () => {
      const { user, session } = await setup();
      await updateProfile(
        user.id,
        [
          {
            sectionId: "personal-details",
            fieldId: "firstName",
            value: "John",
          },
        ],
        session,
      );
      const profile = await getProfile(user.id, session, {});
      expect(profile).toHaveProperty("firstName", "John");
    });

    it("should get the configured sections", async () => {
      const { session } = await setup();
      const sections = await getSections(session);
      expect(sections).toEqual(BASE_FORM_SECTIONS);
    });
  });

  describe("Third Party Integration", () => {
    afterEach(() => {
      resetST();
      Implementation.reset();
    });

    beforeEach(() => {
      resetST();
      Implementation.reset();
    });

    it("should extract third party field values", async () => {
      await setup();
      const impl = Implementation.getInstanceOrThrow();

      const field = {
        id: "firstName",
        sectionId: "personal-details",
        label: "First Name",
        type: "string" as const,
      };

      const rawUserInfo = {
        name: "John Doe",
        given_name: "John",
      };

      const value = impl.getFieldValueFromThirdPartyUserInfo("google", field, rawUserInfo, {});
      expect(value).toBe("John Doe");
    });

    it("should not override existing profile values from third party", async () => {
      const { session } = await setup();
      const impl = Implementation.getInstanceOrThrow();

      const field = {
        id: "firstName",
        sectionId: "personal-details",
        label: "First Name",
        type: "string" as const,
      };

      const rawUserInfo = {
        name: "John Doe",
      };

      const existingProfile = {
        firstName: "Existing Name",
      };

      const value = impl.getFieldValueFromThirdPartyUserInfo("google", field, rawUserInfo, existingProfile);
      expect(value).toBeUndefined();
    });

    it("should handle avatar URL from third party", async () => {
      const { session } = await setup();
      const impl = Implementation.getInstanceOrThrow();

      const field = {
        id: "avatar",
        sectionId: "public-details",
        label: "Avatar",
        type: "image-url" as const,
      };

      const rawUserInfo = {
        picture: "https://example.com/avatar.jpg",
      };

      const value = impl.getFieldValueFromThirdPartyUserInfo("google", field, rawUserInfo, {});
      expect(value).toBe("https://example.com/avatar.jpg");
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
  SuperTokensRaw.reset();
}

async function closeServer() {
  await new Promise((resolve) => server!.close(resolve));
  server = undefined;
}

async function setup(pluginConfig?: SuperTokensPluginProfileDetailsConfig) {
  let appId;
  let isNewApp = false;
  if (appId === undefined) {
    isNewApp = true;
    appId = crypto.randomUUID();
    const headers = {
      "Content-Type": "application/json",
    };
    await fetch(`${coreConnectionURI}/recipe/multitenancy/app/v2`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        appId: appId,
        coreConfig: {},
      }),
    });
  }

  SuperTokens.init({
    supertokens: {
      connectionURI: `${coreConnectionURI}/appid-${appId}`,
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

  server = await new Promise<Server>((resolve) => {
    const listeningServer = app.listen(testPORT, () => resolve(listeningServer));
  });

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
