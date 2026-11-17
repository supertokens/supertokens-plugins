import { expect, it } from "vitest";
import { corePhoneNumber, migrationPhoneAccountInfos, sameCorePhoneNumber } from "./migration-phone-identity";

it("recognizes Core's Mexico legacy-mobile equivalent without changing unrelated phone identities", () => {
  expect(sameCorePhoneNumber("+5213312345678", "+523312345678")).toBe(true);
  expect(sameCorePhoneNumber("+523312345678", "+5213312345678")).toBe(true);
  expect(sameCorePhoneNumber("+5213312345678", "+523312345679")).toBe(false);
  expect(sameCorePhoneNumber(undefined, undefined)).toBe(false);
  expect(migrationPhoneAccountInfos("+5213312345678")).toEqual([{ phoneNumber: "+5213312345678" }, { phoneNumber: "+523312345678" }]);
  expect(migrationPhoneAccountInfos("+15551234567")).toEqual([{ phoneNumber: "+15551234567" }]);
  for (const number of ["+15551234567", "+523312345678", "+521331234567", "+52133123456789", " +5213312345678"])
    expect(corePhoneNumber(number)).toBe(number);
});
