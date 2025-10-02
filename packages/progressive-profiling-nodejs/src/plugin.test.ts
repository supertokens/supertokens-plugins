import express from "express";
import crypto from "node:crypto";
import { describe, it, expect, afterEach, beforeEach } from "vitest";

import { FormSection } from "./types";
import { registerSections, init, getSectionValues, setSectionValues, getAllSections } from "./index";
import { HANDLE_BASE_PATH } from "./constants";

import SuperTokens from "supertokens-node/lib/build/index";
import Session from "supertokens-node/lib/build/recipe/session/index";
import EmailPassword from "supertokens-node/lib/build/recipe/emailpassword/index";

import { middleware, errorHandler } from "supertokens-node/framework/express";
import { verifySession } from "supertokens-node/lib/build/recipe/session/framework/express";

import { ProcessState } from "supertokens-node/lib/build/processState";
import SuperTokensRaw from "supertokens-node/lib/build/supertokens";
import SessionRaw from "supertokens-node/lib/build/recipe/session/recipe";
import UserRolesRaw from "supertokens-node/lib/build/recipe/userroles/recipe";
import EmailPasswordRaw from "supertokens-node/lib/build/recipe/emailpassword/recipe";
import AccountLinkingRaw from "supertokens-node/lib/build/recipe/accountlinking/recipe";
import MultitenancyRaw from "supertokens-node/lib/build/recipe/multitenancy/recipe";
import UserMetadataRaw from "supertokens-node/lib/build/recipe/usermetadata/recipe";
import { Implementation } from "./implementation";

const testPORT = process.env.PORT || 3000;
const testEmail = "user@test.com";
const testPW = "test";
const testSections = [
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
] as FormSection[];

