import { ST_EMAIL_VALUE_STORAGE_KEY } from "./constants";

export function setInputValue(input: HTMLInputElement, val: string) {
  // @ts-ignore
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  nativeInputValueSetter?.call(input, val);

  let ev2 = new Event("input", { bubbles: true });
  input.dispatchEvent(ev2);
}

export const hidePasswordInput = () => {
  // @ts-ignore
  const supertokensRoot = document.querySelector("#supertokens-root")?.shadowRoot;

  // Find the form row with password label and hide it
  const formRows = supertokensRoot?.querySelectorAll("[data-supertokens=\"formRow \"]");
  formRows?.forEach((formRow) => {
    const labelElement = formRow.querySelector("[data-supertokens=\"label\"]");
    if (labelElement && labelElement.textContent?.toLowerCase().includes("password")) {
      // @ts-ignore
      formRow.style.display = "none";

      // Set a fake password in the password input
      const passwordInput = formRow.querySelector("[data-supertokens=\"input input-password\"]");
      if (passwordInput) {
        setInputValue(passwordInput as HTMLInputElement, "supertokens----not-a-password");
      }
    }
  });
};

export const updateSignInSubmitBtn = (btnText: string) => {
  // @ts-ignore
  const supertokensRoot = document.querySelector("#supertokens-root")?.shadowRoot;

  // Find all buttons with data-supertokens="button" and find the one with "Sign in" text
  const submitButtons = supertokensRoot?.querySelectorAll("[data-supertokens=\"button\"]");
  submitButtons?.forEach((button) => {
    // Check if it's a button element and has type submit
    if (button instanceof HTMLButtonElement && button.type === "submit") {
      // Check if the button text contains "Sign in"
      if (button.textContent?.toLowerCase().includes("sign in")) {
        // @ts-ignore
        button.textContent = btnText;
      }
    }
  });
};

export const showEmailInputOnly = () => {
  // Hide the password input
  // and hide all thirdparty options by selecting `data-supertokens=providerContainer` and
  // setting display to none

  // @ts-ignore
  const supertokensRoot = document.querySelector("#supertokens-root")?.shadowRoot;

  // Find the form row with password label and hide it
  const formRows = supertokensRoot?.querySelectorAll("[data-supertokens=\"formRow \"]");
  formRows?.forEach((formRow) => {
    const labelElement = formRow.querySelector("[data-supertokens=\"label\"]");
    if (labelElement && labelElement.textContent?.toLowerCase().includes("password")) {
      // @ts-ignore
      formRow.style.display = "none";

      // Set a fake password in the password input
      const passwordInput = formRow.querySelector("[data-supertokens=\"input input-password\"]");
      if (passwordInput) {
        setInputValue(passwordInput as HTMLInputElement, "supertokens----not-a-password");
      }
    }
  });

  const providerContainers = supertokensRoot?.querySelectorAll("[data-supertokens=\"providerContainer\"]");
  providerContainers?.forEach((container) => {
    // @ts-ignore
    container.style.display = "none";
  });

  // Hide the `or` separator as well
  const orSeparators = supertokensRoot?.querySelectorAll("[data-supertokens=\"dividerWithOr\"]");
  orSeparators?.forEach((separator) => {
    // @ts-ignore
    separator.style.display = "none";
  });

  // Find all buttons with data-supertokens="button" and find the one with "Sign in" text
  const submitButtons = supertokensRoot?.querySelectorAll("[data-supertokens=\"button\"]");
  submitButtons?.forEach((button) => {
    // Check if it's a button element and has type submit
    if (button instanceof HTMLButtonElement && button.type === "submit") {
      // Check if the button text contains "Sign in"
      if (button.textContent?.toLowerCase().includes("sign in")) {
        // @ts-ignore
        button.textContent = "CONTINUE";
      }
    }
  });

  // Find the container with data-supertokens="passkeySignInContainer" and hide that
  const passkeyContainer = supertokensRoot?.querySelector("[data-supertokens=\"passkeySignInContainer\"]");
  if (passkeyContainer) {
    // @ts-ignore
    passkeyContainer.style.display = "none";
  }
};

export const populateEmailFromUrl = () => {
  // Get the urlParams and check if it has a tenantId
  const email = sessionStorage.getItem(ST_EMAIL_VALUE_STORAGE_KEY);
  if (!email) {
    return;
  }

  // @ts-ignore
  const supertokensRoot = document.querySelector("#supertokens-root")?.shadowRoot;
  const emailInput = supertokensRoot?.querySelector("[data-supertokens=\"input input-email\"]");
  if (!emailInput) {
    return;
  }

  // @ts-ignore
  setInputValue(emailInput, email);

  // Remove the email value from sessionStorage after consuming it.
  sessionStorage.removeItem(ST_EMAIL_VALUE_STORAGE_KEY);
};

type ParseTenantIdResponse =
  | { tenantId: string; shouldShowSelector: false }
  | { tenantId: null; shouldShowSelector: true };

export const parseTenantId = (): ParseTenantIdResponse => {
  // Get the urlParams and check if it has a tenantId
  const urlParams = new URLSearchParams(window.location.search);
  const tenantId = urlParams.get("tenantId");

  const shouldShowSelector = !tenantId;

  return shouldShowSelector ? { tenantId: null, shouldShowSelector: true } : { tenantId, shouldShowSelector: false };
};
