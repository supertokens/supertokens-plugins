import { EmailDeliveryInterface } from "supertokens-node/lib/build/ingredients/emaildelivery/types";
import { UserContext } from "supertokens-node/types";
import { PluginEmailDeliveryInput } from "./types";
import { logDebugMessage } from "supertokens-node/lib/build/logger";

// Default email service that provides template generation but throws on send
export class DefaultPluginEmailService implements EmailDeliveryInterface<PluginEmailDeliveryInput> {
  // Public method to generate email content - can be used in overrides
  generateEmailContent(input: PluginEmailDeliveryInput) {
    switch (input.type) {
    case "TENANT_REQUEST_APPROVAL":
      return {
        subject: `New request to join ${input.tenantId}!`,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px; text-align: center;">
                <h1 style="color: white; margin: 0;">You're Invited!</h1>
              </div>
              <div style="padding: 40px; background: #f9f9f9;">
                <h2>${input.senderEmail} has requested to join ${input.tenantId}</h2>
                <a href="${input.appUrl}/user/tenants" 
                   style="background: #4CAF50; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 20px 0;">
                  Open Requests
                </a>
                ${
  input.customData?.customMessage
    ? `
                <div style="margin-top: 20px; padding: 15px; background: #e3f2fd; border-left: 4px solid #2196F3;">
                  <p style="margin: 0; font-style: italic;">"${input.customData.customMessage}"</p>
                </div>
                `
    : ""
}
              </div>
            </div>
          `,
        text: `
            ${input.senderEmail} has requested to join ${input.tenantId}
            
            Open Requests: ${input.appUrl}/user/tenants
            
            ${input.customData?.customMessage ? `Message: "${input.customData.customMessage}"` : ""}            
          `,
      };

    case "TENANT_CREATE_APPROVAL":
      return {
        subject: "New request to create tenant",
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: #2196F3; padding: 30px; text-align: center;">
                <h1 style="color: white; margin: 0;">New Notification</h1>
              </div>
              <div style="padding: 40px;">
                <h2>${input.creatorEmail} has requested to create a new tenant ${input.tenantId}</h2>
                <a href="${input.appUrl}/user/tenants" 
                   style="background: #FF9800; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 20px 0;">
                  Open Requests
                </a>
              </div>
            </div>
          `,
        text: `
            ${input.creatorEmail} has requested to create a new tenant ${input.tenantId}
            
            Open Requests: ${input.appUrl}/user/tenants
          `,
      };

    default:
      throw new Error("Should never come here");
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sendEmail = async (input: PluginEmailDeliveryInput & { userContext: UserContext }) => {
    logDebugMessage("No email service configured and no override provided for sendEmail");
    throw new Error(
      "Email functionality not configured. " +
        "Please provide either:\n" +
        "1. A service (like PluginSMTPService) in emailDelivery.service, OR\n" +
        "2. Override the sendEmail function in emailDelivery.override",
    );
  };
}
