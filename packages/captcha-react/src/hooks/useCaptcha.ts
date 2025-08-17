import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Captcha, captcha } from '../captcha';
import { getPluginConfig } from '../config';
import { CAPTCHA_INPUT_CONTAINER_ID } from '../constants';
import { SuperTokensPluginCaptchaConfig } from '../types';

export function useCaptcha(onError?: (error: string) => void) {
  const captchaInputContainerId = useMemo(() => {
    const config = getPluginConfig();
    return config.inputContainerId || CAPTCHA_INPUT_CONTAINER_ID;
  }, []);

  const captchaState = useSyncExternalStore(
    captchaStore.subscribe,
    captchaStore.getSnapshot,
    () => DefaultCaptchaState,
  );

  const { error } = captchaState;
  useEffect(() => {
    if (error && onError) {
      onError(error);
    }
  }, [error, onError]);

  return {
    state: captchaState,
    load: captchaStore.load,
    render: captchaStore.render,
    containerId: captchaInputContainerId,
  };
}

type CaptchaState = {
  error: string | undefined;
  token: string | undefined;
  isLoading: boolean;
  isRendering: boolean;
};

const DefaultCaptchaState: CaptchaState = {
  error: undefined,
  token: undefined,
  isLoading: false,
  isRendering: false,
};

// Store used to connect the `Captcha` logic to a React UI component.
// It servers serveral purposes:
// - Wraps calls in try-catch blocks and saves the error states
// - Exposes a state property that can be referenced in the UI
// - Prevents multiple/redundant calls to the `Captcha` logic
class CaptchaStore {
  private listeners: Set<() => void>;
  public state: CaptchaState;
  public captcha: Captcha;

  constructor() {
    this.state = DefaultCaptchaState;
    this.captcha = captcha;
    this.listeners = new Set();
    this.captcha.addEventListener('token-submitted', (token) => {
      this.state = {
        ...this.state,
        error: undefined,
        token,
      };
      this.notifyListeners();
    });
    this.captcha.addEventListener('render-failed', (error) => {
      this.state = {
        ...this.state,
        error: getErrorMessage(error),
      };
      this.notifyListeners();
    });
    this.captcha.addEventListener('get-token-failed', (error) => {
      this.state = {
        ...this.state,
        error: getErrorMessage(error),
      };
      this.notifyListeners();
    });
  }

  getSnapshot = () => {
    return this.state;
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  load = async (
    configOverride: Partial<SuperTokensPluginCaptchaConfig> = {},
  ) => {
    if (this.state.isLoading || this.state.isRendering) {
      return;
    }

    try {
      const config = getPluginConfig();
      this.captcha.init({
        ...config,
        ...configOverride,
      } as SuperTokensPluginCaptchaConfig);
      this.state = { ...this.state, isLoading: true };
      this.notifyListeners();
      await this.captcha.load();
      this.state = { ...this.state, isLoading: false, error: undefined };
      this.notifyListeners();
    } catch (err) {
      this.state = {
        ...this.state,
        error: getErrorMessage(err),
      };
      this.notifyListeners();
    }
    return true;
  };

  render = async () => {
    if (this.state.isRendering || this.state.isLoading) {
      return;
    }

    try {
      this.state = { ...this.state, isRendering: true };
      this.notifyListeners();
      const onSubmit = (token: string) => {
        this.state = {
          ...this.state,
          isRendering: false,
          error: undefined,
          token,
        };
        this.notifyListeners();
      };
      const onError = (error: Error) => {
        this.state = {
          ...this.state,
          error: getErrorMessage(error),
        };
        this.notifyListeners();
      };
      this.captcha.render(onSubmit, onError);
    } catch (err) {
      this.state = {
        ...this.state,
        error: getErrorMessage(err),
      };
      this.notifyListeners();
    }
  };

  private notifyListeners() {
    this.listeners.forEach((listener) => listener());
  }
}

const captchaStore = new CaptchaStore();

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }

  return String(error);
}
