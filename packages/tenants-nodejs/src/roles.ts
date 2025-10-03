import UserRoles from "supertokens-node/recipe/userroles";
import { logDebugMessage } from "supertokens-node/lib/build/logger";

import { PERMISSIONS, ROLES } from "@shared/tenants";
import { GetUserIdsInTenantWithRole } from "./types";

export const createRoles = async () => {
  // Create the roles
  const adminCreateResponse = await UserRoles.createNewRoleOrAddPermissions(ROLES.ADMIN, [
    PERMISSIONS.READ,
    PERMISSIONS.WRITE,
    PERMISSIONS.DELETE,
  ]);
  const memberCreateResponse = await UserRoles.createNewRoleOrAddPermissions(ROLES.MEMBER, [
    PERMISSIONS.READ,
    PERMISSIONS.WRITE,
  ]);
  const appAdminCreateResponse = await UserRoles.createNewRoleOrAddPermissions(ROLES.APP_ADMIN, [
    PERMISSIONS.READ,
    PERMISSIONS.WRITE,
    PERMISSIONS.DELETE,
  ]);

  logDebugMessage(`Admin role created, already exists: ${!adminCreateResponse.createdNewRole}`);
  logDebugMessage(`Member role created, already exists: ${!memberCreateResponse.createdNewRole}`);
  logDebugMessage(`App admin role created, already exists: ${!appAdminCreateResponse.createdNewRole}`);
};

export const assignRoleToUserInTenant = async (tenantId: string, userId: string, role: string) => {
  /**
   * Function to assign the passed role to the passed user in the passed tenant.
   *
   * @param tenantId - The tenant id to assign the role to.
   * @param userId - The user id to assign the role to.
   * @param role - The role to assign to the user.
   */
  const addRoleResponse = await UserRoles.addRoleToUser(tenantId, userId, role);

  logDebugMessage(`addRoleResponse: ${JSON.stringify(addRoleResponse)}`);

  if (addRoleResponse.status === "UNKNOWN_ROLE_ERROR") {
    // NOTE: Should never come here
    throw new Error("Role's not created yet, this should never happen");
  }

  logDebugMessage(`Did user already have role: ${addRoleResponse.didUserAlreadyHaveRole}`);
};

export const assignAdminToUserInTenant = async (tenantId: string, userId: string) => {
  /**
   * Function to assign the passed user as admin in the passed tenant.
   *
   * This function is useful when using the tenant management plugin in order
   * to assign admin permissions to one user.
   *
   * @param tenantId - The tenant id to assign the admin to.
   * @param userId - The user id to assign the admin to.
   */
  return assignRoleToUserInTenant(tenantId, userId, ROLES.ADMIN);
};

export const getUserIdsInTenantWithRole: GetUserIdsInTenantWithRole = async (
  tenantId: string,
  role: string,
): Promise<string[]> => {
  /**
   * Get all the user ID's in the passed tenant with the specified role.
   *
   * @param tenantId - The tenant id to get the users from.
   * @param role - The role to get the users with.
   */
  const usersResponse = await UserRoles.getUsersThatHaveRole(tenantId, role);

  if (usersResponse.status === "UNKNOWN_ROLE_ERROR") {
    // Should never happen since the role will be created before
    // but need to handle it.
    throw new Error("Role's not created yet, this should never happen");
  }

  return usersResponse.users;
};
