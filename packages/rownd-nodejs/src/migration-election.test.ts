import { afterEach, expect, it, vi } from "vitest";
import {
  inspectAdministrativeElection,
  AmbiguousAdministrativeElection,
} from "./migration-election";
import { setRowndClient } from "./rownd-repository";

afterEach(() => setRowndClient(undefined));

it.each([false, true])(
  "elects the most recent valid activity independently of input order (%s)",
  async (reverse) => {
    const profiles = {
      older: {
        data: { user_id: "older", email: "shared@example.com" },
        meta: {
          last_sign_in: "2020-01-01T00:00:00.000Z",
          last_active: "2020-01-02T00:00:00Z",
        },
      },
      newer: {
        data: { user_id: "newer", email: "SHARED@example.com" },
        meta: {
          last_sign_in: "2020-01-03T00:00:00.000Z",
          last_active: "invalid",
        },
      },
    };
    setRowndClient({
      validateToken: vi.fn(),
      fetchUserInfo: vi.fn(
        async ({ user_id }) => profiles[user_id as keyof typeof profiles],
      ),
    });
    const ids = reverse ? ["newer", "older"] : ["older", "newer"];
    expect(
      await inspectAdministrativeElection(
        ids.map((rownd_user_id) => ({ rownd_user_id })),
      ),
    ).toMatchObject({
      winner: { rownd_user_id: "newer", activity: "2020-01-03T00:00:00.000Z" },
    });
  },
);

it.each([
  undefined,
  "not-a-date",
  "2020-02-31T00:00:00.000Z",
  "2999-01-01T00:00:00.000Z",
  1590000000,
])(
  "ignores a competing source's missing, malformed or future activity when ranking: %j",
  async (last_active) => {
    setRowndClient({
      validateToken: vi.fn(),
      fetchUserInfo: vi.fn(async ({ user_id }) => ({
        data: { user_id, email: "shared@example.com" },
        meta: {
          last_active:
            user_id === "one" ? "2020-01-01T00:00:00.000Z" : last_active,
        },
      })),
    });
    expect(
      await inspectAdministrativeElection([
        { rownd_user_id: "one" },
        { rownd_user_id: "two" },
      ]),
    ).toMatchObject({
      winner: { rownd_user_id: "one", activity: "2020-01-01T00:00:00.000Z" },
    });
  },
);

it("elects an unopposed source even when it has no valid activity", async () => {
  setRowndClient({
    validateToken: vi.fn(),
    fetchUserInfo: vi.fn(async ({ user_id }) => ({
      data: { user_id, email: "shared@example.com" },
      meta: {},
    })),
  });
  expect(
    await inspectAdministrativeElection([{ rownd_user_id: "only" }]),
  ).toMatchObject({
    winner: { rownd_user_id: "only" },
    candidates: [{ rownd_user_id: "only" }],
  });
});

it("does not invent a winner from tied valid activity and never picks lexically", async () => {
  setRowndClient({
    validateToken: vi.fn(),
    fetchUserInfo: vi.fn(async ({ user_id }) => ({
      data: { user_id, email: "shared@example.com" },
      meta: { last_active: "2020-01-01T00:00:00.000Z" },
    })),
  });
  await expect(
    inspectAdministrativeElection([
      { rownd_user_id: "one" },
      { rownd_user_id: "two" },
    ]),
  ).rejects.toBeInstanceOf(AmbiguousAdministrativeElection);
});

it.each(["one", "two"])(
  "prefers the supplied canonical survivor only among the tied maximum activity (%s)",
  async (canonicalRowndId) => {
    setRowndClient({
      validateToken: vi.fn(),
      fetchUserInfo: vi.fn(async ({ user_id }) => ({
        data: { user_id, email: "shared@example.com" },
        meta: { last_active: "2020-01-01T00:00:00.000Z" },
      })),
    });
    expect(
      await inspectAdministrativeElection(
        [{ rownd_user_id: "one" }, { rownd_user_id: "two" }],
        { canonicalRowndId },
      ),
    ).toMatchObject({ winner: { rownd_user_id: canonicalRowndId } });
  },
);

it("does not prefer the canonical survivor when another source has strictly newer activity", async () => {
  setRowndClient({
    validateToken: vi.fn(),
    fetchUserInfo: vi.fn(async ({ user_id }) => ({
      data: { user_id, email: "shared@example.com" },
      meta: {
        last_active:
          user_id === "one"
            ? "2020-01-01T00:00:00.000Z"
            : "2020-01-02T00:00:00.000Z",
      },
    })),
  });
  expect(
    await inspectAdministrativeElection(
      [{ rownd_user_id: "one" }, { rownd_user_id: "two" }],
      { canonicalRowndId: "one" },
    ),
  ).toMatchObject({ winner: { rownd_user_id: "two" } });
});