describe("progressive-profiling-nodejs", () => {
  describe("API", () => {
    afterEach(() => {
      resetST();
      Implementation.reset();
    });

    beforeEach(() => {
      resetST();
      Implementation.reset();
    });

    it("should get the default configured sections", async () => {
      const { user } = await setup({
        sections: testSections,
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
      expect(result.sections).toEqual(testSections.map((section) => ({ ...section, completed: false })));
    });

    it("should get the registered sections", async () => {
      const { user } = await setup();

      registerSections({
        get: async () => [],
        set: async () => {},
        storageHandlerId: "test",
        sections: testSections,
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
      expect(result.sections).toEqual(testSections.map((section) => ({ ...section, completed: false })));
    });

    it("should fail claim validation if the profile is not completed", async () => {
      const { user } = await setup({
        sections: testSections,
      });

      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(user.id)
      );

      const claims = await Session.validateClaimsForSessionHandle(session.getHandle());
      expect(claims.status).toBe("OK");

      // @ts-ignore
      expect(claims.invalidClaims).toContainEqual({
        id: "stpl-pp-completed",
        reason: {
          actualValue: false,
          expectedValue: true,
          message: "wrong value",
        },
      });
    });

    it("should pass claim validation if the profile is completed", async () => {
      const { user } = await setup({
        sections: testSections,
      });

      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(user.id)
      );

      const claims = await Session.validateClaimsForSessionHandle(session.getHandle());
      expect(claims.status).toBe("OK");

      // @ts-expect-error we'd need to do an if check on the status because of the discriminated union type
      expect(claims.invalidClaims).toContainEqual({
        id: "stpl-pp-completed",
        reason: {
          actualValue: false,
          expectedValue: true,
          message: "wrong value",
        },
      });

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/profile`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
        body: JSON.stringify({
          data: testSections
            .map((section) =>
              section.fields.map((field) => ({
                sectionId: section.id,
                fieldId: field.id,
                value: "value",
              }))
            )
            .flat(),
        }),
      });
      expect(response.status).toBe(200);

      const validatedClaims = await Session.validateClaimsForSessionHandle(session.getHandle());
      expect(claims.status).toBe("OK");
      // @ts-expect-error we'd need to do an if check on the status because of the discriminated union type
      expect(validatedClaims.invalidClaims).toHaveLength(0);
    });

    it("should not allow api calls if the claim is not valid", async () => {
      const { user } = await setup({
        sections: testSections,
      });

      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(user.id)
      );

      const response = await fetch(`http://localhost:${testPORT}/check-session`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
      });
      expect(response.status).toBe(403);

      const result = await response.json();
      expect(result.message).toBe("invalid claim");
    });

    it("should allow api calls if the claim is valid", async () => {
      const { user } = await setup({
        sections: testSections,
      });

      let session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(user.id)
      );

      await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/profile`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
        body: JSON.stringify({
          data: testSections
            .map((section) =>
              section.fields.map((field) => ({
                sectionId: section.id,
                fieldId: field.id,
                value: "value",
              }))
            )
            .flat(),
        }),
      });

      session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(user.id)
      );

      const response = await fetch(`http://localhost:${testPORT}/check-session`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
      });
      expect(response.status).toBe(200);
    });

    it("should set the profile details using the default storage handler", async () => {
      const { user } = await setup({
        sections: testSections,
      });

      let session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(user.id)
      );

      await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/profile`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
        body: JSON.stringify({
          data: testSections
            .map((section) =>
              section.fields.map((field) => ({
                sectionId: section.id,
                fieldId: field.id,
                value: "value",
              }))
            )
            .flat(),
        }),
      });

      const sectionValues = await getSectionValues({ session });
      expect(sectionValues.status).toBe("OK");
      expect(sectionValues.data).toEqual(
        testSections
          .map((section) =>
            section.fields.map((field) => ({ fieldId: field.id, sectionId: section.id, value: "value" }))
          )
          .flat()
      );
    });

    it("should set the profile details using a custom storage handler", async () => {
      const { user } = await setup({
        sections: testSections,
        override: (oI) => ({
          ...oI,
          defaultStorageHandlerSetFields: () => Promise.resolve(),
        }),
      });

      let session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(user.id)
      );

      await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/profile`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
        body: JSON.stringify({
          data: testSections
            .map((section) =>
              section.fields.map((field) => ({
                sectionId: section.id,
                fieldId: field.id,
                value: "value",
              }))
            )
            .flat(),
        }),
      });

      const sectionValues = await getSectionValues({ session });
      expect(sectionValues.status).toBe("OK");
      expect(sectionValues.data).toEqual(
        testSections
          .map((section) =>
            section.fields.map((field) => ({ fieldId: field.id, sectionId: section.id, value: field.defaultValue }))
          )
          .flat()
      );
    });

    it("should set the profile details partially", async () => {
      const { user } = await setup({
        sections: [
          {
            ...testSections[0],
            fields: [
              ...testSections[0].fields,
              {
                id: "test2",
                label: "Test2",
                type: "text",
                required: false,
                description: "Test2",
                placeholder: "Test2",
              },
            ],
          },
        ],
      });

      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(user.id)
      );

      await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/profile`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
        body: JSON.stringify({
          data: testSections
            .map((section) =>
              section.fields.map((field) => ({
                sectionId: section.id,
                fieldId: field.id,
                value: "value",
              }))
            )
            .flat(),
        }),
      });

      const sectionValues = await getSectionValues({ session });
      expect(sectionValues.status).toBe("OK");
      expect(sectionValues.data).toEqual([
        ...testSections
          .map((section) =>
            section.fields.map((field) => ({ fieldId: field.id, sectionId: section.id, value: "value" }))
          )
          .flat(),
        { fieldId: "test2", sectionId: "test" },
      ]);
    });

    it("should return the profile details using the default storage handler", async () => {
      const { user } = await setup({
        sections: testSections,
      });

      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(user.id)
      );

      await setSectionValues({
        session,
        data: testSections
          .map((section) =>
            section.fields.map((field) => ({
              sectionId: section.id,
              fieldId: field.id,
              value: "value",
            }))
          )
          .flat(),
      });

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/profile`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
      });
      expect(response.status).toBe(200);

      const result = await response.json();
      expect(result.status).toBe("OK");
      expect(result.data).toEqual(
        testSections
          .map((section) =>
            section.fields.map((field) => ({ fieldId: field.id, sectionId: section.id, value: "value" }))
          )
          .flat()
      );
    });

    it("should return the profile details using a custom storage handler", async () => {
      const { user } = await setup({
        sections: testSections,
        override: (oI) => ({
          ...oI,
          defaultStorageHandlerGetFields: (...props) => Promise.resolve([]),
        }),
      });

      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(user.id)
      );

      await setSectionValues({
        session,
        data: testSections
          .map((section) =>
            section.fields.map((field) => ({
              sectionId: section.id,
              fieldId: field.id,
              value: "value",
            }))
          )
          .flat(),
      });

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/profile`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
      });
      expect(response.status).toBe(200);

      const result = await response.json();
      expect(result.status).toBe("OK");
      expect(result.data).toEqual([]);
    });

    it("should validate the profile details using the default validator", async () => {
      const { user } = await setup({
        sections: testSections.map((section) => ({
          ...section,
          fields: section.fields.map((field) => ({ ...field, required: true, defaultValue: undefined })),
        })),
      });

      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(user.id)
      );

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/profile`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
        body: JSON.stringify({
          data: testSections
            .map((section) =>
              section.fields.map((field) => ({
                sectionId: section.id,
                fieldId: field.id,
                value: undefined,
              }))
            )
            .flat(),
        }),
      });

      expect(response.status).toBe(400);

      const result = await response.json();
      expect(result).toEqual({
        status: "INVALID_FIELDS",
        errors: testSections
          .map((section) =>
            section.fields.map((field) => ({ id: field.id, error: `The "${field.label}" field is required` }))
          )
          .flat(),
      });
    });

    it("should validate the profile details using a custom validator", async () => {
      const { user } = await setup({
        sections: testSections,
        override: (oI) => ({
          ...oI,
          validateField: () => {
            return "TestInvalid";
          },
        }),
      });

      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        SuperTokens.convertToRecipeUserId(user.id)
      );

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/profile`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
        body: JSON.stringify({
          data: testSections
            .map((section) =>
              section.fields.map((field) => ({
                sectionId: section.id,
                fieldId: field.id,
                value: "value",
              }))
            )
            .flat(),
        }),
      });

      expect(response.status).toBe(400);

      const result = await response.json();
      expect(result).toEqual({
        status: "INVALID_FIELDS",
        errors: testSections
          .map((section) => section.fields.map((field) => ({ id: field.id, error: "TestInvalid" })))
          .flat(),
      });
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

    describe("registerSections", () => {
      it("should export the function", () => {
        expect(getAllSections).toBeDefined();
      });

      it("should return the sections", async () => {
        const { user } = await setup({
          sections: testSections,
        });
        const session = await Session.createNewSessionWithoutRequestResponse(
          "public",
          SuperTokens.convertToRecipeUserId(user.id)
        );
        const sections = await getAllSections({ session });
        expect(sections).toEqual(
          testSections.map((section) => ({ ...section, completed: undefined, storageHandlerId: "default" }))
        );
      });

      it("should return the correct sections when the getAllSections method is overridden", async () => {
        const { user } = await setup({
          sections: testSections,
          override: (oI) => ({
            ...oI,
            getAllSections: () =>
              testSections.map((section) => ({
                ...section,
                completed: undefined,
                storageHandlerId: "defaultOverride",
              })),
          }),
        });

        const session = await Session.createNewSessionWithoutRequestResponse(
          "public",
          SuperTokens.convertToRecipeUserId(user.id)
        );

        const sections = getAllSections({ session });
        expect(sections).toEqual(
          testSections.map((section) => ({ ...section, completed: undefined, storageHandlerId: "defaultOverride" }))
        );
      });
    });
  });
});

function resetST() {
  ProcessState.getInstance().reset();
  SessionRaw.reset();
  UserRolesRaw.reset();
  EmailPasswordRaw.reset();
  AccountLinkingRaw.reset();
  MultitenancyRaw.reset();
  UserMetadataRaw.reset();
  SuperTokensRaw.reset();
}

async function setup(pluginConfig?: Parameters<typeof init>[0]) {
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
    appId: appId,
  };
}
