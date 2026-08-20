import { describe, expect, it } from "vite-plus/test";

import {
  LOCALE_METADATA,
  UPSTREAM_LOCALE_RESOURCE_PATHS,
  UPSTREAM_LOCALE_IDS,
  createLocalization,
  resolveLocale,
} from "../src/renderer/localization.ts";

describe("renderer localization catalog", () => {
  it("contains every upstream locale resource exactly once", () => {
    expect(UPSTREAM_LOCALE_IDS).toHaveLength(23);
    expect(new Set(UPSTREAM_LOCALE_IDS).size).toBe(23);
    for (const locale of UPSTREAM_LOCALE_IDS) {
      expect(LOCALE_METADATA[locale].id).toBe(locale);
      expect(LOCALE_METADATA[locale].nativeName.length).toBeGreaterThan(0);
      expect(UPSTREAM_LOCALE_RESOURCE_PATHS[locale]).toContain(
        `/Resources/${locale}.lproj/Localizable.strings`,
      );
    }
  });

  it("resolves exact tags, language bases, and English fallback", () => {
    expect(resolveLocale("pt-BR")).toBe("pt-BR");
    expect(resolveLocale("pt-BR-x-private")).toBe("pt-BR");
    expect(resolveLocale("pt")).toBe("pt-BR");
    expect(resolveLocale("zh-hant-TW")).toBe("zh-Hant");
    expect(resolveLocale("zh-TW")).toBe("zh-Hant");
    expect(resolveLocale("zh-CN")).toBe("zh-Hans");
    expect(resolveLocale("de-DE")).toBe("de");
    expect(resolveLocale("system", ["xx-YY", "fr-CA"])).toBe("fr");
    expect(resolveLocale("system", [])).toBe("en");
  });

  it("uses upstream directionality for Arabic and Persian", () => {
    expect(createLocalization("ar").direction).toBe("rtl");
    expect(createLocalization("fa").direction).toBe("rtl");
    expect(createLocalization("he").direction).toBe("ltr");
    expect(createLocalization("ar").locale).toBe("ar");
  });

  it("pluralizes provider summaries through Intl.PluralRules", () => {
    const english = createLocalization("en");
    expect(english.providerSummary(1, 16)).toBe("1 of 16 provider in the first slice.");
    expect(english.providerSummary(2, 16)).toBe("2 of 16 providers in the first slice.");

    const portuguese = createLocalization("pt-BR");
    expect(portuguese.providerSummary(1, 16)).toBe("1 de 16 provider no primeiro corte.");
    expect(portuguese.providerSummary(2, 16)).toBe("2 de 16 providers no primeiro corte.");
  });

  it("falls back missing translations to the English source copy", () => {
    const german = createLocalization("de");
    expect(german.t("platform")).toBe("TypeScript");
    expect(german.t("usageOverview")).toBe("NUTZUNGSÜBERSICHT");
  });
});
