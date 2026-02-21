"use client";

import { FormEvent, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Status = "idle" | "loading" | "success" | "error";

export default function LoginForm() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorText, setErrorText] = useState("");
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetStatus, setResetStatus] = useState<Status>("idle");
  const [resetError, setResetError] = useState("");
  const searchParams = useSearchParams();

  const callbackError = useMemo(() => {
    const raw = searchParams.get("error");

    if (!raw) {
      return null;
    }

    switch (raw) {
      case "missing_code":
        return "Reset link is missing the auth code. Request a new reset link.";
      case "callback_failed":
        return "Reset link expired or is invalid. Request a new reset link.";
      case "session_missing":
        return "Could not establish a session. Sign in again.";
      default:
        return "Authentication failed. Try signing in again.";
    }
  }, [searchParams]);

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus("loading");
    setErrorText("");

    try {
      const normalizedIdentifier = identifier.trim();
      if (!normalizedIdentifier || !password) {
        setStatus("error");
        setErrorText("User ID or email and password are required.");
        return;
      }

      const supabase = createClient();
      if (normalizedIdentifier.includes("@")) {
        const { error } = await supabase.auth.signInWithPassword({
          email: normalizedIdentifier,
          password
        });

        if (error) {
          setStatus("error");
          setErrorText(error.message);
          return;
        }

        window.location.assign("/login");
        return;
      }

      const response = await fetch("/api/auth/login-by-id", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          user_id: normalizedIdentifier,
          password
        }),
        credentials: "same-origin"
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        redirectTo?: string;
      };

      if (!response.ok || !payload.ok) {
        setStatus("error");
        setErrorText(payload.error ?? "Sign in failed.");
        return;
      }

      window.location.assign(payload.redirectTo ?? "/login");
    } catch (error) {
      setStatus("error");
      setErrorText(
        error instanceof Error ? error.message : "Unexpected error while signing in."
      );
    }
  };

  const handleForgotPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setResetStatus("loading");
    setResetError("");

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.resetPasswordForEmail(
        resetEmail.trim(),
        {
          redirectTo: `${window.location.origin}/auth/callback`
        }
      );

      if (error) {
        setResetStatus("error");
        setResetError(error.message);
        return;
      }

      setResetStatus("success");
    } catch (error) {
      setResetStatus("error");
      setResetError(
        error instanceof Error
          ? error.message
          : "Unexpected error while requesting password reset."
      );
    }
  };

  return (
    <>
      <form onSubmit={handleLogin} className="form-stack">
        <input
          type="text"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          placeholder="User ID or Email"
          className="text-input"
          autoComplete="username"
          required
        />
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          className="text-input"
          autoComplete="current-password"
          required
        />
        <button
          type="submit"
          className="button button-primary"
          disabled={status === "loading"}
        >
          {status === "loading" ? "Signing in..." : "Sign in"}
        </button>
      </form>

      <button
        type="button"
        className="link-button"
        onClick={() => {
          setShowForgotPassword((current) => !current);
          setResetError("");
        }}
      >
        Forgot password?
      </button>

      {showForgotPassword ? (
        <form onSubmit={handleForgotPassword} className="form-stack">
          <input
            type="email"
            value={resetEmail}
            onChange={(event) => setResetEmail(event.target.value)}
            placeholder="Email for reset"
            className="text-input"
            autoComplete="email"
            required
          />
          <button
            type="submit"
            className="button button-secondary"
            disabled={resetStatus === "loading"}
          >
            {resetStatus === "loading" ? "Sending..." : "Send reset link"}
          </button>
        </form>
      ) : null}

      {callbackError ? (
        <div className="message message-error" role="alert">
          {callbackError}
        </div>
      ) : null}

      {status === "error" ? (
        <div className="message message-error" role="alert">
          {errorText}
        </div>
      ) : null}

      {resetStatus === "success" ? (
        <div className="message message-success" role="status">
          Check your email for reset link.
        </div>
      ) : null}

      {resetStatus === "error" ? (
        <div className="message message-error" role="alert">
          {resetError}
        </div>
      ) : null}
    </>
  );
}
