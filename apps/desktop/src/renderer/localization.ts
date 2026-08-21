/**
 * Renderer compatibility entrypoint for the desktop-shared localization
 * catalog. Native main-process delivery imports the same pure module directly
 * and never depends on renderer/React code.
 */
export * from "../localization/catalog.js";
