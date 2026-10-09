import type { WorkerStatus } from "../types";

export interface WorkerStatusPillProps {
  status: WorkerStatus;
  declaredCapabilities?: string[];
  lastSeenText?: string;
  className?: string;
}

export function WorkerStatusPill({
  status,
  declaredCapabilities,
  lastSeenText,
  className = "",
}: WorkerStatusPillProps) {
  const dotColor =
    status === "online"
      ? "bg-emerald-500"
      : status === "degraded"
        ? "bg-amber-500"
        : "bg-zinc-400";

  const textColor =
    status === "online"
      ? "text-emerald-700 dark:text-emerald-400"
      : status === "degraded"
        ? "text-amber-700 dark:text-amber-400"
        : "text-zinc-600 dark:text-zinc-400";

  const title = [
    `Worker status: ${status}`,
    lastSeenText ? `Last seen: ${lastSeenText}` : null,
    declaredCapabilities && declaredCapabilities.length > 0
      ? `Capabilities: ${declaredCapabilities.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join(" • ");

  return (
    <div
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-0.5 text-xs font-medium shadow-xs dark:border-zinc-800 dark:bg-zinc-900 ${textColor} ${className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
      <span className="capitalize">Worker: {status}</span>
    </div>
  );
}
