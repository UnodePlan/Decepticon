"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  HTML_LANG,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  translate,
  type Locale,
  type TranslationKey,
  type TranslationParams,
} from "./i18n";

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, params?: TranslationParams) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function persistLocale(locale: Locale): void {
  // Cookie is authoritative (the server component reads it on the next
  // request); localStorage keeps the choice when cookies are cleared.
  document.cookie = `${LOCALE_STORAGE_KEY}=${locale}; path=/; max-age=31536000; SameSite=Lax`;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Private mode / storage disabled — the cookie alone is enough.
  }
}

function storedLocale(): string | null {
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function I18nProvider({
  initialLocale,
  children,
}: {
  /** Raw value from the server (cookie or DECEPTICON_LANGUAGE); normalized here. */
  initialLocale?: string | null;
  children: ReactNode;
}): ReactNode {
  const [locale, setLocaleState] = useState<Locale>(() => normalizeLocale(initialLocale));

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    persistLocale(next);
  }, []);

  // Hydration-safe recovery: when the cookie is gone but a previous choice
  // survives in localStorage, adopt it without re-rendering the server HTML.
  useEffect(() => {
    const hasCookie = document.cookie
      .split("; ")
      .some((entry) => entry.startsWith(`${LOCALE_STORAGE_KEY}=`));
    if (hasCookie) return;
    const stored = storedLocale();
    if (stored && normalizeLocale(stored) !== locale) setLocale(normalizeLocale(stored));
  }, [locale, setLocale]);

  // Keep multiple open tabs on the same language.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== LOCALE_STORAGE_KEY || !event.newValue) return;
      setLocaleState(normalizeLocale(event.newValue));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    document.documentElement.lang = HTML_LANG[locale];
  }, [locale]);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: (key, params) => translate(locale, key, params),
    }),
    [locale, setLocale]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new TypeError("Translations require I18nProvider");
  return value;
}
