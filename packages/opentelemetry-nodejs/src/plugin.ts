import { SuperTokensPlugin } from "supertokens-node/types";
import { PLUGIN_ID, PLUGIN_SDK_VERSION, validatePluginConfig } from "./config";
import { OpenTelemetryLoggerPluginConfig } from "./types";
import { Tracer } from "@opentelemetry/api";
import { createPluginInitFunction } from "@shared/js";
import { PluginImpl } from "./pluginImpl";

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  OpenTelemetryLoggerPluginConfig,
  PluginImpl,
  OpenTelemetryLoggerPluginConfig
>(
  (config, implementation): SuperTokensPlugin => {
    const tracer = implementation.getTracer();

    validatePluginConfig(config);
    return {
      id: PLUGIN_ID,
      compatibleSDKVersions: [PLUGIN_SDK_VERSION, "23.0.0", "23.0.1"],
      overrideMap: {
        emailpassword: {
          apis: overrideWithLogger({
            type: "api",
            recipeId: "emailpassword",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
          functions: overrideWithLogger({
            type: "function",
            recipeId: "emailpassword",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
        },
        passwordless: {
          apis: overrideWithLogger({
            type: "api",
            recipeId: "passwordless",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
          functions: overrideWithLogger({
            type: "function",
            recipeId: "passwordless",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
        },
        thirdparty: {
          apis: overrideWithLogger({
            type: "api",
            recipeId: "thirdparty",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
          functions: overrideWithLogger({
            type: "function",
            recipeId: "thirdparty",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
        },
        webauthn: {
          apis: overrideWithLogger({
            type: "api",
            recipeId: "webauthn",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
          functions: overrideWithLogger({
            type: "function",
            recipeId: "webauthn",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
        },
        accountlinking: {
          functions: overrideWithLogger({
            type: "function",
            recipeId: "accountlinking",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
        },
        dashboard: {
          functions: overrideWithLogger({
            type: "function",
            recipeId: "dashboard",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
          apis: overrideWithLogger({
            type: "api",
            recipeId: "dashboard",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
        },
        emailverification: {
          functions: overrideWithLogger({
            type: "function",
            recipeId: "dashboard",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
          apis: overrideWithLogger({
            type: "api",
            recipeId: "dashboard",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
        },
        multifactorauth: {
          functions: overrideWithLogger({
            type: "function",
            recipeId: "multifactorauth",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
          apis: overrideWithLogger({
            type: "api",
            recipeId: "multifactorauth",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
        },
        multitenancy: {
          functions: overrideWithLogger({
            type: "function",
            recipeId: "multitenancy",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
          apis: overrideWithLogger({
            type: "api",
            recipeId: "multitenancy",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
        },
        oauth2provider: {
          functions: overrideWithLogger({
            type: "function",
            recipeId: "oauth2provider",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
          apis: overrideWithLogger({
            type: "api",
            recipeId: "oauth2provider",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
        },
        session: {
          functions: overrideWithLogger({
            type: "function",
            recipeId: "session",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
          apis: overrideWithLogger({
            type: "api",
            recipeId: "session",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
        },
        totp: {
          functions: overrideWithLogger({
            type: "function",
            recipeId: "totp",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
          apis: overrideWithLogger({
            type: "api",
            recipeId: "totp",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
        },
        usermetadata: {
          functions: overrideWithLogger({
            type: "function",
            recipeId: "usermetadata",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
          apis: overrideWithLogger({
            type: "api",
            recipeId: "usermetadata",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
        },
        userroles: {
          functions: overrideWithLogger({
            type: "function",
            recipeId: "userroles",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
          apis: overrideWithLogger({
            type: "api",
            recipeId: "userroles",
            pluginConfig: config,
            tracer,
            pluginImpl: implementation,
          }),
        },
      },
    };
  },
  (config) => new PluginImpl(config),
  (config: OpenTelemetryLoggerPluginConfig | undefined) => config ?? {}
);

function overrideWithLogger<T extends Record<string, undefined |((...args: any[]) => any)>>(logConfig: {
  type: "api" | "function";
  recipeId: string;
  pluginConfig: OpenTelemetryLoggerPluginConfig;
  tracer: Tracer;
  pluginImpl: PluginImpl;
}): (originalImplementation: T) => T {
  return (originalImplementation: T) => {
    const keys = Object.keys(originalImplementation);
    const newImplementation = keys.reduce((acc, key: keyof T) => {
      const originalFunc = originalImplementation[key];
      if (!originalFunc) {
        return acc;
      }
      return {
        ...acc,
        [key]: fnWithLoggerAsync(originalFunc.bind(originalImplementation), { ...logConfig, key: key as string }),
      };
    }, {} as T);
    return newImplementation;
  };
}

function fnWithLoggerAsync<T extends(...args: any[]) => Promise<any>>(
  fn: T,
  logConfig: {
    type: "api" | "function";
    recipeId: string;
    key: string;
    pluginConfig: OpenTelemetryLoggerPluginConfig;
    tracer: Tracer;
    pluginImpl: PluginImpl;
  }
): T {
  return function (...args: Parameters<T>): Promise<ReturnType<T>> {
    return logConfig.pluginImpl.startActiveSpan(
      logConfig.tracer,
      `${logConfig.recipeId}.${logConfig.type}.${logConfig.key}`,
      {
        attributes: {
          recipeId: logConfig.recipeId,
          type: logConfig.type,
          key: logConfig.key,
        },
      },
      async function (span) {
        const inputAttributes = logConfig.pluginImpl.transformInputToAttributes(args[0]);
        span.setAttributes(inputAttributes);

        try {
          const result = await fn(...args);
          const resultAttributes = logConfig.pluginImpl.transformResultToAttributes(result);
          span.setAttributes(resultAttributes);
          return result;
        } catch (error) {
          const errorAttributes = logConfig.pluginImpl.transformErrorToAttributes(error);
          span.setAttributes(errorAttributes);
          throw error;
        } finally {
          span.end();
        }
      }
    );
  } as T;
}
