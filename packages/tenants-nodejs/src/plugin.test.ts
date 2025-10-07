import express from 'express';
import crypto from 'node:crypto';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';

import SuperTokens from 'supertokens-node/lib/build/index';
import Session from 'supertokens-node/lib/build/recipe/session/index';
import EmailPassword from 'supertokens-node/lib/build/recipe/emailpassword/index';
import ThirdParty from 'supertokens-node/lib/build/recipe/thirdparty/index';
import UserRoles from 'supertokens-node/lib/build/recipe/userroles/index';

import { middleware, errorHandler } from 'supertokens-node/framework/express';
import { verifySession } from 'supertokens-node/lib/build/recipe/session/framework/express';
import { ProcessState } from 'supertokens-node/lib/build/processState';
import SuperTokensRaw from 'supertokens-node/lib/build/supertokens';
import SessionRaw from 'supertokens-node/lib/build/recipe/session/recipe';
import UserRolesRaw from 'supertokens-node/lib/build/recipe/userroles/recipe';
import EmailPasswordRaw from 'supertokens-node/lib/build/recipe/emailpassword/recipe';
import ThirdPartyRaw from 'supertokens-node/lib/build/recipe/thirdparty/recipe';
import AccountLinkingRaw from 'supertokens-node/lib/build/recipe/accountlinking/recipe';
import MultitenancyRaw from 'supertokens-node/lib/build/recipe/multitenancy/recipe';
import UserMetadataRaw from 'supertokens-node/lib/build/recipe/usermetadata/recipe';

import { init } from './plugin';
import { HANDLE_BASE_PATH } from './constants';
import { SuperTokensPluginTenantPluginConfig } from './types';
import { ROLES } from '@shared/tenants';
import { assignAdminToUserInTenant } from './roles';

const testPORT = parseInt(process.env.PORT || '3000');
const testEmail = 'user@test.com';
const testPW = 'test';

