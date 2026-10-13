"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * `false` for the server render AND for the hydrating client render, `true`
 * afterwards. Gate anything that exists only in the browser (localStorage,
 * matchMedia, …) behind it: the first client render then matches the server
 * HTML exactly, and React re-renders with the real data right after hydration.
 * Reading browser-only state directly during render makes a returning user's
 * data differ from the server HTML (React error #418).
 */
export function useMounted(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
