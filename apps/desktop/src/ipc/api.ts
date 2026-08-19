import type { DashboardSnapshotDTO, LoginRequestDTO, LoginResultDTO } from "@codexbar/contracts";

export const DesktopChannels = Object.freeze({
  overview: "codexbar-multi:overview",
  startLogin: "codexbar-multi:start-login",
  cancelLogin: "codexbar-multi:cancel-login",
  logout: "codexbar-multi:logout",
});

export interface CodexBarDesktopApi {
  readonly getOverview: () => Promise<DashboardSnapshotDTO>;
  readonly startLogin: (request: LoginRequestDTO) => Promise<LoginResultDTO>;
  readonly cancelLogin: (request: LoginRequestDTO) => Promise<void>;
  readonly logout: (request: LoginRequestDTO) => Promise<void>;
}
