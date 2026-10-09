import React from "react";
import { resolveStrategy } from "../ladder";
import type { CapabilityContext, FeatureKey, StrategyResolution } from "../types";

export interface CapabilityGateProps {
  feature: FeatureKey;
  context?: CapabilityContext;
  children: React.ReactNode | ((resolution: StrategyResolution) => React.ReactNode);
  fallback?: React.ReactNode | ((resolution: StrategyResolution) => React.ReactNode);
}

export function CapabilityGate({
  feature,
  context = {},
  children,
  fallback,
}: CapabilityGateProps) {
  const resolution = resolveStrategy(feature, context);

  if (resolution.strategy === "unavailable") {
    if (typeof fallback === "function") {
      return <>{fallback(resolution)}</>;
    }
    return (
      fallback ?? (
        <div className="rounded border border-dashed border-zinc-300 p-4 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          <p className="font-medium">Feature currently unavailable</p>
          <p className="mt-1 text-xs">{resolution.reason}</p>
        </div>
      )
    );
  }

  if (typeof children === "function") {
    return <>{children(resolution)}</>;
  }

  return <>{children}</>;
}
