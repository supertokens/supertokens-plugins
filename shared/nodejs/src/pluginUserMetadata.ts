import UserMetadata from "supertokens-node/recipe/usermetadata";

export const getPluginUserMetadata = async <T extends any>(metadataPluginKey: string, userId: string): Promise<T> => {
  const result = await UserMetadata.getUserMetadata(userId);
  if (result.status !== "OK") {
    throw new Error("Could not get user metadata");
  }

  return result.metadata[metadataPluginKey];
};

export const setPluginUserMetadata = async <T extends any>(metadataPluginKey: string, userId: string, metadata: T) => {
  const result = await UserMetadata.getUserMetadata(userId);
  if (result.status !== "OK") {
    throw new Error("Could not get user metadata");
  }

  await UserMetadata.updateUserMetadata(userId, {
    ...result.metadata,
    [metadataPluginKey]: metadata,
  });
};

export const pluginUserMetadata = <T extends any>(
  metadataKey: string,
): {
  get: (userId: string) => Promise<T>;
  set: (userId: string, metadata: T) => Promise<void>;
} => {
  return {
    get: async <T>(userId: string) => getPluginUserMetadata<T>(metadataKey, userId),
    set: async <T>(userId: string, metadata: T) => setPluginUserMetadata<T>(metadataKey, userId, metadata),
  };
};
