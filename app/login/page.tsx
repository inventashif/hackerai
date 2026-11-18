"use client";

import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { HackerAISVG } from "@/components/icons/hackerai-svg";
import { Loader2, AlertCircle, Mail, Lock } from "lucide-react";
import { useState } from "react";

export const runtime = "nodejs";

function DecoyLoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [attempts, setAttempts] = useState(0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 1500 + Math.random() * 1000));

    const newAttempts = attempts + 1;
    setAttempts(newAttempts);

    // Always fail with varying error messages
    const errors = [
      "Invalid email or password. Please try again.",
      "Account not found. Please check your credentials.",
      "Too many failed attempts. Please wait before trying again.",
      "Authentication service temporarily unavailable.",
      "Invalid credentials. Access denied.",
    ];
    setError(errors[Math.floor(Math.random() * errors.length)]);
    setLoading(false);
    setPassword("");
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <div className="relative">
          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
            className="pl-10"
            required
            autoComplete="email"
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <a
            href="#"
            className="text-sm text-primary hover:underline"
            onClick={(e: React.MouseEvent) => e.preventDefault()}
          >
            Forgot password?
          </a>
        </div>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            id="password"
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            className="pl-10"
            required
            autoComplete="current-password"
          />
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-3 rounded-lg">
          <AlertCircle className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <Button type="submit" className="w-full" disabled={loading} size="lg">
        {loading ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin" />
            Signing in...
          </>
        ) : (
          "Sign in"
        )}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Don't have an account?{" "}
        <a href="/signup" className="text-primary hover:underline underline-offset-2">
          Sign up
        </a>
      </p>

      {attempts >= 3 && (
        <p className="text-center text-xs text-muted-foreground">
          Having trouble? Contact support.
        </p>
      )}
    </form>
  );
}

export default function DecoyLoginPage() {
  return (
    <main className="bg-background text-foreground flex min-h-dvh items-center justify-center px-5 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <HackerAISVG theme="dark" scale={0.15} />
        </div>

        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-semibold">Sign in to HackerAI</CardTitle>
            <CardDescription>
              Enter your credentials to access your account
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<div className="h-32 flex items-center justify-center"><Loader2 className="size-8 animate-spin text-muted-foreground" /></div>}>
              <DecoyLoginForm />
            </Suspense>
          </CardContent>
          <CardFooter className="flex flex-col gap-4">
            <p className="text-xs text-center text-muted-foreground">
              By signing in, you agree to our{" "}
              <a href="/terms-of-service" className="underline hover:text-foreground">Terms of Service</a>{" "}
              and{" "}
              <a href="/privacy-policy" className="underline hover:text-foreground">Privacy Policy</a>
            </p>
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}