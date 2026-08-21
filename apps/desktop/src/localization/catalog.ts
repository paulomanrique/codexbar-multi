/**
 * Shared desktop localization catalog for the TypeScript slice.
 *
 * This module deliberately has no React, Electron, or Node dependency. The
 * locale IDs and native labels mirror the upstream AppLanguage catalog. The
 * generated JSON catalogs are a lossless, reviewable representation of the
 * Swift .strings/.stringsdict resources and remain keyed by upstream copy.
 * It is intentionally safe for both Electron main and the React renderer.
 */

import ar from "./locales/ar.json" with { type: "json" };
import ca from "./locales/ca.json" with { type: "json" };
import de from "./locales/de.json" with { type: "json" };
import en from "./locales/en.json" with { type: "json" };
import es from "./locales/es.json" with { type: "json" };
import fa from "./locales/fa.json" with { type: "json" };
import fr from "./locales/fr.json" with { type: "json" };
import gl from "./locales/gl.json" with { type: "json" };
import id from "./locales/id.json" with { type: "json" };
import it from "./locales/it.json" with { type: "json" };
import ja from "./locales/ja.json" with { type: "json" };
import ko from "./locales/ko.json" with { type: "json" };
import nl from "./locales/nl.json" with { type: "json" };
import pl from "./locales/pl.json" with { type: "json" };
import ptBR from "./locales/pt-BR.json" with { type: "json" };
import ru from "./locales/ru.json" with { type: "json" };
import sv from "./locales/sv.json" with { type: "json" };
import th from "./locales/th.json" with { type: "json" };
import tr from "./locales/tr.json" with { type: "json" };
import uk from "./locales/uk.json" with { type: "json" };
import vi from "./locales/vi.json" with { type: "json" };
import zhHans from "./locales/zh-Hans.json" with { type: "json" };
import zhHant from "./locales/zh-Hant.json" with { type: "json" };

