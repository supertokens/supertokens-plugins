import debug from "debug";

const getFileLocation = () => {
  let errorObject = new Error();
  if (errorObject.stack === undefined) {
    // should not come here
    return "N/A";
  }
  // split the error stack into an array with new line as the separator
  let errorStack = errorObject.stack.split("\n");

  // find return the first trace which doesnt have the logger.js file
  for (let i = 1; i < errorStack.length; i++) {
    if (!errorStack[i]?.includes("logger.js")) {
      // retrieve the string between the parenthesis
      return errorStack[i]?.match(/(?<=\().+?(?=\))/g);
    }
  }
  return "N/A";
};

export const buildLogger = (
  pluginId: string,
  version: string,
  { fileLocation = true }: { fileLocation?: boolean } = {}
) => {
  const namespace = `com.supertokens.plugin.${pluginId}`;

  function logDebugMessage(message: string) {
    if (debug.enabled(namespace)) {
      debug(namespace)(
        `{t: "${new Date().toISOString()}", message: \"${message}\", file: \"${
          fileLocation ? getFileLocation() : "N/A"
        }\" version: "${version}"}`
      );
      console.log();
    }
  }

  function enableDebugLogs() {
    debug.enable(namespace);
  }

  return {
    logDebugMessage,
    enableDebugLogs,
  };
};
