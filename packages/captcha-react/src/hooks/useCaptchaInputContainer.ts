import { useMemo } from "react";
import { getPluginConfig } from "../config";
import { CaptchaInputContainer } from "../components/CaptchaInputContainer";

export function useCaptchaInputContainer() {
  return useMemo(() => {
    const config = getPluginConfig();
    if (config.InputContainer) {
      return config.InputContainer;
    }
    return CaptchaInputContainer;
  }, []);
}