export interface PluralCatalog {
  readonly format: string;
  readonly variables: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface LocaleCatalog {
  readonly source: string;
  readonly messages: Readonly<Record<string, string>>;
  readonly plurals: Readonly<Record<string, PluralCatalog>>;
}

export const UPSTREAM_CATALOGS: Readonly<Record<LocaleId, LocaleCatalog>> = {
  ar,
  ca,
  de,
  en,
  es,
  fa,
  fr,
  gl,
  id,
  it,
  ja,
  ko,
  nl,
  pl,
  "pt-BR": ptBR,
  ru,
  sv,
  th,
  tr,
  uk,
  vi,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
};

export const UPSTREAM_LOCALE_IDS = [
  "en",
  "de",
  "es",
  "ca",
  "zh-Hans",
  "zh-Hant",
  "pt-BR",
  "sv",
  "fr",
  "nl",
  "uk",
  "ru",
  "it",
  "vi",
  "ja",
  "ko",
  "tr",
  "id",
  "pl",
  "ar",
  "fa",
  "th",
  "gl",
] as const;

export type LocaleId = (typeof UPSTREAM_LOCALE_IDS)[number];
export type LocalePreference = LocaleId | "system" | (string & {});
export type TextDirection = "ltr" | "rtl";

/** Source locations kept beside the port for semantic upstream review. */
export const UPSTREAM_LOCALE_RESOURCE_PATHS = {
  en: "Sources/CodexBar/Resources/en.lproj/Localizable.strings",
  de: "Sources/CodexBar/Resources/de.lproj/Localizable.strings",
  es: "Sources/CodexBar/Resources/es.lproj/Localizable.strings",
  ca: "Sources/CodexBar/Resources/ca.lproj/Localizable.strings",
  "zh-Hans": "Sources/CodexBar/Resources/zh-Hans.lproj/Localizable.strings",
  "zh-Hant": "Sources/CodexBar/Resources/zh-Hant.lproj/Localizable.strings",
  "pt-BR": "Sources/CodexBar/Resources/pt-BR.lproj/Localizable.strings",
  sv: "Sources/CodexBar/Resources/sv.lproj/Localizable.strings",
  fr: "Sources/CodexBar/Resources/fr.lproj/Localizable.strings",
  nl: "Sources/CodexBar/Resources/nl.lproj/Localizable.strings",
  uk: "Sources/CodexBar/Resources/uk.lproj/Localizable.strings",
  ru: "Sources/CodexBar/Resources/ru.lproj/Localizable.strings",
  it: "Sources/CodexBar/Resources/it.lproj/Localizable.strings",
  vi: "Sources/CodexBar/Resources/vi.lproj/Localizable.strings",
  ja: "Sources/CodexBar/Resources/ja.lproj/Localizable.strings",
  ko: "Sources/CodexBar/Resources/ko.lproj/Localizable.strings",
  tr: "Sources/CodexBar/Resources/tr.lproj/Localizable.strings",
  id: "Sources/CodexBar/Resources/id.lproj/Localizable.strings",
  pl: "Sources/CodexBar/Resources/pl.lproj/Localizable.strings",
  ar: "Sources/CodexBar/Resources/ar.lproj/Localizable.strings",
  fa: "Sources/CodexBar/Resources/fa.lproj/Localizable.strings",
  th: "Sources/CodexBar/Resources/th.lproj/Localizable.strings",
  gl: "Sources/CodexBar/Resources/gl.lproj/Localizable.strings",
} as const satisfies Readonly<Record<LocaleId, string>>;

export interface LocaleMetadata {
  readonly id: LocaleId;
  readonly nativeName: string;
  readonly direction: TextDirection;
}

export const LOCALE_METADATA: Readonly<Record<LocaleId, LocaleMetadata>> = {
  en: { id: "en", nativeName: "English", direction: "ltr" },
  de: { id: "de", nativeName: "Deutsch", direction: "ltr" },
  es: { id: "es", nativeName: "Español", direction: "ltr" },
  ca: { id: "ca", nativeName: "Català", direction: "ltr" },
  "zh-Hans": { id: "zh-Hans", nativeName: "简体中文", direction: "ltr" },
  "zh-Hant": { id: "zh-Hant", nativeName: "繁體中文", direction: "ltr" },
  "pt-BR": { id: "pt-BR", nativeName: "Português (Brasil)", direction: "ltr" },
  sv: { id: "sv", nativeName: "Svenska", direction: "ltr" },
  fr: { id: "fr", nativeName: "Français", direction: "ltr" },
  nl: { id: "nl", nativeName: "Nederlands", direction: "ltr" },
  uk: { id: "uk", nativeName: "Українська", direction: "ltr" },
  ru: { id: "ru", nativeName: "Русский", direction: "ltr" },
  it: { id: "it", nativeName: "Italiano", direction: "ltr" },
  vi: { id: "vi", nativeName: "Tiếng Việt", direction: "ltr" },
  ja: { id: "ja", nativeName: "日本語", direction: "ltr" },
  ko: { id: "ko", nativeName: "한국어", direction: "ltr" },
  tr: { id: "tr", nativeName: "Türkçe", direction: "ltr" },
  id: { id: "id", nativeName: "Bahasa Indonesia", direction: "ltr" },
  pl: { id: "pl", nativeName: "Polski", direction: "ltr" },
  ar: { id: "ar", nativeName: "العربية", direction: "rtl" },
  fa: { id: "fa", nativeName: "فارسی", direction: "rtl" },
  th: { id: "th", nativeName: "ไทย", direction: "ltr" },
  gl: { id: "gl", nativeName: "Galego", direction: "ltr" },
};

export type MessageKey =
  | "usageOverview"
  | "platform"
  | "loginWaiting"
  | "loginConnected"
  | "loginStart"
  | "logout"
  | "loadingProviders"
  | "ported"
  | "awaitingParity"
  | "ready"
  | "queued"
  | (string & {});

export interface ProviderSummaryMessages {
  readonly one: string;
  readonly other: string;
}

export interface MessageBundle {
  readonly usageOverview: string;
  readonly platform: string;
  readonly loginWaiting: string;
  readonly loginConnected: string;
  readonly loginStart: string;
  readonly logout: string;
  readonly loadingProviders: string;
  readonly providerSummary: ProviderSummaryMessages;
  readonly ported: string;
  readonly awaitingParity: string;
  readonly ready: string;
  readonly queued: string;
}

const ENGLISH_MESSAGES: MessageBundle = {
  usageOverview: "USAGE OVERVIEW",
  platform: "TypeScript",
  loginWaiting: "Waiting for login…",
  loginConnected: "T3 Chat connected",
  loginStart: "Sign in to T3 Chat",
  logout: "Sign out",
  loadingProviders: "Loading providers…",
  providerSummary: {
    one: "{count} of {total} provider in the first slice.",
    other: "{count} of {total} providers in the first slice.",
  },
  ported: "Ported",
  awaitingParity: "Awaiting parity",
  ready: "ready",
  queued: "queued",
};

type MessageOverrides = Partial<Omit<MessageBundle, "providerSummary">> & {
  readonly providerSummary?: Partial<ProviderSummaryMessages>;
};

/**
 * Values here are the strings visible in the current renderer. They are kept
 * separate from metadata so adding the rest of the upstream catalog does not
 * change locale resolution or the renderer API.
 */
const MESSAGE_OVERRIDES: Readonly<Partial<Record<LocaleId, MessageOverrides>>> = {
  "pt-BR": {
    usageOverview: "VISÃO GERAL DE USO",
    loginWaiting: "Aguardando login…",
    loginConnected: "T3 Chat conectado",
    loginStart: "Entrar no T3 Chat",
    logout: "Sair",
    loadingProviders: "Carregando providers…",
    providerSummary: {
      one: "{count} de {total} provider no primeiro corte.",
      other: "{count} de {total} providers no primeiro corte.",
    },
    ported: "Portado",
    awaitingParity: "Aguardando paridade",
    ready: "pronto",
    queued: "na fila",
  },
  de: {
    usageOverview: "NUTZUNGSÜBERSICHT",
    loginWaiting: "Warten auf Anmeldung…",
    loginConnected: "T3 Chat verbunden",
    loginStart: "Bei T3 Chat anmelden",
    logout: "Abmelden",
    loadingProviders: "Provider werden geladen…",
    providerSummary: {
      one: "{count} von {total} Provider im ersten Abschnitt.",
      other: "{count} von {total} Providern im ersten Abschnitt.",
    },
    ported: "Portiert",
    awaitingParity: "Parität ausstehend",
    ready: "bereit",
    queued: "wartend",
  },
  es: {
    usageOverview: "RESUMEN DE USO",
    loginWaiting: "Esperando el inicio de sesión…",
    loginConnected: "T3 Chat conectado",
    loginStart: "Iniciar sesión en T3 Chat",
    logout: "Cerrar sesión",
    loadingProviders: "Cargando proveedores…",
    providerSummary: {
      one: "{count} de {total} proveedor en el primer corte.",
      other: "{count} de {total} proveedores en el primer corte.",
    },
    ported: "Portado",
    awaitingParity: "Paridad pendiente",
    ready: "listo",
    queued: "en cola",
  },
  fr: {
    usageOverview: "VUE D’ENSEMBLE DE L’UTILISATION",
    loginWaiting: "Connexion en attente…",
    loginConnected: "T3 Chat connecté",
    loginStart: "Se connecter à T3 Chat",
    logout: "Se déconnecter",
    loadingProviders: "Chargement des fournisseurs…",
    providerSummary: {
      one: "{count} fournisseur sur {total} dans le premier lot.",
      other: "{count} fournisseurs sur {total} dans le premier lot.",
    },
    ported: "Porté",
    awaitingParity: "Parité en attente",
    ready: "prêt",
    queued: "en attente",
  },
  ja: {
    usageOverview: "使用状況の概要",
    loginWaiting: "ログインを待っています…",
    loginConnected: "T3 Chat に接続しました",
    loginStart: "T3 Chat にログイン",
    logout: "ログアウト",
    loadingProviders: "プロバイダーを読み込み中…",
    providerSummary: {
      one: "最初のスライス: {total} 件中 {count} 件のプロバイダー。",
      other: "最初のスライス: {total} 件中 {count} 件のプロバイダー。",
    },
    ported: "移植済み",
    awaitingParity: "パリティ待ち",
    ready: "準備完了",
    queued: "待機中",
  },
  "zh-Hans": {
    usageOverview: "使用情况概览",
    loginWaiting: "正在等待登录…",
    loginConnected: "T3 Chat 已连接",
    loginStart: "登录 T3 Chat",
    logout: "退出登录",
    loadingProviders: "正在加载提供商…",
    providerSummary: {
      one: "首个切片中有 {total} 个提供商，已移植 {count} 个。",
      other: "首个切片中有 {total} 个提供商，已移植 {count} 个。",
    },
    ported: "已移植",
    awaitingParity: "等待达到一致",
    ready: "就绪",
    queued: "排队中",
  },
  "zh-Hant": {
    usageOverview: "使用狀況總覽",
    loginWaiting: "正在等待登入…",
    loginConnected: "T3 Chat 已連線",
    loginStart: "登入 T3 Chat",
    logout: "登出",
    loadingProviders: "正在載入提供者…",
    providerSummary: {
      one: "首個切片中有 {total} 個提供者，已移植 {count} 個。",
      other: "首個切片中有 {total} 個提供者，已移植 {count} 個。",
    },
    ported: "已移植",
    awaitingParity: "等待達到一致",
    ready: "就緒",
    queued: "排隊中",
  },
  ru: {
    usageOverview: "ОБЗОР ИСПОЛЬЗОВАНИЯ",
    loginWaiting: "Ожидание входа…",
    loginConnected: "T3 Chat подключён",
    loginStart: "Войти в T3 Chat",
    logout: "Выйти",
    loadingProviders: "Загрузка провайдеров…",
    providerSummary: {
      one: "В первом срезе: {count} из {total} провайдера.",
      other: "В первом срезе: {count} из {total} провайдеров.",
    },
    ported: "Перенесён",
    awaitingParity: "Ожидается паритет",
    ready: "готов",
    queued: "в очереди",
  },
  uk: {
    usageOverview: "ОГЛЯД ВИКОРИСТАННЯ",
    loginWaiting: "Очікування входу…",
    loginConnected: "T3 Chat підключено",
    loginStart: "Увійти в T3 Chat",
    logout: "Вийти",
    loadingProviders: "Завантаження провайдерів…",
    providerSummary: {
      one: "У першому зрізі: {count} із {total} провайдера.",
      other: "У першому зрізі: {count} із {total} провайдерів.",
    },
    ported: "Портовано",
    awaitingParity: "Очікується паритет",
    ready: "готово",
    queued: "у черзі",
  },
  it: {
    usageOverview: "PANORAMICA UTILIZZO",
    loginWaiting: "In attesa dell’accesso…",
    loginConnected: "T3 Chat connesso",
    loginStart: "Accedi a T3 Chat",
    logout: "Esci",
    loadingProviders: "Caricamento provider…",
    providerSummary: {
      one: "{count} provider su {total} nella prima fase.",
      other: "{count} provider su {total} nella prima fase.",
    },
    ported: "Portato",
    awaitingParity: "Parità in attesa",
    ready: "pronto",
    queued: "in coda",
  },
  nl: {
    usageOverview: "GEBRUIKSOVERZICHT",
    loginWaiting: "Wachten op inloggen…",
    loginConnected: "T3 Chat verbonden",
    loginStart: "Inloggen bij T3 Chat",
    logout: "Uitloggen",
    loadingProviders: "Providers laden…",
    providerSummary: {
      one: "{count} van {total} provider in de eerste fase.",
      other: "{count} van {total} providers in de eerste fase.",
    },
    ported: "Overgezet",
    awaitingParity: "Pariteit in afwachting",
    ready: "gereed",
    queued: "in wachtrij",
  },
  sv: {
    usageOverview: "ANVÄNDNINGSÖVERSIKT",
    loginWaiting: "Väntar på inloggning…",
    loginConnected: "T3 Chat ansluten",
    loginStart: "Logga in på T3 Chat",
    logout: "Logga ut",
    loadingProviders: "Läser in providers…",
    providerSummary: {
      one: "{count} av {total} provider i första delen.",
      other: "{count} av {total} providers i första delen.",
    },
    ported: "Porterad",
    awaitingParity: "Väntar på paritet",
    ready: "klar",
    queued: "i kö",
  },
  pl: {
    usageOverview: "PRZEGLĄD UŻYCIA",
    loginWaiting: "Oczekiwanie na logowanie…",
    loginConnected: "T3 Chat połączony",
    loginStart: "Zaloguj się do T3 Chat",
    logout: "Wyloguj",
    loadingProviders: "Ładowanie providerów…",
    providerSummary: {
      one: "{count} z {total} providera w pierwszym wycinku.",
      other: "{count} z {total} providerów w pierwszym wycinku.",
    },
    ported: "Przeniesiono",
    awaitingParity: "Oczekiwanie na zgodność",
    ready: "gotowe",
    queued: "w kolejce",
  },
  tr: {
    usageOverview: "KULLANIM ÖZETİ",
    loginWaiting: "Giriş bekleniyor…",
    loginConnected: "T3 Chat bağlandı",
    loginStart: "T3 Chat’e giriş yap",
    logout: "Çıkış yap",
    loadingProviders: "Sağlayıcılar yükleniyor…",
    providerSummary: {
      one: "İlk dilimde {total} sağlayıcıdan {count} tanesi.",
      other: "İlk dilimde {total} sağlayıcıdan {count} tanesi.",
    },
    ported: "Taşındı",
    awaitingParity: "Eşitlik bekleniyor",
    ready: "hazır",
    queued: "sırada",
  },
  id: {
    usageOverview: "RINGKASAN PENGGUNAAN",
    loginWaiting: "Menunggu login…",
    loginConnected: "T3 Chat terhubung",
    loginStart: "Masuk ke T3 Chat",
    logout: "Keluar",
    loadingProviders: "Memuat provider…",
    providerSummary: {
      one: "{count} dari {total} provider pada irisan pertama.",
      other: "{count} dari {total} provider pada irisan pertama.",
    },
    ported: "Dibor",
    awaitingParity: "Menunggu paritas",
    ready: "siap",
    queued: "dalam antrean",
  },
  vi: {
    usageOverview: "TỔNG QUAN SỬ DỤNG",
    loginWaiting: "Đang chờ đăng nhập…",
    loginConnected: "Đã kết nối T3 Chat",
    loginStart: "Đăng nhập T3 Chat",
    logout: "Đăng xuất",
    loadingProviders: "Đang tải provider…",
    providerSummary: {
      one: "{count}/{total} provider trong lát cắt đầu tiên.",
      other: "{count}/{total} provider trong lát cắt đầu tiên.",
    },
    ported: "Đã chuyển",
    awaitingParity: "Đang chờ tương đương",
    ready: "sẵn sàng",
    queued: "đang chờ",
  },
  ko: {
    usageOverview: "사용량 개요",
    loginWaiting: "로그인 대기 중…",
    loginConnected: "T3 Chat 연결됨",
    loginStart: "T3 Chat 로그인",
    logout: "로그아웃",
    loadingProviders: "프로바이더 로드 중…",
    providerSummary: {
      one: "첫 번째 단계에서 {total}개 중 {count}개 프로바이더.",
      other: "첫 번째 단계에서 {total}개 중 {count}개 프로바이더.",
    },
    ported: "포팅됨",
    awaitingParity: "패리티 대기 중",
    ready: "준비됨",
    queued: "대기열",
  },
  fa: {
    usageOverview: "نمای کلی استفاده",
    loginWaiting: "در انتظار ورود…",
    loginConnected: "T3 Chat متصل است",
    loginStart: "ورود به T3 Chat",
    logout: "خروج",
    loadingProviders: "در حال بارگذاری ارائه‌دهندگان…",
    providerSummary: {
      one: "{count} از {total} ارائه‌دهنده در برش نخست.",
      other: "{count} از {total} ارائه‌دهنده در برش نخست.",
    },
    ported: "منتقل‌شده",
    awaitingParity: "در انتظار برابری",
    ready: "آماده",
    queued: "در صف",
  },
  ar: {
    usageOverview: "نظرة عامة على الاستخدام",
    loginWaiting: "في انتظار تسجيل الدخول…",
    loginConnected: "تم الاتصال بـ T3 Chat",
    loginStart: "تسجيل الدخول إلى T3 Chat",
    logout: "تسجيل الخروج",
    loadingProviders: "جارٍ تحميل المزوّدين…",
    providerSummary: {
      one: "{count} من أصل {total} مزوّد في الشريحة الأولى.",
      other: "{count} من أصل {total} مزوّدين في الشريحة الأولى.",
    },
    ported: "منقول",
    awaitingParity: "في انتظار التكافؤ",
    ready: "جاهز",
    queued: "في قائمة الانتظار",
  },
  th: {
    usageOverview: "ภาพรวมการใช้งาน",
    loginWaiting: "กำลังรอการเข้าสู่ระบบ…",
    loginConnected: "เชื่อมต่อ T3 Chat แล้ว",
    loginStart: "เข้าสู่ระบบ T3 Chat",
    logout: "ออกจากระบบ",
    loadingProviders: "กำลังโหลดผู้ให้บริการ…",
    providerSummary: {
      one: "ผู้ให้บริการ {count} จาก {total} รายในชุดแรก",
      other: "ผู้ให้บริการ {count} จาก {total} รายในชุดแรก",
    },
    ported: "พอร์ตแล้ว",
    awaitingParity: "รอความเท่าเทียม",
    ready: "พร้อม",
    queued: "อยู่ในคิว",
  },
  ca: {
    usageOverview: "RESUM D’ÚS",
    loginWaiting: "Esperant l’inici de sessió…",
    loginConnected: "T3 Chat connectat",
    loginStart: "Inicia sessió a T3 Chat",
    logout: "Tanca la sessió",
    loadingProviders: "Carregant proveïdors…",
    providerSummary: {
      one: "{count} de {total} proveïdor al primer tall.",
      other: "{count} de {total} proveïdors al primer tall.",
    },
    ported: "Portat",
    awaitingParity: "Paritat pendent",
    ready: "preparat",
    queued: "a la cua",
  },
  gl: {
    usageOverview: "RESUMO DO USO",
    loginWaiting: "Agardando polo inicio de sesión…",
    loginConnected: "T3 Chat conectado",
    loginStart: "Iniciar sesión en T3 Chat",
    logout: "Pechar sesión",
    loadingProviders: "Cargando provedores…",
    providerSummary: {
      one: "{count} de {total} provedor no primeiro corte.",
      other: "{count} de {total} provedores no primeiro corte.",
    },
    ported: "Portado",
    awaitingParity: "Agardando paridade",
    ready: "listo",
    queued: "na cola",
  },
};

export interface Localization {
  readonly locale: LocaleId;
  readonly direction: TextDirection;
  readonly nativeName: string;
  readonly catalog: LocaleCatalog;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, number | string>>) => string;
  readonly upstream: (key: string, values?: Readonly<Record<string, number | string>>) => string;
  readonly providerSummary: (count: number, total: number) => string;
}

