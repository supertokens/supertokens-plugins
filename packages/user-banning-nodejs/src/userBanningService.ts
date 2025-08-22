import { UserContext } from "supertokens-node/types";
import {
  addRoleToUser,
  removeUserRole,
  getRolesForUser,
  getAllRoles,
  createNewRoleOrAddPermissions,
  UserRoleClaim,
} from "supertokens-node/recipe/userroles";
import { SuperTokensPluginUserBanningPluginLogger, SuperTokensPluginUserBanningPluginNormalisedConfig } from "./types";
import SuperTokensError from "supertokens-node/lib/build/error";
import { SessionContainer } from "supertokens-node/recipe/session";
import Session from "supertokens-node/recipe/session";

export class UserBanningService {
  protected cache: Map<string, boolean> = new Map();

  constructor(
    protected pluginConfig: SuperTokensPluginUserBanningPluginNormalisedConfig,
    protected log: SuperTokensPluginUserBanningPluginLogger
  ) {}

  async assertAndRevokeBannedSession(session?: SessionContainer, userContext?: UserContext): Promise<void> {
    if (!session) return;

    const claim = await session.getClaimValue(UserRoleClaim, userContext);
    if (!claim) return;

    if (claim.includes(this.pluginConfig.bannedUserRole)) {
      await session.revokeSession();
      throw new SuperTokensError({
        message: "User banned",
        type: "PLUGIN_ERROR",
      });
    }
  }

  async checkAndAddBannedUserRole(userContext?: UserContext) {
    const result = await getAllRoles(userContext);
    if (result.status !== "OK") {
      return {
        status: "UNKNOWN_ERROR",
        message: "Could not update roles",
      };
    }

    const bannedRole = result.roles.find((role) => role === this.pluginConfig.bannedUserRole);
    if (!bannedRole) {
      return createNewRoleOrAddPermissions(this.pluginConfig.bannedUserRole, [], userContext);
    }

    return {
      status: "OK",
    };
  }

  async getBanStatus(
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
  }

  async setBanStatusAndRefreshSessions(
    tenantId: string,
    userId: string,
    isBanned: boolean,
    userContext?: UserContext
  ): Promise<{ status: "OK" } | { status: "UNKNOWN_ROLE_ERROR" }> {
    await this.checkAndAddBannedUserRole(userContext);

    if (isBanned) {
      const result = await addRoleToUser(tenantId, userId, "banned", userContext);
      if (result.status !== "OK") return result;
    } else {
      const result = await removeUserRole(tenantId, userId, "banned", userContext);
      if (result.status !== "OK") return result;
    }

    if (isBanned) {
      await Session.revokeAllSessionsForUser(userId, true, tenantId);
    } else {
      const userSessions = await Session.getAllSessionHandlesForUser(userId, true, tenantId);
      for (const userSession of userSessions) {
        await Session.fetchAndSetClaim(userSession, UserRoleClaim, userContext);
      }
    }

    return {
      status: "OK",
    };
  }
}
