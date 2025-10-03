import { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import { pluginUserMetadata } from "@shared/nodejs";
import {
  InviteeDetails,
  TenantCreationRequestMetadata,
  TenantCreationRequestWithUser,
  TenantList,
  TenantMetadata,
} from "@shared/tenants";
import { NormalisedAppinfo, User, UserContext } from "supertokens-node/types";
import { LoginMethod } from "supertokens-node/lib/build/user";
import { EmailDeliveryInterface } from "supertokens-node/lib/build/ingredients/emaildelivery/types";
import { BaseRequest } from "supertokens-node/lib/build/framework/index";

export type ErrorResponse = {
  status: "ERROR";
  message: string;
};

export type MetadataType = ReturnType<typeof pluginUserMetadata<TenantMetadata>>;
export type TenantCreationRequestMetadataType = ReturnType<typeof pluginUserMetadata<TenantCreationRequestMetadata>>;

// Define custom email input type for the plugin
export type PluginEmailDeliveryInput =
  | {
      type: "TENANT_REQUEST_APPROVAL";
      email: string;
      tenantId: string;
      senderEmail: string;
      customData?: Record<string, any>;
      appUrl: string;
    }
  | {
      type: "TENANT_CREATE_APPROVAL";
      email: string;
      tenantId: string;
      creatorEmail: string;
      customData?: Record<string, any>;
      appUrl: string;
    };

export type SuperTokensPluginTenantPluginConfig = {
  requireNonPublicTenantAssociation?: boolean;
  requireTenantCreationRequestApproval?: boolean;
  enableTenantListAPI?: boolean;

  // Email delivery configuration - service is optional, override can provide sendEmail implementation
  emailDelivery?: {
    service?: EmailDeliveryInterface<PluginEmailDeliveryInput>;
    override?: (
      originalImplementation: EmailDeliveryInterface<PluginEmailDeliveryInput>,
    ) => EmailDeliveryInterface<PluginEmailDeliveryInput>;
  };
};

export type SuperTokensPluginTenantPluginNormalisedConfig = {
  requireNonPublicTenantAssociation: boolean;
  requireTenantCreationRequestApproval: boolean;
  enableTenantListAPI: boolean;

  // Email delivery configuration - service is optional, override can provide sendEmail implementation
  emailDelivery?: {
    service?: EmailDeliveryInterface<PluginEmailDeliveryInput>;
    override?: (
      originalImplementation: EmailDeliveryInterface<PluginEmailDeliveryInput>,
    ) => EmailDeliveryInterface<PluginEmailDeliveryInput>;
  };
};

export type SendPluginEmail = (input: PluginEmailDeliveryInput, userContext: UserContext) => Promise<void>;

export type AssociateAllLoginMethodsOfUserWithTenant = (
  tenantId: string,
  userId: string,
  loginMethodFilter?: (loginMethod: LoginMethod) => boolean,
) => Promise<void>;

export type GetUserIdsInTenantWithRole = (tenantId: string, role: string) => Promise<string[]>;

export type GetAppUrl = (
  appInfo: NormalisedAppinfo,
  request: BaseRequest | undefined,
  userContext: UserContext,
) => string;

export type OverrideableTenantFunctionImplementation = {
  getTenants: (session: SessionContainerInterface | string) => Promise<({ status: "OK" } & TenantList) | ErrorResponse>;
  isAllowedToJoinTenant: (user: User, session: SessionContainerInterface) => Promise<boolean>;
  isAllowedToCreateTenant: (session: SessionContainerInterface) => Promise<boolean>;
  doesTenantCreationRequireApproval: (session: SessionContainerInterface) => Promise<boolean>;
  canCreateInvitation: (user: User, role: string, session: SessionContainerInterface) => Promise<boolean>;
  canApproveJoinRequest: (user: User, role: string, session: SessionContainerInterface) => Promise<boolean>;
  canApproveTenantCreationRequest: (user: User, role: string, session: SessionContainerInterface) => Promise<boolean>;
  canRemoveUserFromTenant: (user: User, roles: string[], session: SessionContainerInterface) => Promise<boolean>;
  createTenantAndAssignAdmin: (
    tenantDetails: {
      name: string;
      firstFactors?: string[] | null;
    },
    userId: string,
  ) => Promise<{ status: "OK"; createdNew: boolean } | ErrorResponse>;
  getTenantUsers: (
    tenantId: string,
  ) => Promise<{ status: "OK"; users: (User & { roles?: string[] })[] } | ErrorResponse>;
  addInvitation: (
    email: string,
    tenantId: string,
    role: string,
    metadata: MetadataType,
  ) => Promise<{ status: "OK"; code: string } | ErrorResponse>;
  removeInvitation: (
    email: string,
    tenantId: string,
    metadata: MetadataType,
  ) => Promise<{ status: "OK" } | ErrorResponse>;
  acceptInvitation: (
    code: string,
    tenantId: string,
    session: SessionContainerInterface,
    metadata: MetadataType,
  ) => Promise<{ status: "OK" } | ErrorResponse>;
  getInvitations: (
    tenantId: string,
    metadata: MetadataType,
  ) => Promise<{ status: "OK"; invitees: InviteeDetails[] } | ErrorResponse>;
  associateAllLoginMethodsOfUserWithTenant: AssociateAllLoginMethodsOfUserWithTenant;
  addTenantCreationRequest: (
    session: SessionContainerInterface,
    tenantDetails: {
      name: string;
      firstFactors?: string[] | null;
    },
    metadata: TenantCreationRequestMetadataType,
    appUrl: string,
    userContext: UserContext,
    sendEmail: SendPluginEmail,
  ) => Promise<{ status: "OK" } | ErrorResponse>;
  getTenantCreationRequests: (
    metadata: TenantCreationRequestMetadataType,
    userContext: UserContext,
  ) => Promise<({ status: "OK" } & { requests: TenantCreationRequestWithUser[] }) | ErrorResponse>;
  acceptTenantCreationRequest: (
    requestId: string,
    session: SessionContainerInterface,
    metadata: TenantCreationRequestMetadataType,
  ) => Promise<{ status: "OK" } | ErrorResponse>;
  rejectTenantCreationRequest: (
    requestId: string,
    session: SessionContainerInterface,
    metadata: TenantCreationRequestMetadataType,
  ) => Promise<{ status: "OK" } | ErrorResponse>;
  sendTenantCreationRequestEmail: (
    tenantId: string,
    creatorEmail: string,
    appUrl: string,
    userContext: UserContext,
    sendEmail: SendPluginEmail,
  ) => Promise<void>;
  getAppUrl: GetAppUrl;
};
