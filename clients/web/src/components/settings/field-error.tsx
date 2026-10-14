"use client";

/** Inline, field-level validation message shared by the settings cards. */
export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}
