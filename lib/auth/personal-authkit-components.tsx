"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import type { PersonalAuth, PersonalUser } from "./personal-user";

type AuthState = {
  user: PersonalUser | null;
  loading: boolean;
  isAuthenticated: boolean;
  sessionId?: string;
  organizationId?: string;
  role?: string;
  roles?: string[];
  permissions: string[];
  entitlements: string[];
  featureFlags: string[];
  impersonator: null;
  refreshAuth?: (args?: { organizationId?: string }) => Promise<void>;
  signIn: () => void;
  signOut: () => void;
};

type AccessTokenState = {
  accessToken: string | undefined;
  loading: boolean;
  error: Error | null;
  getAccessToken: () => Promise<string | undefined>;
  refresh: () => Promise<string | undefined>;
};

const PersonalAuthContext = createContext<AuthState | null>(null);
const PersonalTokenContext = createContext<AccessTokenState | null>(null);

type InitialAuth =
  | Omit<PersonalAuth, "accessToken">
  | { user: null; accessToken?: undefined };

export function AuthKitProvider({
  children,
  initialAuth,
}: {
  children: ReactNode;
  initialAuth: InitialAuth;
  onSessionExpired?: false | (() => void);
}) {
  const user = initialAuth.user ?? null;
  const entitlements =
    user && "entitlements" in initialAuth && Array.isArray(initialAuth.entitlements)
      ? initialAuth.entitlements
      : user
        ? ["ultra-plan"]
        : [];

  const auth = useMemo<AuthState>(
    () => ({
      user,
      loading: false,
      isAuthenticated: Boolean(user),
      sessionId:
        user && "sessionId" in initialAuth ? initialAuth.sessionId : undefined,
      organizationId: undefined,
      role: user && "role" in initialAuth ? initialAuth.role : undefined,
      roles: user && "roles" in initialAuth ? initialAuth.roles : undefined,
      permissions:
        user && "permissions" in initialAuth ? initialAuth.permissions : [],
      entitlements,
      featureFlags: [],
      impersonator: null,
      refreshAuth: async () => undefined,
      signIn: () => {
        window.location.href = "/";
      },
      signOut: () => {
        window.location.href = "/logout";
      },
    }),
    [entitlements, initialAuth, user],
  );

  const getAccessToken = useCallback(async () => {
    const response = await fetch("/api/auth/personal-token", {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { accessToken?: string };
    return body.accessToken;
  }, []);

  const tokens = useMemo<AccessTokenState>(
    () => ({
      accessToken: undefined,
      loading: false,
      error: null,
      getAccessToken,
      refresh: getAccessToken,
    }),
    [getAccessToken],
  );

  return (
    <PersonalAuthContext.Provider value={auth}>
      <PersonalTokenContext.Provider value={tokens}>
        {children}
      </PersonalTokenContext.Provider>
    </PersonalAuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const value = useContext(PersonalAuthContext);
  if (!value) {
    return {
      user: null,
      loading: false,
      isAuthenticated: false,
      permissions: [],
      entitlements: [],
      featureFlags: [],
      impersonator: null,
      signIn: () => undefined,
      signOut: () => undefined,
    };
  }
  return value;
}

export function useAccessToken(): AccessTokenState {
  const value = useContext(PersonalTokenContext);
  if (!value) {
    return {
      accessToken: undefined,
      loading: false,
      error: null,
      getAccessToken: async () => undefined,
      refresh: async () => undefined,
    };
  }
  return value;
}
