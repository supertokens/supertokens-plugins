import { ComponentOverrideMap as EmailPasswordComponentOverrideMap } from "supertokens-auth-react/lib/build/recipe/emailpassword/types";
import { ComponentOverrideMap as PasswordlessComponentOverrideMap } from "supertokens-auth-react/lib/build/recipe/passwordless/types";

import { useCaptcha, useCaptchaInputContainer } from "../hooks";

export const EmailPasswordSignInForm = (): EmailPasswordComponentOverrideMap["EmailPasswordSignInForm_Override"] => {
  const Component = ({ DefaultComponent, ...props }: any) => {
    const CaptchaContainer = useCaptchaInputContainer();
    const { state } = useCaptcha();
    return (
      <DefaultComponent {...props} error={state.error} footer={<CaptchaContainer form="EmailPasswordSignInForm" />} />
    );
  };
  Component.displayName = "EmailPasswordSignInForm";
  return Component;
};

export const EmailPasswordSignUpForm = (): EmailPasswordComponentOverrideMap["EmailPasswordSignUpForm_Override"] => {
  const Component = ({ DefaultComponent, ...props }: any) => {
    const CaptchaContainer = useCaptchaInputContainer();
    const { state } = useCaptcha(props.onError);
    return (
      <DefaultComponent {...props} error={state.error} footer={<CaptchaContainer form="EmailPasswordSignUpForm" />} />
    );
  };
  Component.displayName = "EmailPasswordSignUpForm";
  return Component;
};

export const EmailPasswordResetPasswordEmail =
  (): EmailPasswordComponentOverrideMap["EmailPasswordResetPasswordEmail_Override"] => {
    const Component = ({ DefaultComponent, ...props }: any) => {
      const CaptchaContainer = useCaptchaInputContainer();
      const { state } = useCaptcha(props.onError);
      return (
        <DefaultComponent
          {...props}
          error={state.error}
          footer={<CaptchaContainer form="EmailPasswordResetPasswordEmail" />}
        />
      );
    };
    Component.displayName = "EmailPasswordResetPasswordEmail";
    return Component;
  };

export const EmailPasswordSubmitNewPassword =
  (): EmailPasswordComponentOverrideMap["EmailPasswordSubmitNewPassword_Override"] => {
    const Component = ({ DefaultComponent, ...props }: any) => {
      const CaptchaContainer = useCaptchaInputContainer();
      const { state } = useCaptcha(props.onError);
      return (
        <DefaultComponent
          {...props}
          error={state.error}
          footer={<CaptchaContainer form="EmailPasswordSubmitNewPassword" />}
        />
      );
    };
    Component.displayName = "EmailPasswordSubmitNewPassword";
    return Component;
  };

export const PasswordlessEmailForm = (): PasswordlessComponentOverrideMap["PasswordlessEmailForm_Override"] => {
  const Component = ({ DefaultComponent, ...props }: any) => {
    const CaptchaContainer = useCaptchaInputContainer();
    const { state } = useCaptcha(props.onError);
    return (
      <DefaultComponent {...props} error={state.error} footer={<CaptchaContainer form="PasswordlessEmailForm" />} />
    );
  };
  Component.displayName = "PasswordlessEmailForm";
  return Component;
};

export const PasswordlessPhoneForm = (): PasswordlessComponentOverrideMap["PasswordlessPhoneForm_Override"] => {
  const Component = ({ DefaultComponent, ...props }: any) => {
    const CaptchaContainer = useCaptchaInputContainer();
    const { state } = useCaptcha(props.onError);
    return (
      <DefaultComponent {...props} error={state.error} footer={<CaptchaContainer form="PasswordlessPhoneForm" />} />
    );
  };
  Component.displayName = "PasswordlessPhoneForm";
  return Component;
};

export const PasswordlessEmailOrPhoneForm =
  (): PasswordlessComponentOverrideMap["PasswordlessEmailOrPhoneForm_Override"] => {
    const Component = ({ DefaultComponent, ...props }: any) => {
      const CaptchaContainer = useCaptchaInputContainer();
      const { state } = useCaptcha(props.onError);
      return (
        <DefaultComponent
          {...props}
          error={state.error}
          footer={<CaptchaContainer form="PasswordlessEmailOrPhoneForm" />}
        />
      );
    };
    Component.displayName = "PasswordlessEmailOrPhoneForm";
    return Component;
  };

export const PasswordlessEPComboEmailForm =
  (): PasswordlessComponentOverrideMap["PasswordlessEPComboEmailForm_Override"] => {
    const Component = ({ DefaultComponent, ...props }: any) => {
      const CaptchaContainer = useCaptchaInputContainer();
      const { state } = useCaptcha(props.onError);
      return (
        <DefaultComponent
          {...props}
          error={state.error}
          footer={<CaptchaContainer form="PasswordlessEPComboEmailForm" />}
        />
      );
    };
    Component.displayName = "PasswordlessEPComboEmailForm";
    return Component;
  };

export const PasswordlessEPComboEmailOrPhoneForm =
  (): PasswordlessComponentOverrideMap["PasswordlessEPComboEmailOrPhoneForm_Override"] => {
    const Component = ({ DefaultComponent, ...props }: any) => {
      const CaptchaContainer = useCaptchaInputContainer();
      const { state } = useCaptcha(props.onError);
      return (
        <DefaultComponent
          {...props}
          error={state.error}
          footer={<CaptchaContainer form="PasswordlessEPComboEmailOrPhoneForm" />}
        />
      );
    };
    Component.displayName = "PasswordlessEPComboEmailOrPhoneForm";
    return Component;
  };

export const PasswordlessUserInputCodeForm =
  (): PasswordlessComponentOverrideMap["PasswordlessUserInputCodeForm_Override"] => {
    const Component = ({ DefaultComponent, ...props }: any) => {
      const CaptchaContainer = useCaptchaInputContainer();
      const { state } = useCaptcha(props.onError);
      return (
        <DefaultComponent
          {...props}
          error={state.error}
          footer={<CaptchaContainer form="PasswordlessUserInputForm" />}
        />
      );
    };
    Component.displayName = "PasswordlessUserInputCodeForm";
    return Component;
  };
