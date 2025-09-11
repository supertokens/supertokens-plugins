import UserMetadata from "supertokens-node/recipe/usermetadata";

export const getPluginUserMetadata = async <T extends any>(
  metadataPluginKey: string,
  userId: string,
  userContext?: Record<string, any>,
): Promise<T> => {
  const result = await UserMetadata.getUserMetadata(userId, userContext);
  if (result.status !== "OK") {
    throw new Error("Could not get user metadata");
  }

  return result.metadata[metadataPluginKey];
};

export const setPluginUserMetadata = async <T extends any>(
  metadataPluginKey: string,
  userId: string,
  metadata: T,
  userContext?: Record<string, any>,
) => {
  const result = await UserMetadata.getUserMetadata(userId, userContext);
  if (result.status !== "OK") {
    throw new Error("Could not get user metadata");
  }

  await UserMetadata.updateUserMetadata(
    userId,
    {
      ...result.metadata,
      [metadataPluginKey]: metadata,
    },
    userContext,
  );
};

export const pluginUserMetadata = <T extends any>(
  metadataKey: string,
): {
  get: (userId: string, userContext?: Record<string, any>) => Promise<T>;
  set: (userId: string, metadata: T, userContext?: Record<string, any>) => Promise<void>;
} => {
  return {
    get: async (userId, userContext) => getPluginUserMetadata<T>(metadataKey, userId, userContext),
    set: async (userId, metadata, userContext) => setPluginUserMetadata<T>(metadataKey, userId, metadata, userContext),
  };
};
