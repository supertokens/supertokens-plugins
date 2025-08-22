import { useContext } from "react";

import { PluginContext } from "./plugin";

export const usePlugin = () => {
  return useContext(PluginContext);
};
