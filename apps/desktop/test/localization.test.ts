import { describe, expect, it } from "vite-plus/test";

import {
  LOCALE_METADATA,
  UPSTREAM_CATALOGS,
  UPSTREAM_LOCALE_RESOURCE_PATHS,
  UPSTREAM_LOCALE_IDS,
  createLocalization,
  resolveLocale,
  translateUpstream,
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

  it("ships the complete generated upstream catalogs", () => {
    const englishKeys = Object.keys(UPSTREAM_CATALOGS.en.messages).sort();
    expect(englishKeys).toHaveLength(1445);
    expect(Object.keys(UPSTREAM_CATALOGS.en.plurals)).toHaveLength(2);
    expect(Object.keys(UPSTREAM_CATALOGS.en.plurals).sort()).toEqual([
      "Weekly can run out ≈%d windows early",
      "≈%d full 5h windows of weekly left · %d windows until reset",
    ]);
    for (const locale of UPSTREAM_LOCALE_IDS) {
      const catalog = UPSTREAM_CATALOGS[locale];
      expect(catalog.source).toBe(UPSTREAM_LOCALE_RESOURCE_PATHS[locale]);
      expect(Object.keys(catalog.messages).length).toBeGreaterThanOrEqual(englishKeys.length);
      expect(Object.keys(catalog.plurals)).toHaveLength(2);
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

  it("resolves upstream strings and stringsdict values", () => {
    expect(translateUpstream("en", "About")).toBe("About");
    expect(translateUpstream("de", "About")).toBe("Über");
    const key = "≈%d full 5h windows of weekly left · %d windows until reset";
    expect(translateUpstream("en", key, { left: 1, until: 2 })).toBe(
      "≈1 full 5h window of weekly left · 2 windows until reset",
    );
    expect(createLocalization("en").upstream("About")).toBe("About");
  });

  it("falls back missing translations to the English source copy", () => {
    const german = createLocalization("de");
    expect(german.t("platform")).toBe("TypeScript");
    expect(german.t("usageOverview")).toBe("NUTZUNGSÜBERSICHT");
  });
});
