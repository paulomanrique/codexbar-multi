/**
 * Keeps the live runtime projection fail-closed when config-first vault cleanup
 * fails after its deletion marker was committed. The raw reload cannot touch
 * the keyring, so it can still publish the staged metadata-only config.
 */
export const runTokenAccountRemovalMutation = async <Value, Config>(options: {
  readonly remove: () => Promise<Value>;
  readonly loadCommittedConfig: () => Promise<Config | undefined>;
  readonly loadRawConfig: () => Promise<Config | undefined>;
  readonly publishConfig: (config: Config | undefined) => void;
}): Promise<Value> => {
  try {
    const value = await options.remove();
    options.publishConfig(await options.loadCommittedConfig());
    return value;
  } catch (error) {
    // Drop the stale selected-account cache before any fallible recovery read.
    options.publishConfig(undefined);
    try {
      options.publishConfig(await options.loadRawConfig());
    } catch {
      // Undefined is the fail-closed runtime projection when raw config is unreadable.
    }
    throw error;
  }
};
