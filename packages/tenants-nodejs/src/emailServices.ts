import { EmailDeliveryInterface } from "supertokens-node/lib/build/ingredients/emaildelivery/types";
import { createTransport, Transporter } from "nodemailer";
import { UserContext } from "supertokens-node/types";
import { PluginEmailDeliveryInput } from "./types";
import { DefaultPluginEmailService } from "./defaultEmailService";

export class PluginSMTPService implements EmailDeliveryInterface<PluginEmailDeliveryInput> {
  private transporter: Transporter;
  private fromConfig: { name: string; email: string };

  constructor(config: {
    smtpSettings: {
      host: string;
      port: number;
      secure?: boolean;
      authUsername?: string;
      password: string;
      from: { name: string; email: string };
    };
  }) {
    this.transporter = createTransport({
      host: config.smtpSettings.host,
      port: config.smtpSettings.port,
      auth: {
        user: config.smtpSettings.authUsername || config.smtpSettings.from.email,
        pass: config.smtpSettings.password,
      },
      secure: config.smtpSettings.secure ?? false,
    });
    this.fromConfig = config.smtpSettings.from;
  }

  sendEmail = async (input: PluginEmailDeliveryInput & { userContext: UserContext }) => {
    const emailContent = this.generateEmailContent(input);

    await this.transporter.sendMail({
      from: `${this.fromConfig.name} <${this.fromConfig.email}>`,
      to: input.email,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
    });
  };

  private generateEmailContent(input: PluginEmailDeliveryInput) {
    // Import shared template generator
    const templateService = new DefaultPluginEmailService();
    return templateService.generateEmailContent(input);
  }
}
