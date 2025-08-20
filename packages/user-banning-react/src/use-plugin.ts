import { PluginContext } from './plugin';
import { useContext } from 'react';

export const usePlugin = () => {
  return useContext(PluginContext);
};
