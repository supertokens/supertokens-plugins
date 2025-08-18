import { ComponentOverrideMap as EmailPasswordComponentOverrideMap } from 'supertokens-auth-react/lib/build/recipe/emailpassword/types';
import { ComponentOverrideMap as PasswordlessComponentOverrideMap } from 'supertokens-auth-react/lib/build/recipe/passwordless/types';
import { useCaptcha, useCaptchaInputContainer } from '../hooks';

export const EmailPasswordSignInForm =
  (): EmailPasswordComponentOverrideMap['EmailPasswordSignInForm_Override'] => {
    return ({ DefaultComponent, ...props }) => {
      const CaptchaContainer = useCaptchaInputContainer();
      const { state } = useCaptcha();
      return (
        <DefaultComponent
          {...props}
          error={state.error}
          footer={<CaptchaContainer form="EmailPasswordSignInForm" />}
        />
      );
    };
  };

export const EmailPasswordSignUpForm =
  (): EmailPasswordComponentOverrideMap['EmailPasswordSignUpForm_Override'] => {
    return ({ DefaultComponent, ...props }) => {
      const CaptchaContainer = useCaptchaInputContainer();
      const { state } = useCaptcha(props.onError);
      return (
        <DefaultComponent
          {...props}
          error={state.error}
          footer={<CaptchaContainer form="EmailPasswordSignUpForm" />}
        />
      );
    };
  };

export const EmailPasswordResetPasswordEmail =
  (): EmailPasswordComponentOverrideMap['EmailPasswordResetPasswordEmail_Override'] => {
    return ({ DefaultComponent, ...props }) => {
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
  };

export const EmailPasswordSubmitNewPassword =
  (): EmailPasswordComponentOverrideMap['EmailPasswordSubmitNewPassword_Override'] => {
    return ({ DefaultComponent, ...props }) => {
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
  };

export const PasswordlessEmailForm =
  (): PasswordlessComponentOverrideMap['PasswordlessEmailForm_Override'] => {
    return ({ DefaultComponent, ...props }) => {
      const CaptchaContainer = useCaptchaInputContainer();
      const { state } = useCaptcha(props.onError);
      return (
        <DefaultComponent
          {...props}
          error={state.error}
          footer={<CaptchaContainer form="PasswordlessEmailForm" />}
        />
      );
    };
  };

export const PasswordlessPhoneForm =
  (): PasswordlessComponentOverrideMap['PasswordlessPhoneForm_Override'] => {
    return ({ DefaultComponent, ...props }) => {
      const CaptchaContainer = useCaptchaInputContainer();
      const { state } = useCaptcha(props.onError);
      return (
        <DefaultComponent
          {...props}
          error={state.error}
          footer={<CaptchaContainer form="PasswordlessPhoneForm" />}
        />
      );
    };
  };

export const PasswordlessEmailOrPhoneForm =
  (): PasswordlessComponentOverrideMap['PasswordlessEmailOrPhoneForm_Override'] => {
    return ({ DefaultComponent, ...props }) => {
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
  };

export const PasswordlessEPComboEmailForm =
  (): PasswordlessComponentOverrideMap['PasswordlessEPComboEmailForm_Override'] => {
    return ({ DefaultComponent, ...props }) => {
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
  };

export const PasswordlessEPComboEmailOrPhoneForm =
  (): PasswordlessComponentOverrideMap['PasswordlessEPComboEmailOrPhoneForm_Override'] => {
    return ({ DefaultComponent, ...props }) => {
      const CaptchaContainer = useCaptchaInputContainer();
      const { state } = useCaptcha(props.onError);
      return (
        <DefaultComponent
          {...props}
          error={state.error}
          footer={
            <CaptchaContainer form="PasswordlessEPComboEmailOrPhoneForm" />
          }
        />
      );
    };
  };

export const PasswordlessUserInputCodeForm =
  (): PasswordlessComponentOverrideMap['PasswordlessUserInputCodeForm_Override'] => {
    return ({ DefaultComponent, ...props }) => {
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
  };
