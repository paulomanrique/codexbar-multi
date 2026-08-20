import { createRequire } from "node:module";

interface NativeKeyringBinding {
  readonly AsyncEntry: unknown;
  readonly Entry: unknown;
  readonly findCredentials: unknown;
  readonly findCredentialsAsync: unknown;
}

interface NativeKeyringEntry {
  readonly getPassword: () => string | null;
  readonly setPassword: (value: string) => void;
  readonly deletePassword: () => unknown;
}

const nativeAddonPath = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
if (nativeAddonPath === undefined || nativeAddonPath.length === 0)
  throw new Error(
    "The standalone CLI keyring addon was not prepared. Run the packaged executable, not its SEA bundle.",
  );

const requireNative = createRequire(__filename);
const nativeBinding = requireNative(nativeAddonPath) as NativeKeyringBinding;

export const AsyncEntry = nativeBinding.AsyncEntry;
export const Entry = nativeBinding.Entry as new (
  service: string,
  key: string,
) => NativeKeyringEntry;
export const findCredentials = nativeBinding.findCredentials;
export const findCredentialsAsync = nativeBinding.findCredentialsAsync;
