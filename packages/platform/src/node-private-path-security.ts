import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, rm, writeFile } from "node:fs/promises";
import { win32 as windowsPath } from "node:path";
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
  /** Replaces the complete DACL with full control for that SID. */
  readonly replaceWithCurrentUserDacl: (path: string, sid: string) => Promise<void>;
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
    await acl.replaceWithCurrentUserDacl(path, await sid);
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
    await acl.replaceWithCurrentUserDacl(path, await sid);
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
  replaceWithCurrentUserDacl: async (path, sid) => {
    const name = windowsPath.basename(path);
    if (name.length === 0 || name === "." || name === ".." || /[\\/\u0000-\u001f]/u.test(name)) {
      throw new Error("Windows private path basename is invalid");
    }
    const parent = windowsPath.dirname(path);
    const restoreFile = windowsPath.join(parent, `.codexbar-multi-acl-${randomUUID()}.txt`);
    // icacls /restore uses a UTF-16LE ACL file with a path relative to the
    // supplied parent. `P` marks a protected DACL, replacing all inherited
    // and explicit ACEs rather than merely adding a current-user grant.
    const sddl = `${name}\r\nD:P(A;;FA;;;${sid})\r\n`;
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sddl, "utf16le")]);
    try {
      await writeFile(restoreFile, bytes, { flag: "wx", mode: 0o600 });
      await execFileAsync("icacls.exe", [parent, "/restore", restoreFile, "/c"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
    } finally {
      await rm(restoreFile, { force: true });
    }
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
