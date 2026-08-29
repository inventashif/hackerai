import {
  PERSONAL_ENTITLEMENTS,
  PERSONAL_USER_ID,
  getPersonalUserEmail,
  getPersonalUserName,
} from "./personal-mode";

export type PersonalUser = {
  object: "user";
  id: string;
  email: string;
  emailVerified: boolean;
  firstName: string;
  lastName: string;
  profilePictureUrl: string | null;
  createdAt: string;
  updatedAt: string;
  lastSignInAt: string;
  externalId: string | null;
  metadata: Record<string, string>;
};

export type PersonalAuth = {
  user: PersonalUser;
  sessionId: string;
  organizationId: undefined;
  role: string;
  roles: string[];
  permissions: string[];
  entitlements: string[];
  featureFlags: string[];
  impersonator: null;
  accessToken: string;
};

const PERSONAL_CREATED_AT = "2026-01-01T00:00:00.000Z";

export function createPersonalUser(
  lastSignInAt: string = new Date().toISOString(),
): PersonalUser {
  const { firstName, lastName } = getPersonalUserName();
  return {
    object: "user",
    id: PERSONAL_USER_ID,
    email: getPersonalUserEmail(),
    emailVerified: true,
    firstName,
    lastName,
    profilePictureUrl: null,
    createdAt: PERSONAL_CREATED_AT,
    updatedAt: lastSignInAt,
    lastSignInAt,
    externalId: null,
    metadata: { mode: "personal" },
  };
}

export function createPersonalAuth(accessToken: string): PersonalAuth {
  const user = createPersonalUser();
  return {
    user,
    sessionId: "personal_session_local",
    organizationId: undefined,
    role: "owner",
    roles: ["owner"],
    permissions: [],
    entitlements: [...PERSONAL_ENTITLEMENTS],
    featureFlags: [],
    impersonator: null,
    accessToken,
  };
}
