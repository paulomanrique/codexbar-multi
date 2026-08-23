import { spawn } from "node-pty";
import {
  makeNodePtyRunner,
  type NodePtyHandle,
  type NodePtyRunnerOptions,
} from "@codexbar/platform/node-pty";

const spawnDesktopPty: NodePtyRunnerOptions["spawnImpl"] = (command, args, options) =>
  spawn(command, [...args], options) as NodePtyHandle;

/** Electron-main-only native PTY composition. CLI/SEA never import this module. */
export const makeDesktopNodePtyRunner = () => makeNodePtyRunner({ spawnImpl: spawnDesktopPty });
