import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Compact relative time ("3s", "5m", "2h", "4d") for a past epoch-ms timestamp,
 * used by the pipeline item list. Falls back to an empty string for nullish input.
 */
export function relativeTime(ts: number | null | undefined): string {
	if (ts == null) return '';
	const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (secs < 60) return `${secs}s`;
	const mins = Math.round(secs / 60);
	if (mins < 60) return `${mins}m`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, "child"> : T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, "children"> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
