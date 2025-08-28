import { buildLogger } from '@shared/react';

import { PLUGIN_ID, PLUGIN_VERSION } from './constants';

export const { logDebugMessage, enableDebugLogs } = buildLogger(PLUGIN_ID, PLUGIN_VERSION);
