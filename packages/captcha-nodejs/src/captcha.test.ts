import { validateCaptcha } from './captcha';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SuperTokensPluginCaptchaConfig } from './types';

describe('captcha', () => {
  describe('validateCaptcha', () => {
    const config: SuperTokensPluginCaptchaConfig = {
      type: 'reCAPTCHAv3',
      captcha: {
        secretKey: 'test-secret-key',
      },
    };
    beforeEach(() => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      } as Response);
    });

    it('should validate reCAPTCHAv3 token successfully', async () => {
      const body = {
        captcha: 'valid-token',
        captchaType: 'reCAPTCHAv3',
      };

      await expect(validateCaptcha(body, config)).resolves.toBeUndefined();
    });

    it('should throw error if captcha token is missing', async () => {
      const body = {};

      await expect(validateCaptcha(body, config)).rejects.toThrow(
        "The 'captcha' field is required"
      );
    });

    it('should throw error if captcha type is missing', async () => {
      const body = {
        captcha: 'valid-token',
      };

      await expect(validateCaptcha(body, config)).rejects.toThrow(
        "The 'captchaType' field is required"
      );
    });

    it('should throw error if captcha type does not match config', async () => {
      const body = {
        captcha: 'valid-token',
        captchaType: 'reCAPTCHAv2',
      };

      await expect(validateCaptcha(body, config)).rejects.toThrow(
        'Invalid captcha type'
      );
    });

    it('should handle failed reCAPTCHA verification', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: false }),
      } as Response);

      const body = {
        captcha: 'invalid-token',
        captchaType: 'reCAPTCHAv3',
      };

      await expect(validateCaptcha(body, config)).rejects.toThrow(
        'CAPTCHA verification failed'
      );
    });
  });
});
