"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createAuthController, type AuthController, type AuthState } from "./auth-controller";
import {
  createTokenVerifier,
  getMisplacedSignInLinkTarget,
  type ConfirmLink,
  type FinishSignInResult,
  type MagicLinkResult,
  type SignOutResult,
} from "./auth-session";
import { getSupabaseBrowserClient } from "./supabase-client";
import type { SupabaseBrowserConfig } from "./supabase-config";

export type { AuthState } from "./auth-controller";

type AuthContextValue = {
  auth: AuthState;
  sendMagicLink: (email: string) => Promise<MagicLinkResult>;
  completeSignIn: (link: Extract<ConfirmLink, { kind: "token-hash" | "code" }>) => Promise<FinishSignInResult>;
  signOut: () => Promise<SignOutResult>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function createReadySignal() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * Kept apart from the quest store on purpose: nothing here reads, writes or resets game saves.
 *
 * `config` comes from the root layout, which checks it on the server first (see server-config.ts).
 */
export function AuthProvider({ config, children }: { config: SupabaseBrowserConfig | null; children: ReactNode }) {
  // The server and browser agree on this first state, because both see the same config prop.
  const [auth, setAuth] = useState<AuthState>(() => (config ? { status: "loading" } : { status: "unavailable" }));
  const controllerRef = useRef<AuthController | null>(null);
  // Pages' effects run before this provider's, so their first calls wait until the controller exists.
  const [ready] = useState(createReadySignal);

  useEffect(() => {
    const client = getSupabaseBrowserClient(config);
    if (!client || !config) {
      ready.resolve();
      return;
    }

    const misplacedLink = getMisplacedSignInLinkTarget(window.location.pathname, window.location.search, window.location.hash);
    if (misplacedLink) {
      window.location.replace(misplacedLink);
      return;
    }

    const controller = createAuthController(client.auth, createTokenVerifier(client.auth, config), setAuth);
    controllerRef.current = controller;
    ready.resolve();
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [config, ready]);

  const sendMagicLink = useCallback(async (email: string): Promise<MagicLinkResult> => {
    await ready.promise;
    const controller = controllerRef.current;
    if (!controller) return { ok: false, problem: "email-sign-in-disabled" };
    return controller.sendMagicLink(email, window.location.origin);
  }, [ready]);

  const completeSignIn = useCallback(async (link: Extract<ConfirmLink, { kind: "token-hash" | "code" }>): Promise<FinishSignInResult> => {
    await ready.promise;
    const controller = controllerRef.current;
    if (!controller) return { ok: false, problem: "email-sign-in-disabled" };
    return controller.completeSignIn(link);
  }, [ready]);

  const signOut = useCallback(async (): Promise<SignOutResult> => {
    await ready.promise;
    const controller = controllerRef.current;
    if (!controller) return { ok: true };
    return controller.signOut();
  }, [ready]);

  return (
    <AuthContext.Provider value={{ auth, sendMagicLink, completeSignIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
