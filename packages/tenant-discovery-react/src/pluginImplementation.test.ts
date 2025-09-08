import { describe, it, expect, beforeEach, vi } from 'vitest';
import SuperTokens from 'supertokens-auth-react';
import Session from 'supertokens-auth-react/recipe/session';
import { getOverrideableTenantFunctionImplementation } from './pluginImplementation';
import { SuperTokensPluginTenantDiscoveryPluginConfig } from './types';

// Mock SuperTokens modules
vi.mock('supertokens-auth-react', () => ({
  default: {
    init: vi.fn(),
  },
}));

vi.mock('supertokens-auth-react/recipe/session', () => ({
  default: {
    init: vi.fn(() => ({})),
    doesSessionExist: vi.fn(),
  },
}));

describe('recipeImplementation', () => {
  let config: SuperTokensPluginTenantDiscoveryPluginConfig;
  let implementation: ReturnType<typeof getOverrideableTenantFunctionImplementation>;

  beforeEach(() => {
    // Initialize SuperTokens before each test
    SuperTokens.init({
      appInfo: {
        appName: 'Test App',
        apiDomain: 'https://api.test.com',
        websiteDomain: 'https://test.com',
      },
      recipeList: [Session.init()],
    });

    config = {
      extractTenantIdFromDomain: true,
    };
    implementation = getOverrideableTenantFunctionImplementation(config);

    // Mock Session.doesSessionExist to return false by default (user not logged in)
    vi.mocked(Session.doesSessionExist).mockResolvedValue(false);
  });

  describe('determineTenantFromURL', () => {
    it('should return undefined when user has active session', async () => {
      vi.mocked(Session.doesSessionExist).mockResolvedValue(true);

      const result = await implementation.determineTenantFromURL();

      expect(result).toBeUndefined();
    });

    it('should return existing tenantId from URL search params', async () => {
      window.location.href = 'https://example.com?tenantId=existing-tenant';
      window.location.search = '?tenantId=existing-tenant';

      const result = await implementation.determineTenantFromURL();

      expect(result).toBe('existing-tenant');
    });

    it('should determine tenant from subdomain when extractTenantIdFromDomain is true', async () => {
      window.location.href = 'https://tenant1.example.com';
      window.location.hostname = 'tenant1.example.com';
      window.location.search = '';

      const result = await implementation.determineTenantFromURL();

      expect(result).toBe('tenant1');
    });

    it('should return undefined when extractTenantIdFromDomain is false', async () => {
      config.extractTenantIdFromDomain = false;
      implementation = getOverrideableTenantFunctionImplementation(config);

      window.location.href = 'https://tenant1.example.com';
      window.location.hostname = 'tenant1.example.com';
      window.location.search = '';

      const result = await implementation.determineTenantFromURL();

      expect(result).toBeUndefined();
    });

    it('should return undefined when no subdomain exists', async () => {
      window.location.href = 'https://example.com';
      window.location.hostname = 'example.com';
      window.location.search = '';

      const result = await implementation.determineTenantFromURL();

      expect(result).toBeUndefined();
    });
  });

  describe('determineTenantFromSubdomain', () => {
    it('should extract tenant from subdomain', async () => {
      window.location.href = 'https://tenant1.example.com';
      window.location.hostname = 'tenant1.example.com';

      const result = await implementation.determineTenantFromSubdomain();

      expect(result).toBe('tenant1');
    });

    it('should handle multiple subdomains', async () => {
      window.location.href = 'https://sub.tenant1.example.com';
      window.location.hostname = 'sub.tenant1.example.com';

      const result = await implementation.determineTenantFromSubdomain();

      expect(result).toBe('sub');
    });

    it('should return undefined when no subdomain', async () => {
      window.location.hostname = 'example.com';

      const result = await implementation.determineTenantFromSubdomain();

      expect(result).toBeUndefined();
    });

    it('should return undefined when extractTenantIdFromDomain is disabled', async () => {
      config.extractTenantIdFromDomain = false;
      implementation = getOverrideableTenantFunctionImplementation(config);
      window.location.hostname = 'tenant1.example.com';

      const result = await implementation.determineTenantFromSubdomain();

      expect(result).toBeUndefined();
    });
  });
});
