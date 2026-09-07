"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Incorrect email or password");
        setLoading(false);
        return;
      }
      const next = searchParams.get("next") || "/";
      router.push(next);
      router.refresh();
    } catch {
      setError("Something went wrong — try again.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#faf5f1] px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm bg-white border border-[#e7dcd4] rounded-xl shadow-sm p-8"
      >
        <p className="text-xs font-semibold tracking-wide uppercase text-[#7a2e40] mb-2">
          Isaac Wellness
        </p>
        <h1 className="text-2xl font-serif text-[#2a211d] mb-6">Due Invoices Dashboard</h1>
        <label htmlFor="email" className="block text-sm text-[#7a685e] mb-2">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoFocus
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@isaac-wellness.com"
          className="w-full border border-[#e7dcd4] rounded-lg px-3 py-2 text-[#2a211d] focus:outline-none focus:ring-2 focus:ring-[#7a2e40] focus:border-transparent mb-4"
        />
        <label htmlFor="password" className="block text-sm text-[#7a685e] mb-2">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full border border-[#e7dcd4] rounded-lg px-3 py-2 text-[#2a211d] focus:outline-none focus:ring-2 focus:ring-[#7a2e40] focus:border-transparent mb-4"
        />
        {error && <p className="text-sm text-[#b23b3b] mb-4">{error}</p>}
        <button
          type="submit"
          disabled={loading || !email || !password}
          className="w-full bg-[#7a2e40] text-white rounded-lg py-2.5 font-medium disabled:opacity-50 hover:bg-[#671f30] transition-colors"
        >
          {loading ? "Checking…" : "View dashboard"}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