describe('tenants-nodejs', () => {
  describe('API Endpoints', () => {
    afterEach(() => {
      resetST();
    });

    beforeEach(() => {
      resetST();
    });

    it('should list tenants successfully for authenticated user', async () => {
      const { session } = await setup({ enableTenantListAPI: true });

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/list`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toHaveProperty('status', 'OK');
      expect(result).toHaveProperty('tenants');
      expect(Array.isArray(result.tenants)).toBe(true);
    });

    it('should fail to list tenants without authentication', async () => {
      await setup({ enableTenantListAPI: true });

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/list`, {
        method: 'GET',
      });

      expect(response.status).toBe(401);
      const result = await response.json();
      expect(result).toHaveProperty('message', 'unauthorised');
    });

    it('should fail to list tenants when tenant list API is disabled', async () => {
      const { session } = await setup({ enableTenantListAPI: false });

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/list`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
        },
      });

      expect(response.status).toBe(400);
      const result = await response.json();
      expect(result).toHaveProperty('status', 'TENANT_SELECTOR_NOT_ENABLED');
    });

    it('should create tenant successfully', async () => {
      const { session } = await setup({
        requireTenantCreationRequestApproval: false,
      });

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/create-tenant`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'testTenant',
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(200);

      expect(result).toHaveProperty('status', 'OK');
      expect(result).toHaveProperty('createdNew');
      expect(result).toHaveProperty('isPendingApproval', false);
    });

    it('should fail to create tenant without authentication', async () => {
      await setup();

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/create-tenant`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'testTenant',
        }),
      });

      expect(response.status).toBe(401);
      const result = await response.json();
      expect(result).toHaveProperty('message', 'unauthorised');
    });

    it('should fail to create tenant without name', async () => {
      const { session } = await setup({
        requireTenantCreationRequestApproval: false,
      });

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/create-tenant`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      const result = await response.json();
      expect(result).toHaveProperty('status', 'ERROR');
      expect(result).toHaveProperty('message', 'Name is required');
    });

    it('should handle tenant creation with approval requirement', async () => {
      const { session } = await setup({
        requireTenantCreationRequestApproval: true,
      });

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/create-tenant`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'testTenant',
        }),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toHaveProperty('status', 'OK');
      expect(result).toHaveProperty('pendingApproval', true);
    });

    it('should switch tenant successfully', async () => {
      const { session } = await setup({
        requireTenantCreationRequestApproval: false,
      });

      // Create a new tenant first
      const createResponse = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/create-tenant`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'testTenant',
        }),
      });

      const createResult = await createResponse.json();
      expect(createResult).toHaveProperty('status', 'OK');
      expect(createResult).toHaveProperty('isPendingApproval', false);

      // Join the tenant
      const joinResponse = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/join-tenant`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tenantId: 'testTenant',
        }),
      });

      const joinResult = await joinResponse.json();

      expect(joinResponse.status).toBe(200);
      expect(joinResult).toHaveProperty('status', 'OK');

      // Extract new session tokens from the response headers
      const accessToken = joinResponse.headers.get('st-access-token');

      // Create a new session object with the new tokens from the testTenant
      const newSession = await Session.getSessionWithoutRequestResponse(accessToken || session.getAccessToken());

      await assignAdminToUserInTenant('testTenant', newSession.getUserId());

      // Refresh the session for changes to take effect.
      await newSession.fetchAndSetClaim(UserRoles.PermissionClaim);
      await newSession.fetchAndSetClaim(UserRoles.UserRoleClaim);

      // Switch to the new tenant
      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/switch-tenant`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${newSession.getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tenantId: 'testTenant',
        }),
      });

      const result = await response.json();

      expect(response.status).toBe(200);

      expect(result).toHaveProperty('status', 'OK');
    });

    it('should fail to switch tenant without authentication', async () => {
      await setup();

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/switch-tenant`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tenantId: 'test-tenant',
        }),
      });

      expect(response.status).toBe(401);
      const result = await response.json();
      expect(result).toHaveProperty('message', 'unauthorised');
    });

    it('should list users in tenant with proper permissions', async () => {
      const { session } = await setup();

      // Make the user an admin first
      await assignAdminToUserInTenant('public', session.getUserId());

      // Refresh the session for changes to take effect.
      await session.fetchAndSetClaim(UserRoles.PermissionClaim);
      await session.fetchAndSetClaim(UserRoles.UserRoleClaim);

      const response = await fetch(`http://localhost:${testPORT}${HANDLE_BASE_PATH}/users`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.getAccessToken()}`,
          'Content-Type': 'application/json',
        },
      });

      const result = await response.json();

      expect(response.status).toBe(200);

      expect(result).toHaveProperty('status', 'OK');
      expect(result).toHaveProperty('users');
      expect(Array.isArray(result.users)).toBe(true);
    });
  });

  describe('exports', () => {
    afterEach(() => {
      resetST();
    });

    beforeEach(() => {
      resetST();
    });

    it('should assign admin role to user in tenant', async () => {
      const { user } = await setup();

      await assignAdminToUserInTenant('public', user.id);

      const roles = await UserRoles.getRolesForUser('public', user.id);
      expect(roles.roles).toContain(ROLES.TENANT_ADMIN);
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

async function setup(pluginConfig?: SuperTokensPluginTenantPluginConfig) {
  let appId;
  let isNewApp = false;
  const coreBaseURL = process.env.CORE_BASE_URL || `http://localhost:3567`;
  if (appId === undefined) {
    isNewApp = true;
    appId = crypto.randomUUID();
    const headers = {
      'Content-Type': 'application/json',
    };
    if (process.env.CORE_API_KEY) {
      headers['api-key'] = process.env.CORE_API_KEY;
    }
    await fetch(`${coreBaseURL}/recipe/multitenancy/app/v2`, {
      method: 'PUT',
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
      appName: 'Test App',
      apiDomain: `http://localhost:${testPORT}`,
      websiteDomain: `http://localhost:${testPORT + 1}`,
    },
    recipeList: [Session.init({}), EmailPassword.init({}), UserRoles.init({})],
    experimental: {
      plugins: [init(pluginConfig)],
    },
  });
  const app = express();
  // This exposes all the APIs from SuperTokens to the client.
  app.use(middleware());
  app.get('/check-session', verifySession(), (req, res) => {
    res.json({
      status: 'OK',
    });
  });
  app.use(errorHandler());

  await new Promise<void>((resolve) => {
    app.listen(testPORT, () => resolve());
  });

  let user;
  let session;
  if (isNewApp) {
    const signupResponse = await EmailPassword.signUp('public', testEmail, testPW);
    if (signupResponse.status !== 'OK') {
      throw new Error('Failed to set up test user');
    }
    user = signupResponse.user;
    session = await Session.createNewSessionWithoutRequestResponse(
      'public',
      SuperTokens.convertToRecipeUserId(user.id),
    );
  } else {
    const userResponse = await SuperTokens.listUsersByAccountInfo('public', {
      email: testEmail,
    });
    user = userResponse[0];
    session = await Session.createNewSessionWithoutRequestResponse(
      'public',
      SuperTokens.convertToRecipeUserId(user.id),
    );
  }

  return {
    user,
    session,
    appId: appId,
  };
}
