// Core's libphonenumber canonicalizes Mexico's retired mobile dialling prefix.
// Apply the same compatibility rule at the Core boundary, not to Rownd election
// evidence: current and verified Rownd values must still agree literally.
export function corePhoneNumber(phone: string) {
  return /^\+521\d{10}$/.test(phone) ? `+52${phone.slice(4)}` : phone;
}

export function sameCorePhoneNumber(left: string | undefined, right: string | undefined) {
  return left !== undefined && right !== undefined && corePhoneNumber(left) === corePhoneNumber(right);
}

export function migrationPhoneAccountInfos(phone: string) {
  return [...new Set([phone, corePhoneNumber(phone)])].map((phoneNumber) => ({ phoneNumber }));
}
