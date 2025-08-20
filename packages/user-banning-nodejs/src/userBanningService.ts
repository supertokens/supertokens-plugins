import { UserContext } from 'supertokens-node/types';
import UserMetadata from 'supertokens-node/recipe/usermetadata';
import { USER_METADATA_BAN_STATUS_KEY } from './config';

export class UserBanningService {
  protected cache: Map<string, boolean> = new Map();

  constructor() {}

  async getBanStatus(
    userId: string,
    userContext?: UserContext,
  ): Promise<{ status: 'OK'; banned: boolean | undefined }> {
    const result = await UserMetadata.getUserMetadata(userId, userContext);

    this.setBanStatusToCache(userId, result.metadata[USER_METADATA_BAN_STATUS_KEY]);

    return {
      status: 'OK',
      banned: result.metadata[USER_METADATA_BAN_STATUS_KEY] ?? false,
    };
  }

  async setBanStatus(userId: string, isBanned: boolean, userContext?: UserContext): Promise<{ status: 'OK' }> {
    await UserMetadata.updateUserMetadata(userId, { [USER_METADATA_BAN_STATUS_KEY]: !!isBanned }, userContext);

    this.setBanStatusToCache(userId, !!isBanned);

    return { status: 'OK' };
  }

  setBanStatusToCache(userId: string, isBanned: boolean): void {
    this.cache.set(userId, isBanned);
  }

  getBanStatusFromCache(userId: string): boolean | undefined {
    return this.cache.get(userId);
  }
}
