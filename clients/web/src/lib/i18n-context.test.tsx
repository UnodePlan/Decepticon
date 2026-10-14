import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider, useI18n } from "./i18n-context";
import { LOCALE_STORAGE_KEY } from "./i18n";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (html: string, options?: { url?: string }) => { window: Window & typeof globalThis };
};

function Probe(): React.ReactNode {
  const { locale, setLocale, t } = useI18n();
  return (
    <div>
      <span id="locale">{locale}</span>
      <span id="label">{t("nav.dashboard")}</span>
      <span id="count">{t("settings.agents.subtitle", { count: 3 })}</span>
      <button id="switch" type="button" onClick={() => setLocale("zh")}>
        switch
      </button>
    </div>
  );
}

test("provider serves the initial locale during server rendering", () => {
  const html = renderToStaticMarkup(
    <I18nProvider initialLocale="zh-CN"><Probe /></I18nProvider>
  );
  for (const expected of ["zh", "仪表盘", "已注册 3 个智能体"])
    assert.ok(html.includes(expected), expected);
  // Unsupported / missing input falls back to English.
  assert.ok(
    renderToStaticMarkup(<I18nProvider><Probe /></I18nProvider>).includes("Dashboard")
  );
});

test("translation hook fails loudly outside the provider", () => {
  assert.throws(() => renderToStaticMarkup(<Probe />), /I18nProvider/);
});

test("switching locale re-renders, persists the cookie and updates the document language", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://console.example.test/",
  });
  const globals = ["window", "document", "navigator"] as const;
  const prior = globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "window" ? dom.window : dom.window[key],
    });
  }
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const priorAct = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;

  try {
    const container = dom.window.document.getElementById("root") as HTMLElement;
    const root = createRoot(container);

    await act(async () => {
      root.render(<I18nProvider initialLocale="en"><Probe /></I18nProvider>);
    });
    assert.equal(container.querySelector("#label")?.textContent, "Dashboard");
    assert.equal(dom.window.document.documentElement.lang, "en");
    assert.equal(dom.window.document.cookie, "");

    const switcher = container.querySelector<HTMLButtonElement>("#switch");
    await act(async () => {
      switcher?.click();
    });
    assert.equal(container.querySelector("#locale")?.textContent, "zh");
    assert.equal(container.querySelector("#label")?.textContent, "仪表盘");
    assert.equal(container.querySelector("#count")?.textContent, "已注册 3 个智能体");
    assert.equal(dom.window.document.documentElement.lang, "zh-CN");
    assert.match(dom.window.document.cookie, new RegExp(`${LOCALE_STORAGE_KEY}=zh($|;)`));
    assert.equal(dom.window.localStorage.getItem(LOCALE_STORAGE_KEY), "zh");

    await act(async () => {
      root.unmount();
    });
  } finally {
    environment.IS_REACT_ACT_ENVIRONMENT = priorAct;
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
