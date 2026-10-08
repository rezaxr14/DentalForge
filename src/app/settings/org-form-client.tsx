"use client";

/** Org creation form: name + slug → Better Auth `organization.create`. */
import { useState } from "react";
import { authClient } from "@/shared/auth/client";

export default function OrgFormClient() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await authClient.organization.create({ name, slug });
      if (res.error) {
        setError(res.error.message ?? "create failed");
      } else {
        window.location.reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-2 flex max-w-md flex-wrap items-end gap-2">
      <label className="text-sm">
        <span className="mb-1 block font-medium">Name</span>
        <input
          required
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slug) setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
          }}
          className="rounded-md border border-input bg-card px-3 py-1.5 text-foreground"
        />
      </label>
      <label className="text-sm">
        <span className="mb-1 block font-medium">Slug</span>
        <input
          required
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          className="rounded-md border border-input bg-card px-3 py-1.5 text-foreground"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {pending ? "Creating…" : "Create"}
      </button>
      {error ? (
        <p role="alert" className="w-full text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </form>
  );
}
