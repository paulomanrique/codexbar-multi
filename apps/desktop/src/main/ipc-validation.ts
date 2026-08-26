/** Reject unknown renderer fields before a schema can strip them. */
export const decodeExactDesktopRecord = async <T extends object>(
  input: unknown,
  keys: readonly string[],
  decode: (value: unknown) => Promise<T>,
): Promise<T> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Desktop request must be an object.");
  }
  const allowed = new Set(keys);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("Desktop request contains unsupported fields.");
  }
  return decode(input);
};
