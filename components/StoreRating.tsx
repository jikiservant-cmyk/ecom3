"use client";

import { useEffect, useState } from "react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";

interface StoreRating {
  id: string;
  userName: string;
  rating: number;
  comment: string;
  createdAt: string;
}

/**
 * "Rate your experience" — customers rate the shop itself.
 *
 * Only a customer with at least one PAID order can submit; the API and a
 * database trigger both enforce that, so the UI merely explains the rule.
 * Each customer gets exactly one rating (they can revise it, not spam it).
 */
export default function StoreRating() {
  const [ratings, setRatings] = useState<StoreRating[]>([]);
  const [average, setAverage] = useState(0);
  const [count, setCount] = useState(0);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<"ok" | "err">("ok");
  const [signedIn, setSignedIn] = useState(false);

  const load = async () => {
    try {
      const res = await fetch("/api/store-rating");
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        setRatings(data.ratings || []);
        setAverage(data.average || 0);
        setCount(data.count || 0);
      }
    } catch {
      // A missing rating list is not worth interrupting the shopper for.
    }
  };

  useEffect(() => {
    let active = true;

    // setState only ever happens inside these async callbacks, never
    // synchronously in the effect body.
    fetch("/api/store-rating")
      .then((res) => res.json())
      .then((data) => {
        if (!active || !data?.success) return;
        setRatings(data.ratings || []);
        setAverage(data.average || 0);
        setCount(data.count || 0);
      })
      .catch(() => {
        // A missing rating list is not worth interrupting the shopper for.
      });

    if (!isSupabaseConfigured) return () => { active = false; };

    supabase.auth.getSession().then(({ data }) => {
      if (active) setSignedIn(Boolean(data?.session?.user));
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setSignedIn(Boolean(session?.user));
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token || null;
      if (!token) {
        setMessageKind("err");
        setMessage("Please sign in to rate the store.");
        return;
      }
      const res = await fetch("/api/store-rating", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ rating, comment: comment.trim() || undefined }),
      });
      const data2 = await res.json().catch(() => null);
      if (!res.ok || !data2?.success) {
        setMessageKind("err");
        setMessage(data2?.error || "Could not save your rating.");
        return;
      }
      setMessageKind("ok");
      setMessage("Thank you! Your rating has been saved.");
      setComment("");
      await load();
    } catch {
      setMessageKind("err");
      setMessage("Could not save your rating.");
    } finally {
      setBusy(false);
    }
  };

  const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);

  return (
    <section id="rate-us" className="py-16 px-4 bg-slate-50 dark:bg-slate-950">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-8">
          <h2 className="text-3xl font-black text-slate-900 dark:text-white">Rate your experience</h2>
          <p className="text-slate-500 dark:text-slate-400 mt-2 text-sm">
            Bought from us? Tell everyone how it went.
          </p>
          {count > 0 && (
            <div className="mt-3 text-2xl font-black text-[var(--accent)]">
              {average.toFixed(1)} <span className="text-lg">{stars(Math.round(average))}</span>
              <span className="text-xs font-bold text-slate-400 ml-2">({count} {count === 1 ? "rating" : "ratings"})</span>
            </div>
          )}
        </div>

        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
          {!signedIn ? (
            <p className="text-sm text-slate-500 dark:text-slate-400 text-center">
              Sign in and complete a purchase to rate the store. We only accept ratings from paying
              customers, so the score you see here is real.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-4">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300">Your score:</span>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      onClick={() => setRating(n)}
                      aria-label={`${n} star${n === 1 ? "" : "s"}`}
                      className={`text-2xl leading-none transition ${n <= rating ? "text-[var(--accent)]" : "text-slate-300 dark:text-slate-700"}`}
                    >
                      ★
                    </button>
                  ))}
                </div>
              </div>

              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value.slice(0, 2000))}
                placeholder="How was your order? (optional)"
                rows={3}
                className="w-full p-3 text-sm rounded-xl border border-slate-200 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 dark:bg-slate-800 dark:border-slate-700"
              />

              <button
                onClick={submit}
                disabled={busy}
                className="mt-3 w-full py-2.5 rounded-xl bg-[var(--accent)] text-white font-bold text-sm hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Submit rating"}
              </button>

              <p className="text-[11px] text-slate-400 mt-2 text-center">
                One rating per customer — you can update it any time. Available once an order has been paid.
              </p>
            </>
          )}

          {message && (
            <div className={`mt-3 text-xs font-bold text-center ${messageKind === "ok" ? "text-emerald-600" : "text-rose-600"}`}>
              {message}
            </div>
          )}
        </div>

        {ratings.length > 0 && (
          <div className="mt-6 space-y-3">
            {ratings.slice(0, 5).map((r) => (
              <div key={r.id} className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-4">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-sm text-slate-900 dark:text-white">{r.userName}</span>
                  <span className="text-[var(--accent)] text-sm font-bold">{stars(r.rating)}</span>
                </div>
                {r.comment && <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">{r.comment}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
