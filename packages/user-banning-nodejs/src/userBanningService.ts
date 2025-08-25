import { UserContext } from "supertokens-node/types";
import {
  addRoleToUser,
  removeUserRole,
  getRolesForUser,
  getAllRoles,
  createNewRoleOrAddPermissions,
  UserRoleClaim,
  getUsersThatHaveRole,
} from "supertokens-node/recipe/userroles";
import { SuperTokensPluginUserBanningPluginNormalisedConfig } from "./types";
import Session from "supertokens-node/recipe/session";
import { getUser } from "supertokens-node";
import { listAllTenants } from "supertokens-node/recipe/multitenancy";
import { PLUGIN_ID } from "./constants";

export class UserBanningService {
  protected cache: Map<string, boolean> = new Map();
  protected cachePreLoadPromise: Promise<void> | undefined = undefined;

  constructor(protected pluginConfig: SuperTokensPluginUserBanningPluginNormalisedConfig) {}

  log = function (this: UserBanningService, message: string) {
    console.log(`[${PLUGIN_ID}] ${message}`);
  };

  preLoadCacheIfNeeded = async function (this: UserBanningService) {
    if (this.cachePreLoadPromise === undefined) {
      this.cachePreLoadPromise = this.preLoadCache();
    }
    await this.cachePreLoadPromise;
  };

  addBanToCache = async function (this: UserBanningService, tenantId: string, userId: string) {
    this.cache.set(`${tenantId}|${userId}`, true);
  };

  removeBanFromCache = async function (this: UserBanningService, tenantId: string, userId: string) {
    this.cache.delete(`${tenantId}|${userId}`);
  };

  getBanStatusFromCache = async function (this: UserBanningService, tenantId: string, userId: string) {
    return this.cache.get(`${tenantId}|${userId}`);
  };

  preLoadCache = async function (this: UserBanningService) {
    const tenants = await listAllTenants();
    if (tenants.status !== "OK") {
      this.log("Could not list tenants during preload");
      return;
    }
    for (const { tenantId } of tenants.tenants) {
      const bannedUsers = await getUsersThatHaveRole(tenantId, this.pluginConfig.bannedUserRole);
      if (bannedUsers.status === "UNKNOWN_ROLE_ERROR") {
        const result = await createNewRoleOrAddPermissions(this.pluginConfig.bannedUserRole, []);
        if (result.status !== "OK") {
          this.log("Could not create banned user role during preload");
          throw new Error("Could not create banned user role during preload");
        }
        this.log("Created banned user role during preload");
        return;
      }
      for (const userId of bannedUsers.users) {
        await this.addBanToCache(tenantId, userId);
      }
    }
  };

  checkAndAddBannedUserRoleIfNeeded = async function (this: UserBanningService, userContext?: UserContext) {
    const result = await getAllRoles(userContext);
    if (result.status !== "OK") {
      return {
        status: "UNKNOWN_ERROR",
        message: "Could not update roles",
      };
    }

    const bannedRole = result.roles.find((role) => role === this.pluginConfig.bannedUserRole);
    if (!bannedRole) {
      const result = await createNewRoleOrAddPermissions(this.pluginConfig.bannedUserRole, [], userContext);
      if (result.status !== "OK") {
        return {
          status: "UNKNOWN_ERROR",
          message: "Could not create banned user role",
        };
      }
    }

    return {
      status: "OK",
    };
  };

  getBanStatus = async function (
    this: UserBanningService,
    tenantId: string,
    userId: string,
    userContext?: UserContext
  ): Promise<{ status: "OK"; banned: boolean | undefined } | { status: "UNKNOWN_ERROR"; message: string }> {
    const result = await getRolesForUser(tenantId, userId, userContext);
    if (result.status !== "OK") {
      return {
        status: "UNKNOWN_ERROR",
        message: "Could not get ban status",
      };
    }

    const banned = result.roles.includes(this.pluginConfig.bannedUserRole);

    return {
      status: "OK",
      banned,
    };
  };

  setBanStatusAndUpdateSessions = async function (
    this: UserBanningService,
    userId: string,
    isBanned: boolean,
    userContext?: UserContext
  ): Promise<{ status: "OK" } | { status: "UNKNOWN_ROLE_ERROR" } | { status: "USER_NOT_FOUND" }> {
    await this.checkAndAddBannedUserRoleIfNeeded(userContext);

    const user = await getUser(userId, userContext);
    if (!user) {
      return {
        status: "USER_NOT_FOUND",
      };
    }
    for (const tenantId of user.tenantIds) {
      if (isBanned) {
        const result = await addRoleToUser(tenantId, userId, "banned", userContext);
        if (result.status !== "OK") return result;
        await this.addBanToCache(tenantId, userId);
      } else {
        const result = await removeUserRole(tenantId, userId, "banned", userContext);
        if (result.status !== "OK") return result;
        await this.removeBanFromCache(tenantId, userId);
      }

      if (isBanned) {
        await Session.revokeAllSessionsForUser(userId, true, tenantId);
      } else {
        const userSessions = await Session.getAllSessionHandlesForUser(userId, true, tenantId);
        for (const userSession of userSessions) {
          await Session.fetchAndSetClaim(userSession, UserRoleClaim, userContext);
        }
      }
    }

    return {
      status: "OK",
    };
  };
}
