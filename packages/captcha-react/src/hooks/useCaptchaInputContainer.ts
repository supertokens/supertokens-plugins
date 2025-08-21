import { useMemo } from "react";

import { CaptchaInputContainer } from "../components/CaptchaInputContainer";
import { getPluginConfig } from "../config";

export function useCaptchaInputContainer() {
  return useMemo(() => {
    const config = getPluginConfig();
    if (config.InputContainer) {
      return config.InputContainer;
    }
    return CaptchaInputContainer;
  }, []);
}
