import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  classifyAgentProcesses,
  makeNodeAgentSessionFiles,
  parsePiFamilySession,
  scanNodeAgentSessions,
  type NodeAgentSessionFiles,
} from "../src/node-agent-sessions.ts";

const now = Date.parse("2026-08-20T12:00:00.000Z");
const home = "/fixture/home";
const project = "/fixture/project";
const piRoot = `${home}/.pi/agent/sessions`;
const piProject = `${piRoot}/--fixture-project--`;
const piFile = `${piProject}/session.jsonl`;

const files: NodeAgentSessionFiles = {
  canonical: async (path) => path,
  list: async (path) => {
    if (path === piRoot) return [{ path: piProject, type: "directory" }];
    if (path === piProject) return [{ path: piFile, type: "file", modifiedAt: now - 5_000 }];
    return [];
  },
  readPrefix: async (path) =>
    path === piFile
      ? [
          '{"type":"session","version":3,"id":"pi-fixture","timestamp":"2026-08-20T11:50:00Z","cwd":"/fixture/project"}',
          '{"type":"message","text":"not returned"}',
          "",
        ].join("\n")
      : undefined,
  readTail: async (path) =>
    path === piFile
      ? '{"type":"session_info","name":"Fixture\\n session\\u0000 title"}\n'
      : undefined,
};

describe("Node agent session scanner", () => {
  it("keeps conservative Codex/Claude/Pi process classification", () => {
    expect(
      classifyAgentProcesses([
        { pid: 1, ppid: 0, command: "codex exec", startedAt: 1 },
        { pid: 2, ppid: 0, command: "codex app-server", startedAt: 2 },
        { pid: 3, ppid: 0, command: "claude --help", startedAt: 3 },
        { pid: 4, ppid: 0, command: "bun /tools/oh-my-pi/omp", startedAt: 4 },
        { pid: 5, ppid: 0, command: "omp --version", startedAt: 5 },
      ]).map(({ process, provider, dialect }) => [process.pid, provider, dialect]),
    ).toEqual([
      [4, "pi", "omp"],
      [1, "codex", undefined],
    ]);
  });

  it("recognizes quoted Windows executable paths and .exe agent names", () => {
    expect(
      classifyAgentProcesses([
        {
          pid: 21,
          ppid: 0,
          command: '"C:\\Program Files\\OpenAI\\codex.exe" exec',
          startedAt: 1,
        },
        {
          pid: 22,
          ppid: 0,
          command: '"C:\\Users\\fixture\\Claude Code\\claude.exe" --resume',
          startedAt: 2,
        },
        {
          pid: 23,
          ppid: 0,
          command: '"C:\\Tools\\pi.exe"',
          startedAt: 3,
        },
      ]).map(({ process, provider, dialect }) => [process.pid, provider, dialect]),
    ).toEqual([
      [23, "pi", "pi"],
      [22, "claude", undefined],
      [21, "codex", undefined],
    ]);
  });

  it("parses bounded Pi metadata and redacts control characters from titles", () => {
    const record = parsePiFamilySession(
      '{"type":"session","version":3,"id":"pi-safe","timestamp":"2026-08-20T11:50:00Z","cwd":"/fixture/project"}\n',
      '{"type":"session_info","name":"hello\\nworld\\u0000"}\n',
      "pi",
      "/fixture/session.jsonl",
      now + 1_000,
      now,
    );
    expect(record).toMatchObject({
      id: "pi-safe",
      cwd: project,
      sessionName: "helloworld",
      modifiedAt: now,
    });
  });

  it("correlates only a live Pi process to a bounded fixture record", async () => {
    const sessions = await scanNodeAgentSessions(
      {
        processes: async () => [
          { pid: 11, ppid: 1, command: "pi", startedAt: now - 60_000 },
          { pid: 12, ppid: 1, command: "claude", startedAt: now - 30_000 },
        ],
        cwdByPID: async () =>
          new Map([
            [11, project],
            [12, project],
          ]),
        files,
        environment: { HOME: home },
        now: () => now,
      },
      new AbortController().signal,
    );
    const pi = sessions.find((session) => session.provider === "pi");
    expect(pi).toMatchObject({
      id: "pi-fixture",
      state: "active",
      dialect: "pi",
      source: "cli",
      projectName: "project",
      sessionName: "Fixture session title",
      transcriptPath: piFile,
      host: "local",
    });
    expect(sessions.find((session) => session.provider === "claude")).toMatchObject({
      id: "pid:12",
      source: "cli",
      host: "local",
    });
  });

  it("honors cancellation before process or filesystem discovery", async () => {
    const controller = new AbortController();
    controller.abort(new Error("fixture cancellation"));
    let processCalls = 0;
    await expect(
      scanNodeAgentSessions(
        {
          processes: async () => {
            processCalls += 1;
            return [];
          },
          cwdByPID: async () => new Map(),
          files,
        },
        controller.signal,
      ),
    ).rejects.toThrow("fixture cancellation");
    expect(processCalls).toBe(0);
  });

  it("refuses a symlinked transcript before reading any bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexbar-sessions-"));
    const outside = join(root, "outside.jsonl");
    const link = join(root, "linked.jsonl");
    try {
      await writeFile(outside, '{"type":"session","version":3,"id":"outside"}\n');
      await symlink(outside, link);
      const result = await makeNodeAgentSessionFiles().readPrefix(
        link,
        16 * 1024,
        new AbortController().signal,
      );
      expect(result).toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects unsafe public metadata read limits before allocating a buffer", async () => {
    await expect(
      makeNodeAgentSessionFiles().readPrefix(
        "/does/not/matter",
        64 * 1024 + 1,
        new AbortController().signal,
      ),
    ).rejects.toThrow(RangeError);
  });
});
