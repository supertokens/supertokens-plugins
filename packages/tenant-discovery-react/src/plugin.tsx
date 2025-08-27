import { SuperTokensPlugin } from 'supertokens-auth-react';
import { useState, useCallback } from 'react';

import { PLUGIN_ID, API_PATH } from './config';
import { createPluginInitFunction } from '@supertokens-plugin-profile/common-shared';
import { OverrideableTenantFunctionImplementation, PluginConfig, TenantList } from './types';
import { hidePasswordInput, parseTenantId, populateEmailFromUrl } from './util';
import { useLayoutEffect } from 'react';
import { getOverrideableTenantFunctionImplementation } from './recipeImplementation';
import { updateUsePlugin, usePlugin } from './use-plugin';
import { useQuerier, getQuerier } from '@supertokens-plugin-profile/common-frontend';
import { SelectTenantPage } from './select-tenant-page';
import { EmailPasswordPreBuiltUI } from 'supertokens-auth-react/recipe/emailpassword/prebuiltui';
import { AuthComponentProps } from 'supertokens-auth-react/lib/build/types';

export const init = createPluginInitFunction<SuperTokensPlugin, PluginConfig, OverrideableTenantFunctionImplementation>(
  (pluginConfig, implementation) => {
    let apiBasePath: string;
    return {
      id: PLUGIN_ID,
      init: async (config, plugins, sdkVersion) => {
        // Set up the usePlugin hook
        apiBasePath = new URL(API_PATH, config.appInfo.apiDomain.getAsStringDangerous()).toString();
        updateUsePlugin(() => {
          const querier = useQuerier(apiBasePath);
          const [isLoading, setIsLoading] = useState(true);

          const fetchTenants = useCallback(async () => {
            setIsLoading(true);
            const response = await querier.get<({ status: 'OK' } & TenantList) | { status: 'ERROR'; message: string }>(
              '/list',
              {
                withSession: false,
              },
            );
            setIsLoading(false);

            return response;
          }, [querier]);

          return {
            config: pluginConfig ?? {},
            isLoading,
            fetchTenants,
          };
        });

        // Check if the url matches any tenantId and accordingly
        // set the tenantId in the url and refresh the page.
        const tenantId = await implementation.determineTenantFromURL();
        if (tenantId) {
          implementation.setTenantId(tenantId);
          return;
        }

        // If the tenant was not determined from the URL and
        // tenant selector is enabled, we will redirect to the
        // select tenant page.
        const { shouldShowSelector } = parseTenantId();
        if (shouldShowSelector && pluginConfig.showTenantSelector && window.location.pathname !== '/select-tenant') {
          window.location.href = '/select-tenant';
        }
      },
      routeHandlers: (appConfig: any, plugins: any, sdkVersion: any) => {
        return {
          status: 'OK',
          routeHandlers: [
            {
              path: '/select-tenant',
              handler: () => SelectTenantPage.call(null),
            },
          ],
        };
      },
      overrideMap: {
        emailpassword: {
          recipeInitRequired: true,
          functions: (originalImplementation, builder) => {
            return {
              ...originalImplementation,
              signIn: async (input) => {
                // If the `tenantId` is set, then we need to
                // call the original implementation.
                const { shouldShowSelector } = input.userContext;

                // If we are showing the selector, we need to parse the tenantId
                // else return the original response.
                if (!shouldShowSelector) {
                  return originalImplementation.signIn(input);
                }

                // If the selector is showing up, we will make a call to
                // determine the tenant from email instead.

                // Extract the email from fromFields
                const email = input.formFields.find((field) => field.id === 'email')?.value;

                // Very unlikely that email will be undefined at this stage
                // but we will throw an error regardless
                if (!email) {
                  throw new Error('Email is undefined, should never come here');
                }

                const querier = getQuerier(apiBasePath);
                const response = await querier.post<
                  { status: 'OK'; tenant: string } | { status: 'ERROR'; message: string }
                >(
                  '/from-email',
                  {
                    email,
                  },
                  {
                    withSession: false,
                  },
                );

                if (response.status !== 'OK') {
                  // Should never happens since we are passing the email
                  // but handle regardless
                  throw new Error('Should never come here');
                }

                const tenantId = response.tenant;

                // Set the tenantId in the current URL and refresh the page
                implementation.setTenantId(tenantId, input.formFields[0].value);

                // return a SIGN_IN_NOT_ALLOWED error
                // if the code reached this point.
                // though it should not since we refresh the page right after the tenant
                // is set.
                return {
                  status: 'SIGN_IN_NOT_ALLOWED',
                  fetchResponse: new Response(),
                  reason: 'Tenant discovery plugin overridden method',
                };
              },
            };
          },
        },
      },
      generalAuthRecipeComponentOverrides: {
        AuthPageHeader_Override: ({ DefaultComponent, ...props }) => {
          const { shouldShowSelector } = parseTenantId();

          if (shouldShowSelector) {
            return <div>Enter email to continue</div>;
          }

          // @ts-ignore
          return <DefaultComponent {...props} />;
        },
        AuthPageComponentList_Override: ({ DefaultComponent, ...props }) => {
          const { shouldShowSelector } = parseTenantId();

          // Update the auth component list to only keep email if we are showing
          // the selector.
          if (shouldShowSelector) {
            const emailPasswordSignInComponent = EmailPasswordPreBuiltUI.getInstanceOrInitAndGetInstance()
              .getAuthComponents()
              .find((comp) => comp.type === 'SIGN_IN');

            // Unlikely that component will be undefined but still handle
            // the case.
            if (!emailPasswordSignInComponent) {
              throw new Error('Should never come here');
            }

            // Fix type error by ensuring the component matches expected type
            props.authComponents = [emailPasswordSignInComponent.component as React.FC<AuthComponentProps>];

            // Set the formField to hide the password field
            props.factorIds = ['emailpassword'];

            props.userContext = {
              ...props.userContext,
              shouldShowSelector: true,
            };
          }

          useLayoutEffect(() => {
            if (shouldShowSelector) {
              hidePasswordInput();
            }

            // Try to populate the email if it is present
            // in the URL.
            populateEmailFromUrl();
          }, [shouldShowSelector]);

          // @ts-ignore
          return <DefaultComponent {...props} />;
        },
      },
      exports: {
        usePlugin,
      },
    };
  },
  getOverrideableTenantFunctionImplementation,
);
