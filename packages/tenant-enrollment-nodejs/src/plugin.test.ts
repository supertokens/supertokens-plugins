import express from 'express';
import crypto from 'node:crypto';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';

// SuperTokens Core
import SuperTokens, { getUser } from 'supertokens-node';
import Session from 'supertokens-node/recipe/session';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import ThirdParty from 'supertokens-node/recipe/thirdparty';
import Passwordless from 'supertokens-node/recipe/passwordless';
import WebAuthn from 'supertokens-node/recipe/webauthn';
import UserRoles from 'supertokens-node/recipe/userroles';
import Multitenancy from 'supertokens-node/recipe/multitenancy';
import AccountLinking from 'supertokens-node/recipe/accountlinking';
import UserMetadata from 'supertokens-node/recipe/usermetadata';

// SuperTokens Framework
import { middleware, errorHandler } from 'supertokens-node/framework/express';
import { verifySession } from 'supertokens-node/recipe/session/framework/express';

// Raw Instances (for reset/cleanup)
import { ProcessState } from 'supertokens-node/lib/build/processState';
import SuperTokensRaw from 'supertokens-node/lib/build/supertokens';
import SessionRaw from 'supertokens-node/lib/build/recipe/session/recipe';
import UserRolesRaw from 'supertokens-node/lib/build/recipe/userroles/recipe';
import EmailPasswordRaw from 'supertokens-node/lib/build/recipe/emailpassword/recipe';
import ThirdPartyRaw from 'supertokens-node/lib/build/recipe/thirdparty/recipe';
import PasswordlessRaw from 'supertokens-node/lib/build/recipe/passwordless/recipe';
import WebAuthnRaw from 'supertokens-node/lib/build/recipe/webauthn/recipe';
import AccountLinkingRaw from 'supertokens-node/lib/build/recipe/accountlinking/recipe';
import MultitenancyRaw from 'supertokens-node/lib/build/recipe/multitenancy/recipe';
import UserMetadataRaw from 'supertokens-node/lib/build/recipe/usermetadata/recipe';

// Plugins
import tenantsPlugin from '@supertokens-plugins/tenants-nodejs';
import { init } from './plugin';
import type { SuperTokensPluginTenantEnrollmentPluginConfig } from './types';

const testPORT = parseInt(process.env.PORT || '3000');
const testEmail = 'user@test.com';
const testPW = 'test1234';

function resetST() {
  ProcessState.getInstance().reset();
  SuperTokensRaw.reset();
  SessionRaw.reset();
  UserRolesRaw.reset();
  EmailPasswordRaw.reset();
  ThirdPartyRaw.reset();
  PasswordlessRaw.reset();
  WebAuthnRaw.reset();
  AccountLinkingRaw.reset();
  MultitenancyRaw.reset();
  UserMetadataRaw.reset();
}

async function setup(pluginConfig: SuperTokensPluginTenantEnrollmentPluginConfig) {
  let appId;
  let isNewApp = false;
  const coreBaseURL = process.env.CORE_BASE_URL || `http://localhost:3567`;

  // Generate unique app ID and create app via Core API
  if (appId === undefined) {
    isNewApp = true;
    appId = crypto.randomUUID();
    const headers: Record<string, string> = {
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

  // Initialize SuperTokens with plugins
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
    recipeList: [
      Session.init({}),
      EmailPassword.init({}),
      ThirdParty.init({
        signInAndUpFeature: {
          providers: [
            {
              config: {
                thirdPartyId: 'google',
                clients: [
                  {
                    clientId: 'test',
                    clientSecret: 'test',
                  },
                ],
              },
            },
            {
              config: {
                thirdPartyId: 'boxy-saml-provider1',
                clients: [
                  {
                    clientId: 'test',
                    clientSecret: 'test',
                  },
                ],
              },
            },
          ],
        },
      }),
      Passwordless.init({
        contactMethod: 'EMAIL',
        flowType: 'USER_INPUT_CODE_AND_MAGIC_LINK',
      }),
      WebAuthn.init({}),
      UserRoles.init({}),
      AccountLinking.init({
        shouldDoAutomaticAccountLinking: async () => ({
          shouldAutomaticallyLink: false,
          shouldRequireVerification: false,
        }),
      }),
      Multitenancy.init({}),
      UserMetadata.init({}),
    ],
    experimental: {
      plugins: [tenantsPlugin.init(), init(pluginConfig)],
    },
  });

  // Create Express app with SuperTokens middleware
  const app = express();
  app.use(middleware());
  app.get('/check-session', verifySession(), (req, res) => {
    res.json({ status: 'OK' });
  });
  app.use(errorHandler());

  // Start server
  await new Promise<void>((resolve) => {
    app.listen(testPORT, () => resolve());
  });

  // Create test user
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

  return { user, session, appId };
}

