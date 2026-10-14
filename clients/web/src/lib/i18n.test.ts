import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_STORAGE_KEY,
  dictionaries,
  hasTranslation,
  normalizeLocale,
  severityLabel,
  statusLabel,
  translate,
  type TranslationKey,
} from "./i18n";

test("locale normalization accepts Chinese variants and rejects unknown values", () => {
  assert.equal(normalizeLocale("zh"), "zh");
  assert.equal(normalizeLocale("zh-CN"), "zh");
  assert.equal(normalizeLocale("zh_TW"), "zh");
  assert.equal(normalizeLocale("  ZH-hans "), "zh");
  assert.equal(normalizeLocale("en"), "en");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("fr"), DEFAULT_LOCALE);
  assert.equal(normalizeLocale(""), DEFAULT_LOCALE);
  assert.equal(normalizeLocale(null), DEFAULT_LOCALE);
  assert.equal(normalizeLocale(undefined), DEFAULT_LOCALE);
  assert.equal(LOCALE_STORAGE_KEY, "decepticon_lang");
});

test("every locale exposes the complete English key set with non-empty zh copy", () => {
  const enKeys = Object.keys(dictionaries.en).sort();
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(dictionaries[locale]).sort(), enKeys, locale);
    for (const key of enKeys) {
      const value = (dictionaries[locale] as Record<string, string>)[key];
      assert.equal(typeof value, "string");
      assert.ok(value.trim().length > 0, `${locale}:${key}`);
    }
  }
});

test("translation falls back to English and then to the raw key", () => {
  assert.equal(translate("en", "nav.dashboard"), "Dashboard");
  assert.equal(translate("zh", "nav.dashboard"), "仪表盘");
  // Chinese must not silently echo English for a key that has copy.
  assert.notEqual(translate("zh", "dashboard.title"), translate("en", "dashboard.title"));
  assert.equal(translate("zh", "nav.dashboard.unknown" as TranslationKey), "nav.dashboard.unknown");
});

test("interpolation substitutes known params and leaves unknown placeholders intact", () => {
  assert.equal(translate("en", "settings.agents.subtitle", { count: 7 }), "7 agents registered");
  assert.equal(translate("zh", "settings.agents.subtitle", { count: 7 }), "已注册 7 个智能体");
  assert.equal(
    translate("en", "settings.agents.subtitle"),
    "{count} agents registered"
  );
  assert.equal(translate("en", "settings.agents.subtitle", { other: 1 }), "{count} agents registered");
});

test("severity and status labels localize API values without leaking keys", () => {
  assert.equal(severityLabel("zh", "critical"), "严重");
  assert.equal(severityLabel("en", "CRITICAL"), "Critical");
  assert.equal(severityLabel("zh", "informational"), "提示");
  assert.equal(statusLabel("zh", "running"), "运行中");
  assert.equal(statusLabel("en", "Completed"), "Completed");
  // Unknown enum members pass through untouched.
  assert.equal(severityLabel("zh", "catastrophic"), "catastrophic");
  assert.equal(statusLabel("zh", "paused"), "paused");
  assert.ok(hasTranslation("zh", "severity.high"));
  assert.ok(!hasTranslation("zh", "severity.nope"));
});
