import { RowndMigrationPolicyError } from "./errors";

export function assertVerificationCellInheritance(email: string, baselineVerified: boolean, destinationVerified: boolean, authenticatedEmail: string | undefined) {
  if (destinationVerified && !baselineVerified && email.toLowerCase() !== authenticatedEmail) {
    throw new RowndMigrationPolicyError("Alias publication would verify an unverified credential without exact source proof");
  }
}
