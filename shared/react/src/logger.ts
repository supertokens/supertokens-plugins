export const buildLogger = (pluginId: string, version: string) => {
  let enabled = false;
  const namespace = `com.supertokens.plugin.${pluginId}`;

  function logDebugMessage(message: string) {
    if (enabled) {
      console.log(
        namespace,
        `{t: "${new Date().toISOString()}", message: \"${message}\", version: "${version}"}`
      );
      console.log();
    }
  }

  function enableDebugLogs() {
    enabled = true;
  }

  return {
    logDebugMessage,
    enableDebugLogs,
  };
};