it("keeps a missing-activity source as candidate evidence and freshness while ranking the valid one", async () => {
  const profiles = {
    missing: {
      data: { user_id: "missing", email: "shared@example.com" },
      meta: {},
    },
    ranked: {
      data: { user_id: "ranked", email: "shared@example.com" },
      meta: { last_active: "2020-01-01T00:00:00.000Z" },
    },
  };
  setRowndClient({
    validateToken: vi.fn(),
    fetchUserInfo: vi.fn(
      async ({ user_id }) => profiles[user_id as keyof typeof profiles],
    ),
  });
  const result = await inspectAdministrativeElection([
    { rownd_user_id: "missing" },
    { rownd_user_id: "ranked" },
  ]);
  expect(result).toMatchObject({
    winner: { rownd_user_id: "ranked", activity: "2020-01-01T00:00:00.000Z" },
  });
  expect(
    result.candidates.find(
      (candidate) => candidate.rownd_user_id === "missing",
    )!.activity,
  ).toBeUndefined();
  expect(
    result.candidates.find((candidate) => candidate.rownd_user_id === "ranked"),
  ).toMatchObject({ activity: "2020-01-01T00:00:00.000Z" });
  expect(result.fingerprints).toHaveLength(2);
});

it.each(["one", "two"])(
  "elects the canonical survivor when every source lacks valid activity (%s)",
  async (canonicalRowndId) => {
    setRowndClient({
      validateToken: vi.fn(),
      fetchUserInfo: vi.fn(async ({ user_id }) => ({
        data: { user_id, email: "shared@example.com" },
        meta: {},
      })),
    });
    expect(
      await inspectAdministrativeElection(
        [{ rownd_user_id: "one" }, { rownd_user_id: "two" }],
        { canonicalRowndId },
      ),
    ).toMatchObject({ winner: { rownd_user_id: canonicalRowndId } });
  },
);

it.each([undefined, "absent"])(
  "leaves all-missing activity ambiguous without an eligible canonical survivor (%s)",
  async (canonicalRowndId) => {
    setRowndClient({
      validateToken: vi.fn(),
      fetchUserInfo: vi.fn(async ({ user_id }) => ({
        data: { user_id, email: "shared@example.com" },
        meta: {},
      })),
    });
    await expect(
      inspectAdministrativeElection(
        [{ rownd_user_id: "one" }, { rownd_user_id: "two" }],
        { canonicalRowndId },
      ),
    ).rejects.toBeInstanceOf(AmbiguousAdministrativeElection);
  },
);

it("allows an ownerless candidate as evidence without granting it an owner binding", async () => {
  const profiles = {
    ownerless: {
      data: { user_id: "ownerless", email: "shared@example.com" },
      meta: {},
    },
    owned: {
      data: { user_id: "owned", email: "shared@example.com" },
      meta: { last_active: "2020-01-02T00:00:00.000Z" },
    },
  };
  setRowndClient({
    validateToken: vi.fn(),
    fetchUserInfo: vi.fn(
      async ({ user_id }) => profiles[user_id as keyof typeof profiles],
    ),
  });
  const result = await inspectAdministrativeElection([
    { rownd_user_id: "ownerless" },
    { rownd_user_id: "owned", supertokens_user_id: "st-owned" },
  ]);
  expect(result).toMatchObject({
    winner: { rownd_user_id: "owned", supertokens_user_id: "st-owned" },
  });
  expect(result.candidates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ rownd_user_id: "ownerless" }),
      expect.objectContaining({ rownd_user_id: "owned" }),
    ]),
  );
});

it.each([false, true])(
  "activity only resolves a shared current identity, including authoritative provider subjects (%s)",
  async (shared) => {
    setRowndClient({
      validateToken: vi.fn(),
      fetchUserInfo: vi.fn(async ({ user_id }) => ({
        data: { user_id, google_id: "legacy-shared" },
        verified_data: { google_id: shared ? "current-shared" : user_id },
        meta: {
          last_active:
            user_id === "one"
              ? "2020-01-01T00:00:00.000Z"
              : "2020-01-02T00:00:00.000Z",
        },
      })),
    });
    const result = inspectAdministrativeElection([
      { rownd_user_id: "one" },
      { rownd_user_id: "two" },
    ]);
    if (shared)
      expect(await result).toMatchObject({ winner: { rownd_user_id: "two" } });
    else
      await expect(result).rejects.toBeInstanceOf(
        AmbiguousAdministrativeElection,
      );
  },
);

it("compares strict offset timestamps as instants and uses a valid field when the other is future", async () => {
  setRowndClient({
    validateToken: vi.fn(),
    fetchUserInfo: vi.fn(async ({ user_id }) => ({
      data: { user_id, email: "shared@example.com" },
      meta: {
        last_sign_in:
          user_id === "one"
            ? "2020-01-01T12:00:00+02:00"
            : "2020-01-01T10:30:00Z",
        last_active: "2999-01-01T00:00:00Z",
      },
    })),
  });
  expect(
    await inspectAdministrativeElection([
      { rownd_user_id: "one" },
      { rownd_user_id: "two" },
    ]),
  ).toMatchObject({
    winner: { rownd_user_id: "two", activity: "2020-01-01T10:30:00.000Z" },
  });
});

it("does not collapse contradictory owner provenance for the same Rownd source", async () => {
  await expect(
    inspectAdministrativeElection([
      { rownd_user_id: "one", supertokens_user_id: "owner-one" },
      { rownd_user_id: "one", supertokens_user_id: "owner-two" },
    ]),
  ).rejects.toBeInstanceOf(AmbiguousAdministrativeElection);
});
