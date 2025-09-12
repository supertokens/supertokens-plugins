export const ROLES = {
  // Admins of the tenant
  ADMIN: 'tenant-admin',
  // Member of the tenant
  MEMBER: 'tenant-member',
  // Admin of the app
  APP_ADMIN: 'app-admin',
  // Anyone else, i.e no assigned role will be considered
  // a requester of the tenant.
};

export const PERMISSIONS = {
  READ: 'read',
  WRITE: 'write',
  DELETE: 'delete',
};
