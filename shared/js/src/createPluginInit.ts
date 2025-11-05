import { OverrideableBuilder } from "supertokens-js-override";

type IfEquals<T, U, Y = unknown, N = never> =
  (<G>() => G extends T ? 1 : 2) extends <G>() => G extends U ? 1 : 2 ? Y : N;

type InitFunction<Config, Implementation, Plugin> = IfEquals<
  Config,
  undefined,
  (config?: { override?: (originalImplementation: Implementation) => Implementation }) => Plugin,
  IfEquals<
    Config,
    Partial<Config>,
    (config?: Config & { override?: (oI: Implementation) => Implementation }) => Plugin,
    (config: Config & { override?: (oI: Implementation) => Implementation }) => Plugin
  >
>;

export type ImplType<O> = { [K in keyof O]: (...args: any[]) => any };
export type OverridableFunctions<A> = {
  [K in keyof A]: A[K] extends Function ? A[K] : never;
};

export const createPluginInitFunction = <
  SupertokensPlugin,
  PluginConfig extends Record<string, any> | undefined,
  PluginImplementation extends ImplType<PluginImplementation> = {},
  NormalisedPublicConfig = PluginConfig,
  PluginContextType = {},
>(
  pluginBuilder: (
    config: NormalisedPublicConfig,
    implementation: PluginImplementation,
    pluginContext: Partial<PluginContextType>,
  ) => SupertokensPlugin,
  getImplementation?:
    | PluginImplementation
    | ((config: NormalisedPublicConfig, pluginContext: Partial<PluginContextType>) => PluginImplementation),
  getNormalisedConfig: (config: PluginConfig, pluginContext: Partial<PluginContextType>) => NormalisedPublicConfig = (
    config,
  ) => config as unknown as NormalisedPublicConfig,
): InitFunction<PluginConfig, OverridableFunctions<PluginImplementation>, SupertokensPlugin> => {
  const getNormalizedImplementation: (
    config: NormalisedPublicConfig,
    pluginContext: Partial<PluginContextType>,
  ) => PluginImplementation =
    typeof getImplementation === "function"
      ? getImplementation
      : () => (getImplementation as PluginImplementation) || {};

  // @ts-ignore
  return (inputConfig: Parameters<InitFunction<PluginConfig, PluginImplementation, SupertokensPlugin>>[0]) => {
    const pluginContext: Partial<PluginContextType> = {};
    const config = getNormalisedConfig((inputConfig || {}) as PluginConfig, pluginContext);
    const baseImplementation = getNormalizedImplementation(config, pluginContext);
    const overrideBuilder = new OverrideableBuilder(baseImplementation);
    if (inputConfig?.override) {
      overrideBuilder.override(inputConfig.override);
    }
    const actualImplementation = overrideBuilder.build();

    return pluginBuilder(config, actualImplementation, pluginContext);
  };
};