describe('tenant-enrollment-nodejs', () => {
  beforeEach(() => {
    resetST();
  });

  afterEach(() => {
    resetST();
  });

  describe('Email Domain Validation', () => {
    it('should allow signup when email domain matches tenant configuration', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'company.com': 'tenant-1' },
      });

      // Create tenant
      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['emailpassword'],
      });

      // Try to sign up with matching domain
      const response = await EmailPassword.signUp('tenant-1', 'user@company.com', testPW);

      expect(response.status).toBe('OK');
    });

    it('should reject signup when email domain does not match tenant', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'company.com': 'tenant-1' },
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['emailpassword'],
      });

      const response = await EmailPassword.signUp('tenant-1', 'user@other.com', testPW);

      expect(response.status).toBe('EMAIL_ALREADY_EXISTS_ERROR');
      expect((response as any).reason.toLowerCase()).toContain('email domain');
    });

    it('should handle case-insensitive domain matching', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'company.com': 'tenant-1' },
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['emailpassword'],
      });

      const response = await EmailPassword.signUp('tenant-1', 'user@COMPANY.COM', testPW);

      expect(response.status).toBe('OK');
    });

    it('should handle subdomain matching correctly', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'sub.company.com': 'tenant-1' },
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['emailpassword'],
      });

      const response = await EmailPassword.signUp('tenant-1', 'user@sub.company.com', testPW);

      expect(response.status).toBe('OK');
    });

    it('should allow signup to public tenant without domain check', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'company.com': 'tenant-1' },
      });

      // Try to sign up to public tenant with any email
      const response = await EmailPassword.signUp('public', 'user@anydomain.com', testPW);

      expect(response.status).toBe('OK');
    });
  });

  describe('Invite-Only Tenant Logic', () => {
    it('should block signup for invite-only tenant without approval', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'test.com': 'tenant-1' },
        inviteOnlyTenants: ['tenant-1'],
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['emailpassword'],
      });

      const response = await EmailPassword.signUp('tenant-1', 'user@test.com', testPW);

      expect(response.status).toBe('EMAIL_ALREADY_EXISTS_ERROR');
      expect((response as any).reason.toLowerCase()).toContain('invite only');
    });

    it('should allow signup for non-invite-only tenant', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'test.com': 'tenant-1' },
        inviteOnlyTenants: ['tenant-2'],
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['emailpassword'],
      });

      const response = await EmailPassword.signUp('tenant-1', 'user@test.com', testPW);

      expect(response.status).toBe('OK');
    });

    it('should allow signup to public tenant regardless of invite-only config', async () => {
      await setup({
        emailDomainToTenantIdMap: {},
        inviteOnlyTenants: ['tenant-1'],
      });

      const response = await EmailPassword.signUp('public', 'user1@test.com', testPW);

      expect(response.status).toBe('OK');
    });

    it('should allow signup with approved SAML provider in invite-only tenant', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'test.com': 'tenant-1' },
        inviteOnlyTenants: ['tenant-1'],
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['thirdparty'],
      });

      const response = await ThirdParty.manuallyCreateOrUpdateUser(
        'tenant-1',
        'boxy-saml-provider1',
        'external-user-id',
        'user@test.com',
        false,
      );

      expect(response.status).toBe('OK');
    });

    it('should allow existing user to sign in to invite-only tenant', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'test.com': 'tenant-2' },
        inviteOnlyTenants: ['tenant-1'],
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['emailpassword'],
      });

      // First create user in public tenant
      const signupResponse = await EmailPassword.signUp('public', 'existing@test.com', testPW);
      expect(signupResponse.status).toBe('OK');

      // Manually associate user with tenant-1
      if (signupResponse.status === 'OK') {
        await Multitenancy.associateUserToTenant('tenant-1', signupResponse.user.loginMethods[0].recipeUserId);

        // Now try to sign in (should work since user already exists in tenant)
        const signinResponse = await EmailPassword.signIn('tenant-1', 'existing@test.com', testPW);
        expect(signinResponse.status).toBe('OK');
      }
    });
  });

  describe('Approval Workflow', () => {
    it('should automatically add user to tenant when approval not required', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'company.com': 'tenant-1' },
        requiresApprovalTenants: [],
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['emailpassword'],
      });

      const response = await EmailPassword.signUp('tenant-1', 'user@company.com', testPW);

      expect(response.status).toBe('OK');

      // Verify user is associated with tenant
      if (response.status === 'OK') {
        const userDetails = await getUser(response.user.id);
        expect(userDetails?.tenantIds).toContain('tenant-1');
      }
    });

    it('should require approval for tenant in requiresApprovalTenants list', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'company.com': 'tenant-1' },
        requiresApprovalTenants: ['tenant-1'],
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['emailpassword'],
      });

      const response = await EmailPassword.signUp('tenant-1', 'user1ForTenant1@company.com', testPW);

      expect(response.status).toBe('OK');

      // User should be associated with tenant since requiring approval means
      // they aren't given a role but are associated with the tenant.
      if (response.status === 'OK') {
        const userDetails = await getUser(response.user.id);
        // User should be in public tenant and tenant-1
        expect(userDetails?.tenantIds.includes('tenant-1')).toBe(true);
      }
    });

    it('should not require approval for public tenant', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'test.com': 'tenant-2' },
        requiresApprovalTenants: ['tenant-1'],
      });

      const response = await EmailPassword.signUp('public', 'user2@test.com', testPW);

      expect(response.status).toBe('OK');

      // User should be in public tenant
      if (response.status === 'OK') {
        const userDetails = await getUser(response.user.id);
        expect(userDetails?.tenantIds).toContain('public');
      }
    });

    it('should allow signup with matching domain but no approval config', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'company.com': 'tenant-1' },
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['emailpassword'],
      });

      const response = await EmailPassword.signUp('tenant-1', 'user@company.com', testPW);

      expect(response.status).toBe('OK');

      // User should be automatically added
      if (response.status === 'OK') {
        const userDetails = await getUser(response.user.id);
        expect(userDetails?.tenantIds).toContain('tenant-1');
      }
    });
  });

  describe('Passwordless Recipe Overrides', () => {
    it('should validate email domain for passwordless code creation', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'company.com': 'tenant-1' },
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['passwordless'],
      });

      // Should fail with non-matching domain
      const response = await Passwordless.createCode({
        tenantId: 'tenant-1',
        email: 'user@other.com',
      });

      expect(response.status).toBe('GENERAL_ERROR');
      expect((response as any).message.toLowerCase()).toContain('email domain');
    });

    it('should allow passwordless code creation with matching domain', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'company.com': 'tenant-1' },
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['passwordless'],
      });

      const response = await Passwordless.createCode({
        tenantId: 'tenant-1',
        email: 'user@company.com',
      });

      expect(response.status).toBe('OK');
    });

    it('should block passwordless signup in invite-only tenant', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'test.com': 'tenant-1' },
        inviteOnlyTenants: ['tenant-1'],
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['passwordless'],
      });

      const response = await Passwordless.createCode({
        tenantId: 'tenant-1',
        email: 'user@test.com',
      });

      expect(response.status).toBe('GENERAL_ERROR');
      expect((response as any).message).toContain('invite only');
    });

    it('should not allow passwordless for phone number', async () => {
      await setup({
        inviteOnlyTenants: ['tenant-1'],
        emailDomainToTenantIdMap: { 'company.com': 'tenant-1' },
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['passwordless'],
      });

      // Phone numbers should bypass restrictions
      const response = await Passwordless.createCode({
        tenantId: 'tenant-1',
        phoneNumber: '+1234567890',
      });

      console.log(response);

      expect(response.status).toBe('GENERAL_ERROR');
      expect((response as any).message).toContain('invite only');
    });
  });

  describe('Multitenancy Recipe Integration', () => {
    it('should inject inviteOnly flag in loginMethods for invite-only tenant', async () => {
      await setup({
        emailDomainToTenantIdMap: {},
        inviteOnlyTenants: ['tenant-1'],
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['emailpassword'],
      });

      const response = await fetch(`http://localhost:${testPORT}/auth/tenant-1/loginmethods`, {
        method: 'GET',
      });

      const result = await response.json();
      expect(result.isTenantInviteOnly).toBe(true);
    });

    it('should not set inviteOnly flag for non-invite-only tenant', async () => {
      await setup({
        emailDomainToTenantIdMap: {},
        inviteOnlyTenants: ['tenant-2'],
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['emailpassword'],
      });

      const response = await fetch(`http://localhost:${testPORT}/auth/tenant-1/loginmethods`, {
        method: 'GET',
      });

      const result = await response.json();
      expect(result.isTenantInviteOnly).toBe(false);
    });

    it('should not set inviteOnly flag for public tenant', async () => {
      await setup({
        emailDomainToTenantIdMap: {},
        inviteOnlyTenants: ['tenant-1'],
      });

      const response = await fetch(`http://localhost:${testPORT}/auth/loginmethods`, {
        method: 'GET',
      });

      const result = await response.json();
      expect(result.isTenantInviteOnly).toBe(false);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should not allow signup when no configuration is provided', async () => {
      await setup({
        emailDomainToTenantIdMap: {},
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['emailpassword'],
      });

      const response = await EmailPassword.signUp('tenant-1', 'user@any.com', testPW);

      expect(response.status).toBe('EMAIL_ALREADY_EXISTS_ERROR');
      expect((response as any).reason.toLowerCase()).toContain('email domain not allowed');
    });

    it('should handle tenant that does not exist by denying signup', async () => {
      await setup({
        emailDomainToTenantIdMap: {},
        inviteOnlyTenants: ['tenant-1'],
      });

      // Try to sign up to non-existent tenant
      const response = await EmailPassword.signUp('nonexistent', 'user@test.com', testPW);

      expect(response.status).toBe('EMAIL_ALREADY_EXISTS_ERROR');
      expect((response as any).reason.toLowerCase()).toContain('email domain not allowed');
    });

    it('should handle multiple domain mappings correctly', async () => {
      await setup({
        emailDomainToTenantIdMap: {
          'company1.com': 'tenant-1',
          'company2.com': 'tenant-2',
          'company3.com': 'tenant-3',
        },
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['emailpassword'],
      });

      const response1 = await EmailPassword.signUp('tenant-1', 'user@company1.com', testPW);
      expect(response1.status).toBe('OK');

      const response2 = await EmailPassword.signUp('tenant-1', 'user2@company2.com', testPW);
      expect(response2.status).toBe('EMAIL_ALREADY_EXISTS_ERROR');
    });

    it('should handle combined restrictions properly', async () => {
      await setup({
        emailDomainToTenantIdMap: { 'company.com': 'tenant-1' },
        inviteOnlyTenants: ['tenant-1'],
        requiresApprovalTenants: ['tenant-1'],
      });

      await Multitenancy.createOrUpdateTenant('tenant-1', {
        firstFactors: ['emailpassword'],
      });

      // Should fail invite-only check first
      const response1 = await EmailPassword.signUp('tenant-1', 'user@company.com', testPW);
      expect(response1.status).toBe('EMAIL_ALREADY_EXISTS_ERROR');
      expect((response1 as any).reason.toLowerCase()).toContain('invite only');

      // Should throw invite only since it doesn't make sense
      // to check domain further anyway
      const response2 = await EmailPassword.signUp('tenant-1', 'user@other.com', testPW);
      expect(response2.status).toBe('EMAIL_ALREADY_EXISTS_ERROR');
      expect((response2 as any).reason.toLowerCase()).toContain('invite only');
    });
  });
});
