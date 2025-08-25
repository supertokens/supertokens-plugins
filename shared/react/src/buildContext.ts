import React, { createContext, useContext } from "react";

export const buildContext = <T>() => {
  let context: React.Context<T> | undefined;

  return {
    usePluginContext: () => {
      if (!context) {
        throw new Error("Context not set");
      }

      return useContext(context);
    },
    setContext: (value: T) => {
      context = createContext(value);
    },
  };
};