function languagePart(preference: string): string {
  return preference.trim().replace(/_/g, "-").toLowerCase();
}

function localeMatches(preference: string, locale: LocaleId): boolean {
  const requested = languagePart(preference);
  const candidate = languagePart(locale);
  if (requested === candidate || requested.startsWith(`${candidate}-`)) return true;
  // A bare language request (for example `pt`) may use its only supported
  // regional catalog, but a script/region request must never collapse into
  // the first catalog that happens to share its base language (`zh-Hant`
  // must not become `zh-Hans`).
  if (!requested.includes("-")) return candidate.split("-")[0] === requested;
  return !candidate.includes("-") && requested.split("-")[0] === candidate;
}

const inferredChineseLocale = (preference: string): LocaleId | undefined => {
  const normalized = languagePart(preference);
  if (!normalized.startsWith("zh-")) return undefined;
  if (/(?:^|-)hant(?:-|$)|-(?:tw|hk|mo)(?:-|$)/u.test(normalized)) return "zh-Hant";
  if (/(?:^|-)hans(?:-|$)|-(?:cn|sg)(?:-|$)/u.test(normalized)) return "zh-Hans";
  return undefined;
};

export function resolveLocale(
  preference: LocalePreference = "system",
  preferredLocales: readonly string[] = [],
): LocaleId {
  const candidates = preference === "system" ? preferredLocales : [preference];
  for (const candidate of candidates) {
    const exact = UPSTREAM_LOCALE_IDS.find(
      (locale) => languagePart(locale) === languagePart(candidate),
    );
    if (exact !== undefined) return exact;
    const inferredChinese = inferredChineseLocale(candidate);
    if (inferredChinese !== undefined) return inferredChinese;
    const base = UPSTREAM_LOCALE_IDS.find((locale) => localeMatches(candidate, locale));
    if (base !== undefined) return base;
  }
  return "en";
}

