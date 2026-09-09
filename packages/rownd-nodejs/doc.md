Migration Overview

This document provides a high level overview of how the migration from Rownd to SuperTokens will work. The migration is designed to be phased, low-risk, and low-friction. Existing applications keep using the same rownd integration surface while we transition authentication, sessions, and user data behind the scenes.
Migration sequence
The migration is structured into 3 separate stages:

1. Validate migration mechanisms
2. Bulk migrate users into SuperTokens
3. Switch authentication traffic from Rownd to SuperTokens

The order matters. We first make sure newly active users can be mirrored safely, then bulk import the existing user base, and only then switch the SDK behavior while migrating active sessions.
Validate migration mechanisms

The first release is a transitional Rownd SDK. With this version, apps continue to authenticate through Rownd during this validation phase. The main change is a fire-and-forget sync call during successful login or signup so we can confirm the migration flow safely.

This stage involves several milestones:
On-the-fly user creation
After a user successfully authenticates with Rownd, the updated SDK makes a best-effort API call to the SuperTokens backend SDK (now integrated in your service). That backend verifies the Rownd session and creates the matching user in SuperTokens. This allows us to confirm that new sign-ins are being mirrored correctly before cutover.
Session migration
Once user creation is being validated successfully, we confirm that active Rownd sessions can be migrated into SuperTokens sessions. This is handled by your backend so users do not get logged out during the final switch.
Updated SDK testing
During this phase, we will release Rownd SDK versions that use SuperTokens APIs behind the scenes. This lets us test the new logic before the final release and confirm that existing Rownd client-facing APIs and authentication flows continue to work with minimal frontend changes.
Bulk migrate users into SuperTokens
This stage focuses on exporting your user data from Rownd and importing it into your SuperTokens production instance. This work is mostly on our side.
Before this happens, we need to confirm that on-the-fly user migration is working so that we do not miss new signups between the bulk export and the final switch.

Switch authentication traffic
Once the validation work is complete and your user data has been migrated, we can move to the final step. We will agree on a cutover date and confirm which SDK versions you need to deploy in your apps.

During this final step:

- active sessions should migrate without requiring users to sign in again
- the Rownd integration surface in the frontend remains the same
- the underlying authentication flow moves from Rownd to SuperTokens

Required actions from your side
Overall the plan involves just a couple of changes/updates on your side:
Integrate the supertokens-node SDK in your backend app
Update the Rownd SDK versions during each migration stage
Validate the authentication flows during the testing phase
References
How SuperTokens works
How to integrate the backend SDK
Thirdparty authentication configuration
Passwordless/Magic Link setup
Session verification
General migration guide
