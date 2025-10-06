export const ROLES = {
  // Admins of the tenant
  TENANT_ADMIN: 'tenant-admin',
  // Member of the tenant
  TENANT_MEMBER: 'tenant-member',
  // Admin of the app
  APP_ADMIN: 'app-admin',
  // Anyone else, i.e no assigned role will be considered
  // a requester of the tenant.
};

export const PERMISSIONS = {
  LIST_USERS: "list-users",
  REMOVE_USERS: "remove-users",
  CHANGE_USER_ROLES: "change-user-roles",
  MANAGE_JOIN_REQUESTS: "manage-join-requests",
  MANAGE_CREATE_REQUESTS: "manage-create-requests",
  MANAGE_INVITATIONS: "manage-invitations",
};
