import '@testing-library/jest-dom';
import { vi } from 'vitest';

Object.defineProperty(window, 'grecaptcha', {
  writable: true,
  value: {
    ready: vi.fn(),
    render: vi.fn(),
    execute: vi.fn(),
    reset: vi.fn(),
  },
});

Object.defineProperty(window, 'turnstile', {
  writable: true,
  value: {
    render: vi.fn(),
    reset: vi.fn(),
    remove: vi.fn(),
  },
});

Object.defineProperty(window, 'onLoadReCAPTCHAv2', {
  writable: true,
  value: vi.fn(),
});

Object.defineProperty(window, 'onLoadTurnstile', {
  writable: true,
  value: vi.fn(),
});

global.fetch = vi.fn();

afterEach(() => {
  vi.clearAllMocks();
});