function mergeMessages(locale: LocaleId): MessageBundle {
  const override = MESSAGE_OVERRIDES[locale];
  if (override === undefined) return ENGLISH_MESSAGES;
  return {
    ...ENGLISH_MESSAGES,
    ...override,
    providerSummary: {
      ...ENGLISH_MESSAGES.providerSummary,
      ...override.providerSummary,
    },
  };
}

function interpolate(
  template: string,
  values: { readonly count: number; readonly total: number },
): string {
  return template
    .replaceAll("{count}", String(values.count))
    .replaceAll("{total}", String(values.total));
}

function selectPlural(
  locale: LocaleId,
  count: number,
  values: Readonly<Record<string, number | string>>,
): string {
  const category = new Intl.PluralRules(locale).select(count);
  return String(values[category] ?? values.other ?? values.one ?? "");
}

/** Resolve a key from the complete upstream catalog, including .stringsdict. */
export function translateUpstream(
  locale: LocaleId,
  key: string,
  values: Readonly<Record<string, number | string>> = {},
): string {
  const catalog = UPSTREAM_CATALOGS[locale];
  const plural =
    catalog.plurals[key] ?? (locale === "en" ? undefined : UPSTREAM_CATALOGS.en.plurals[key]);
  if (plural !== undefined) {
    let format = plural.format;
    for (const [name, variants] of Object.entries(plural.variables)) {
      const count = Number(values[name] ?? values.count ?? 0);
      const selected = selectPlural(locale, count, variants).replaceAll(
        /%[dif]/gu,
        String(values[name] ?? values.count ?? count),
      );
      format = format.replaceAll(`%#@${name}@`, selected);
    }
    let index = 0;
    return format.replaceAll(/%[@dif]/gu, (token) => {
      if (token === "%@" || token === "%d" || token === "%i" || token === "%f") {
        const value = Object.values(values)[index++];
        return value === undefined ? token : String(value);
      }
      return token;
    });
  }
  const message =
    catalog.messages[key] ?? (locale === "en" ? undefined : UPSTREAM_CATALOGS.en.messages[key]);
  if (message === undefined) return key;
  let index = 0;
  return message.replaceAll(/%[@difs]/gu, (token) => {
    const value = Object.values(values)[index++];
    return value === undefined ? token : String(value);
  });
}

export function createLocalization(
  preference: LocalePreference = "system",
  preferredLocales: readonly string[] = [],
): Localization {
  const locale = resolveLocale(preference, preferredLocales);
  const metadata = LOCALE_METADATA[locale];
  const messages = mergeMessages(locale);
  const pluralRules = new Intl.PluralRules(locale);
  const catalog = UPSTREAM_CATALOGS[locale];
  const upstream = (key: string, values: Readonly<Record<string, number | string>> = {}) =>
    translateUpstream(locale, key, values);
  return {
    locale,
    direction: metadata.direction,
    nativeName: metadata.nativeName,
    catalog,
    upstream,
    t: (key, values = {}) => {
      if (Object.hasOwn(messages, key)) return messages[key as keyof MessageBundle] as string;
      return upstream(key, values);
    },
    providerSummary: (count, total) => {
      const category = pluralRules.select(count) === "one" ? "one" : "other";
      return interpolate(messages.providerSummary[category], { count, total });
    },
  };
}
