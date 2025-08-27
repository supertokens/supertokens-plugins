import { PLUGIN_ID } from './config';
import { PluginConfig, TenantList } from './types';

export let usePlugin: () => {
  config: PluginConfig;
  isLoading: boolean;
  fetchTenants: () => Promise<({ status: 'OK' } & TenantList) | { status: 'ERROR'; message: string }>;
} = () => {
  throw new Error(`${PLUGIN_ID} plugin not initialized`);
};

export const updateUsePlugin = (newUsePlugin: typeof usePlugin) => {
  usePlugin = newUsePlugin;
};
