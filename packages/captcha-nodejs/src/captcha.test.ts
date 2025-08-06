import { validateCaptcha } from './captcha';
import { setPluginConfig } from './config';
import { vi } from 'vitest';

describe('captcha', () => {
  describe('validateCaptcha', () => {
    beforeEach(() => {
      setPluginConfig({
        type: 'reCAPTCHAv3',
        captcha: {
          secretKey: 'test-secret-key',
        },
      });

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

      await expect(validateCaptcha(body)).resolves.toBeUndefined();
    });

    it('should throw error if captcha token is missing', async () => {
      const body = {};

      await expect(validateCaptcha(body)).rejects.toThrow(
        "The 'captcha' field is required"
      );
    });

    it('should throw error if captcha type is missing', async () => {
      const body = {
        captcha: 'valid-token',
      };

      await expect(validateCaptcha(body)).rejects.toThrow(
        "The 'captchaType' field is required"
      );
    });

    it('should throw error if captcha type does not match config', async () => {
      const body = {
        captcha: 'valid-token',
        captchaType: 'reCAPTCHAv2',
      };

      await expect(validateCaptcha(body)).rejects.toThrow(
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

      await expect(validateCaptcha(body)).rejects.toThrow(
        'CAPTCHA verification failed'
      );
    });
  });
});
