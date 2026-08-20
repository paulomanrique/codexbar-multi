import { execFile } from "node:child_process";
import { chmod } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_SID = /^S-\d+(?:-\d+)+$/iu;

/**
 * The small native boundary used to keep files owned by CodexBar Multi out of
 * other local Windows accounts. Node's `mode` option is ignored by NTFS, so
 * Windows must receive an explicit DACL rather than a best-effort chmod.
 */
export interface WindowsAclAdapter {
  /** Returns the SID for the account running this process, never a user name. */
  readonly currentUserSid: () => Promise<string>;
  /** Replaces inherited access with full control for that SID. */
  readonly grantCurrentUserFullControl: (path: string, sid: string) => Promise<void>;
}

export interface NodePrivatePathRestrictionOptions {
  /** Injectable for tests; production defaults to the running Node platform. */
  readonly platform?: NodeJS.Platform;
  readonly windowsAcl?: WindowsAclAdapter;
}

/**
 * Returns a fail-closed restriction operation for one private filesystem
 * object. POSIX gets an owner-only mode; Windows receives a DACL with only
 * the current account explicitly granted access. No command shell is used.
 */
export const makeNodePrivateFileRestriction = (
  options: NodePrivatePathRestrictionOptions = {},
): ((path: string) => Promise<void>) => {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return (path) => chmod(path, 0o600);

  const acl = options.windowsAcl ?? nativeWindowsAcl;
  let sid: Promise<string> | undefined;
  return async (path) => {
    sid ??= acl.currentUserSid().then(validateWindowsSid);
    await acl.grantCurrentUserFullControl(path, await sid);
  };
};

/** Same DACL policy as files, with a POSIX owner-only directory mode. */
export const makeNodePrivateDirectoryRestriction = (
  options: NodePrivatePathRestrictionOptions = {},
): ((path: string) => Promise<void>) => {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return (path) => chmod(path, 0o700);

  const acl = options.windowsAcl ?? nativeWindowsAcl;
  let sid: Promise<string> | undefined;
  return async (path) => {
    sid ??= acl.currentUserSid().then(validateWindowsSid);
    await acl.grantCurrentUserFullControl(path, await sid);
  };
};

const nativeWindowsAcl: WindowsAclAdapter = {
  currentUserSid: async () => {
    // `whoami` is a Windows system executable. execFile never invokes a shell,
    // and its CSV output contains only the local account/SID mapping.
    const { stdout } = await execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    const sid = lastCsvField(stdout.trim());
    return validateWindowsSid(sid);
  },
  grantCurrentUserFullControl: async (path, sid) => {
    // The leading `*` tells icacls this is a SID, avoiding localization and
    // account-name resolution. Output is discarded so paths never leak via
    // logs, and a non-zero exit makes the private write fail closed.
    await execFileAsync("icacls.exe", [path, "/inheritance:r", "/grant:r", `*${sid}:(F)`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  },
};

const validateWindowsSid = (value: string): string => {
  if (!WINDOWS_SID.test(value)) throw new Error("Windows current-user SID is invalid");
  return value;
};

/** The `whoami /fo csv /nh` SID is the final RFC-4180 field. */
const lastCsvField = (line: string): string => {
  const fields = [...line.matchAll(/(?:^|,)"((?:[^"]|"")*)"/gu)].map((match) =>
    match[1]!.replaceAll('""', '"'),
  );
  const sid = fields.at(-1);
  if (sid === undefined) throw new Error("Windows current-user SID was not returned");
  return sid;
};
