import { OverrideableBuilder } from 'supertokens-js-override';

type IfEquals<T, U, Y = unknown, N = never> = (<G>() => G extends T
  ? 1
  : 2) extends <G>() => G extends U ? 1 : 2
  ? Y
  : N;

type InitFunction<Config, Implementation, Plugin> = IfEquals<
  Config,
  undefined,
  (config?: {
    override?: (originalImplementation: Implementation) => Implementation;
  }) => Plugin,
  IfEquals<
    Config,
    Partial<Config>,
    (
      config?: Config & { override?: (oI: Implementation) => Implementation }
    ) => Plugin,
    (
      config: Config & { override?: (oI: Implementation) => Implementation }
    ) => Plugin
  >
>;

export const createPluginInitFunction = <
  SupertokensPlugin,
  PluginConfig extends Record<string, any> | undefined,
  PluginImplementation extends Record<string, (...args: any[]) => any> = {},
  NormalisedPublicConfig = PluginConfig
>(
  init: (
    config: NormalisedPublicConfig,
    implementation: PluginImplementation
  ) => SupertokensPlugin,
  getImplementation?:
    | PluginImplementation
    | ((config: NormalisedPublicConfig) => PluginImplementation),
  getNormalisedConfig: (config: PluginConfig) => NormalisedPublicConfig = (
    config
  ) => (config as unknown) as NormalisedPublicConfig
): InitFunction<PluginConfig, PluginImplementation, SupertokensPlugin> => {
  const getNormalizedImplementation: (
    config: NormalisedPublicConfig
  ) => PluginImplementation =
    typeof getImplementation === 'function'
      ? getImplementation
      : (_config: NormalisedPublicConfig) =>
          (getImplementation as PluginImplementation) || {};

  return (
    inputConfig: Parameters<
      InitFunction<PluginConfig, PluginImplementation, SupertokensPlugin>
    >[0]
  ) => {
    const config = getNormalisedConfig((inputConfig || {}) as PluginConfig);
    const baseImplementation = getNormalizedImplementation(config);
    const overrideBuilder = new OverrideableBuilder(baseImplementation);
    if (inputConfig?.override) {
      overrideBuilder.override(inputConfig.override);
    }
    const actualImplementation = overrideBuilder.build();

    return init(config, actualImplementation);
  };
};
