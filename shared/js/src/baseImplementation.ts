/**
 * Abstract base class for all SuperTokens plugin services that follow the singleton pattern.
 * This ensures consistent initialization and instance management across all plugins.
 *
 * @template TConfig - The configuration type for the plugin
 */
export abstract class BasePluginImplementation<TConfig> {
  /**
   * The singleton instance of the service. Should be undefined until init() is called.
   * This will be set by the init() method.
   */
  protected static instance: any;

  /**
   * Initialize the plugin service with the provided configuration.
   * Creates and stores the singleton instance if not already initialized.
   * @param config - The plugin configuration
   * @param ServiceClass - The service class constructor (passed automatically when called on subclass)
   * @returns The singleton instance
   */
  public static init<T extends BasePluginImplementation<any>>(this: new (config: any) => T, config: any): T {
    // Use the constructor reference to get the class
    const ServiceClass = this as any;

    if (ServiceClass.instance) {
      return ServiceClass.instance;
    }

    ServiceClass.instance = new ServiceClass(config);
    return ServiceClass.instance;
  }

  /**
   * Get the initialized instance or throw an error if not initialized.
   * @throws Error if the instance has not been initialized
   * @returns The singleton instance
   */
  public static getInstanceOrThrow<T extends BasePluginImplementation<any>>(this: new (...args: any[]) => T): T {
    const ServiceClass = this as any;

    if (!ServiceClass.instance) {
      throw new Error(`${ServiceClass.name} instance not found. Make sure you have initialized the plugin.`);
    }

    return ServiceClass.instance;
  }

  /**
   * Constructor that takes the plugin configuration.
   * @param config - The plugin configuration
   */
  constructor(protected config: TConfig) {}
}
