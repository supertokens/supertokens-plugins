import { PLUGIN_ID } from './config';
import { init } from './plugin';
import { usePlugin } from './use-plugin';

export { init, usePlugin };

export { PLUGIN_ID };
export default { PLUGIN_ID, init, usePlugin };

export type { PluginConfig } from './types';
export { SelectTenantPage } from './select-tenant-page';
