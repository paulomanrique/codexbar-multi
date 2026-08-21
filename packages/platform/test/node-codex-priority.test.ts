import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vite-plus/test";
import { makeNodeCodexPriorityTurnResolver, NodeCodexPriorityMetadataError } from "../src/node.ts";

const withTraceDatabase = async (
  action: (database: DatabaseSync, path: string) => Promise<void>,
): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "codexbar-priority-trace-"));
  const path = join(directory, "logs_2.sqlite");
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE logs (ts TEXT, feedback_log_body TEXT)");
  try {
    await action(database, path);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
};

const appendLog = (database: DatabaseSync, body: string): void => {
  database.prepare("INSERT INTO logs (ts, feedback_log_body) VALUES (?, ?)").run("0", body);
};

describe("Node Codex priority trace adapter (Swift parity)", () => {
  it("parses priority request metadata without retaining request bodies", async () => {
    await withTraceDatabase(async (database, path) => {
      appendLog(
        database,
        'INFO thread_id=thread turn.id=turn websocket request: {"type":"response.create","model":"gpt-5.6-terra","service_tier":"priority","instructions":"private"}',
      );
      appendLog(
        database,
        'INFO thread_id=other turn.id=ordinary websocket request: {"type":"response.create","model":"gpt-5.6-terra","service_tier":"default"}',
      );
      const resolveTurns = makeNodeCodexPriorityTurnResolver({ databasePath: path });
      await expect(resolveTurns()).resolves.toEqual({ turn: { model: "gpt-5.6-terra" } });
    });
  });

  it("upgrades a priority alias with the latest completed response and handles completion first", async () => {
    await withTraceDatabase(async (database, path) => {
      appendLog(
        database,
        'INFO thread_id=thread turn.id=late websocket event: {"type":"response.completed","response":{"model":"gpt-5.6-sol","output":"private"}}',
      );
      appendLog(
        database,
        'INFO thread_id=thread turn.id=late websocket request: {"type":"response.create","model":"request-alias","service_tier":"priority"}',
      );
      appendLog(
        database,
        'INFO thread_id=thread turn.id=late websocket event: {"type": "response.completed", "response": {"model": "gpt-5.6-terra"}}',
      );
      const resolveTurns = makeNodeCodexPriorityTurnResolver({ databasePath: path });
      await expect(resolveTurns()).resolves.toEqual({ late: { model: "gpt-5.6-terra" } });
    });
  });

  it("parses current priority submission syntax and incrementally adds appended trace rows", async () => {
    await withTraceDatabase(async (database, path) => {
      appendLog(
        database,
        'session_loop{thread_id=thread}: Submission sub=Submission { id: "first", op: UserInput { text: "private" }, thread_settings: ThreadSettingsOverrides { service_tier: Some(Some("priority")) }',
      );
      const resolveTurns = makeNodeCodexPriorityTurnResolver({ databasePath: path });
      await expect(resolveTurns()).resolves.toEqual({ first: {} });
      appendLog(
        database,
        'INFO turn_id=second websocket request: {"type":"response.create","model":"gpt-5.6-terra","service_tier":"priority"}',
      );
      await expect(resolveTurns()).resolves.toEqual({
        first: {},
        second: { model: "gpt-5.6-terra" },
      });
    });
  });

  it("rebuilds cache after trace pruning so deleted priority sources do not linger", async () => {
    await withTraceDatabase(async (database, path) => {
      appendLog(
        database,
        'INFO turn.id=removed websocket request: {"type":"response.create","service_tier":"priority"}',
      );
      appendLog(
        database,
        'INFO turn.id=retained websocket request: {"type":"response.create","service_tier":"priority"}',
      );
      const resolveTurns = makeNodeCodexPriorityTurnResolver({ databasePath: path });
      await expect(resolveTurns()).resolves.toEqual({ removed: {}, retained: {} });
      database.prepare("DELETE FROM logs WHERE rowid = 1").run();
      await expect(resolveTurns()).resolves.toEqual({ retained: {} });
    });
  });

  it("does not trust a rowid cursor when prune-plus-append restores the old row count", async () => {
    await withTraceDatabase(async (database, path) => {
      appendLog(
        database,
        'INFO turn.id=old websocket request: {"type":"response.create","service_tier":"priority"}',
      );
      appendLog(
        database,
        'INFO turn.id=stay websocket request: {"type":"response.create","service_tier":"priority"}',
      );
      const resolveTurns = makeNodeCodexPriorityTurnResolver({ databasePath: path });
      await expect(resolveTurns()).resolves.toEqual({ old: {}, stay: {} });
      database.prepare("DELETE FROM logs WHERE rowid = 1").run();
      appendLog(
        database,
        'INFO turn.id=new websocket request: {"type":"response.create","service_tier":"priority"}',
      );
      await expect(resolveTurns()).resolves.toEqual({ new: {}, stay: {} });
    });
  });

  it("fails closed on a bounded priority source instead of publishing a partial overlay", async () => {
    await withTraceDatabase(async (database, path) => {
      appendLog(
        database,
        'INFO turn.id=one websocket request: {"type":"response.create","service_tier":"priority"}',
      );
      appendLog(
        database,
        'INFO turn.id=two websocket request: {"type":"response.create","service_tier":"priority"}',
      );
      const resolveTurns = makeNodeCodexPriorityTurnResolver({
        databasePath: path,
        maximumRows: 1,
      });
      await expect(resolveTurns()).rejects.toBeInstanceOf(NodeCodexPriorityMetadataError);
    });
  });
});
