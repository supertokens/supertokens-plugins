import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Captcha, ReCAPTCHAv2Provider, ReCAPTCHAv3Provider, TurnstileProvider } from "./captcha";
import { CAPTCHA_INPUT_CONTAINER_ID } from "./constants";
import { SuperTokensPluginCaptchaConfig } from "./types";

describe("Captcha", () => {
  let captcha: Captcha;

  beforeEach(() => {
    captcha = new Captcha();
    document.body.innerHTML = "";
    const container = document.createElement("div");
    container.id = CAPTCHA_INPUT_CONTAINER_ID;
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("init", () => {
    it("should initialize turnstile provider", () => {
      const config = {
        type: "turnstile" as const,
        captcha: { sitekey: "test-sitekey" },
      };

      captcha.init(config);

      expect(captcha.state).toBe("initialised");
      expect(captcha["provider"]).toBeInstanceOf(TurnstileProvider);
      expect(captcha["config"]).toEqual(config);
    });

    it("should initialize reCAPTCHAv2 provider", () => {
      const config = {
        type: "reCAPTCHAv2" as const,
        captcha: { sitekey: "test-sitekey" },
      };

      captcha.init(config);

      expect(captcha.state).toBe("initialised");
      expect(captcha["provider"]).toBeInstanceOf(ReCAPTCHAv2Provider);
      expect(captcha["config"]).toEqual(config);
    });

    it("should initialize reCAPTCHAv3 provider", () => {
      const config = {
        type: "reCAPTCHAv3" as const,
        captcha: { sitekey: "test-sitekey" },
      };

      captcha.init(config);

      expect(captcha.state).toBe("initialised");
      expect(captcha["provider"]).toBeInstanceOf(ReCAPTCHAv3Provider);
      expect(captcha["config"]).toEqual(config);
    });

    it("should throw error for unsupported captcha type", () => {
      const config: SuperTokensPluginCaptchaConfig = {
        // @ts-expect-error Testing invalid type
        type: "unsupported",
        captcha: { sitekey: "test-sitekey" },
      };

      expect(() => captcha.init(config)).toThrow("Unsupported CAPTCHA type");
    });

    it("should skip initialization if already initialised", () => {
      const config = {
        type: "turnstile" as const,
        captcha: { sitekey: "test-sitekey" },
      };

      captcha.init(config);
      const originalProvider = captcha["provider"];

      captcha.init({ ...config, type: "reCAPTCHAv3" });
      expect(captcha["provider"]).toBe(originalProvider);
    });

    it("should update inputContainerId even if already initialised", () => {
      const initialConfig = {
        type: "turnstile" as const,
        captcha: { sitekey: "test-sitekey" },
        inputContainerId: "initial-id",
      };

      captcha.init(initialConfig);

      const updatedConfig = {
        type: "turnstile" as const,
        captcha: { sitekey: "test-sitekey" },
        inputContainerId: "updated-id",
      };

      captcha.init(updatedConfig);

      expect(captcha["config"]?.inputContainerId).toBe("updated-id");
    });
  });

  describe("getInputContainer", () => {
    beforeEach(() => {
      captcha.init({
        type: "turnstile" as const,
        captcha: { sitekey: "test-sitekey" },
      });
    });

    it("should return default container element", async () => {
      const container = await captcha.getInputContainer();
      expect(container.id).toBe(CAPTCHA_INPUT_CONTAINER_ID);
    });

    it("should return custom container element", async () => {
      const customId = "custom-container";
      const customContainer = document.createElement("div");
      customContainer.id = customId;
      document.body.appendChild(customContainer);

      captcha["config"]!.inputContainerId = customId;

      const container = await captcha.getInputContainer();
      expect(container.id).toBe(customId);
    });

    it("should handle function-based container ID", async () => {
      const customId = "dynamic-container";
      const customContainer = document.createElement("div");
      customContainer.id = customId;
      document.body.appendChild(customContainer);

      captcha["config"]!.inputContainerId = () => Promise.resolve(customId);

      const container = await captcha.getInputContainer();
      expect(container.id).toBe(customId);
    });

    it("should throw error if container not found", async () => {
      captcha["config"]!.inputContainerId = "non-existent";

      await expect(captcha.getInputContainer()).rejects.toThrow("Captcha input container element not found");
    });

    it("should throw error if config not initialized", async () => {
      captcha["config"] = null;

      await expect(captcha.getInputContainer()).rejects.toThrow("Captcha config is not initialised");
    });
  });

  describe("load", () => {
    it("should throw error if not initialized", async () => {
      await expect(captcha.load()).rejects.toThrow("Captcha has not been initialised");
    });

    it("should throw error if provider not initialized", async () => {
      captcha["state"] = "initialised";

      await expect(captcha.load()).rejects.toThrow("Captcha provider is not initialised");
    });

    it("should throw error if config not initialized", async () => {
      captcha["state"] = "initialised";
      captcha["provider"] = {} as any;

      await expect(captcha.load()).rejects.toThrow("Captcha config is not initialised");
    });

    it("should load provider successfully", async () => {
      const mockProvider = {
        load: vi.fn().mockResolvedValue(undefined),
      };

      captcha.init({
        type: "turnstile" as const,
        captcha: { sitekey: "test-sitekey" },
      });
      captcha["provider"] = mockProvider as any;

      await captcha.load();

      expect(mockProvider.load).toHaveBeenCalled();
      expect(captcha.state).toBe("loaded");
    });

    it("should skip loading if already loaded", async () => {
      const mockProvider = {
        load: vi.fn().mockResolvedValue(undefined),
      };

      captcha.init({
        type: "turnstile" as const,
        captcha: { sitekey: "test-sitekey" },
      });
      captcha["provider"] = mockProvider as any;
      captcha["state"] = "loaded";

      await captcha.load();

      expect(mockProvider.load).not.toHaveBeenCalled();
    });

    it("should handle load errors", async () => {
      const error = new Error("Load failed");
      const mockProvider = {
        load: vi.fn().mockRejectedValue(error),
      };

      captcha.init({
        type: "turnstile" as const,
        captcha: { sitekey: "test-sitekey" },
      });
      captcha["provider"] = mockProvider as any;

      await expect(captcha.load()).rejects.toThrow("Load failed");
    });
  });

  describe("render", () => {
    beforeEach(() => {
      captcha.init({
        type: "turnstile" as const,
        captcha: { sitekey: "test-sitekey" },
      });
    });

    it("should throw error if provider not initialized", async () => {
      captcha["provider"] = null;

      await expect(captcha.render()).rejects.toThrow("Captcha provider is not initialised");
    });

    it("should skip rendering if provider does not support it", async () => {
      const mockProvider = {};
      captcha["provider"] = mockProvider as any;

      await captcha.render();
      expect(captcha.state).toBe("initialised");
    });

    it("should throw error if config not initialized", async () => {
      const mockProvider = { render: vi.fn() };
      captcha["provider"] = mockProvider as any;
      captcha["config"] = null;

      await expect(captcha.render()).rejects.toThrow("Captcha config is not initialised");
    });

    it("should render provider successfully", async () => {
      const mockProvider = {
        render: vi.fn(),
      };
      captcha["provider"] = mockProvider as any;

      await captcha.render();
      expect(mockProvider.render).toHaveBeenCalled();
      expect(captcha.state).toBe("rendered");
    });

    it("should call onSubmit callback when token is submitted", async () => {
      const onSubmit = vi.fn();
      const mockProvider = {
        render: vi.fn((container, submitCallback) => {
          submitCallback("test-token");
        }),
      };
      captcha["provider"] = mockProvider as any;

      await captcha.render(onSubmit);

      expect(onSubmit).toHaveBeenCalledWith("test-token");
    });

    it("should call onError callback when error occurs", async () => {
      const onError = vi.fn();
      const error = new Error("Render failed");
      const mockProvider = {
        render: vi.fn((container, submitCallback, errorCallback) => {
          errorCallback(error);
        }),
      };
      captcha["provider"] = mockProvider as any;

      await captcha.render(undefined, onError);

      expect(onError).toHaveBeenCalledWith(error);
    });
  });

  describe("getToken", () => {
    beforeEach(() => {
      captcha.init({
        type: "turnstile" as const,
        captcha: { sitekey: "test-sitekey" },
      });
    });

    it("should return empty string if not initialized", async () => {
      captcha["state"] = "uninitialised";

      const token = await captcha.getToken();

      expect(token).toBe("");
    });

    it("should throw error for invalid state", async () => {
      captcha["state"] = "initialised";

      await expect(captcha.getToken()).rejects.toThrow("Invalid captcha state: initialised");
    });

    it("should throw error if provider not initialized", async () => {
      captcha["state"] = "loaded";
      captcha["provider"] = null;

      await expect(captcha.getToken()).rejects.toThrow("Captcha provider is not initialised");
    });

    it("should throw error if config not initialized", async () => {
      captcha["state"] = "loaded";
      captcha["provider"] = {} as any;
      captcha["config"] = null;

      await expect(captcha.getToken()).rejects.toThrow("Captcha config is not initialised");
    });

    it("should get token from rendered provider", async () => {
      const mockProvider = {
        getToken: vi.fn().mockResolvedValue("test-token"),
      };
      captcha["provider"] = mockProvider as any;
      captcha["state"] = "rendered";

      const token = await captcha.getToken();

      expect(token).toBe("test-token");
      expect(mockProvider.getToken).toHaveBeenCalled();
    });

    it("should render first if not rendered and provider supports rendering", async () => {
      const mockProvider = {
        render: vi.fn((container, onSubmit) => {
          onSubmit("test-token");
        }),
        getToken: vi.fn().mockResolvedValue("test-token"),
      };
      captcha["provider"] = mockProvider as any;
      captcha["state"] = "loaded";

      const token = await captcha.getToken();

      expect(token).toBe("test-token");
      expect(mockProvider.render).toHaveBeenCalled();
    });

    it("should handle getToken errors", async () => {
      const error = new Error("Get token failed");
      const mockProvider = {
        getToken: vi.fn().mockRejectedValue(error),
      };
      captcha["provider"] = mockProvider as any;
      captcha["state"] = "rendered";

      await expect(captcha.getToken()).rejects.toThrow("Get token failed");
    });
  });

  describe("event system", () => {
    beforeEach(() => {
      captcha.init({
        type: "turnstile" as const,
        captcha: { sitekey: "test-sitekey" },
      });
    });

    it("should add and remove event listeners", () => {
      const listener = vi.fn();

      captcha.addEventListener("token-submitted", listener);
      captcha["emit"]({ name: "token-submitted", payload: "test-token" });

      expect(listener).toHaveBeenCalledWith("test-token");

      captcha.removeEventListener("token-submitted", listener);
      captcha["emit"]({ name: "token-submitted", payload: "test-token-2" });

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("should emit render-failed events", () => {
      const listener = vi.fn();
      const error = new Error("Render failed");

      captcha.addEventListener("render-failed", listener);
      captcha["emit"]({ name: "render-failed", payload: error });

      expect(listener).toHaveBeenCalledWith(error);
    });

    it("should emit get-token-failed events", () => {
      const listener = vi.fn();
      const error = new Error("Get token failed");

      captcha.addEventListener("get-token-failed", listener);
      captcha["emit"]({ name: "get-token-failed", payload: error });

      expect(listener).toHaveBeenCalledWith(error);
    });

    it("should handle listener errors gracefully", () => {
      const listener = vi.fn().mockImplementation(() => {
        throw new Error("Listener error");
      });

      captcha.addEventListener("token-submitted", listener);

      expect(() => {
        captcha["emit"]({ name: "token-submitted", payload: "test-token" });
      }).not.toThrow();

      expect(listener).toHaveBeenCalled();
    });
  });
});
